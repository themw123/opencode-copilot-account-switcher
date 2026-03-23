import type { NetworkRetryPolicy, NetworkRetryRequest } from "../network-retry-engine.js"
import {
  createMessageRetryClassifier,
  getErrorMessage,
  isAbortError,
  isRetryableApiCallError as isRetryableApiCallErrorByMarker,
  normalizeRetryableStatusResponse,
  toRequestUrl,
  toRetryableApiCallError as toRetryableApiCallErrorByCommon,
  type RetryableApiCallError,
} from "./common-policy.js"

export const COPILOT_RETRYABLE_MESSAGES = [
  "load failed",
  "failed to fetch",
  "network request failed",
  "unable to connect",
  "econnreset",
  "etimedout",
  "socket hang up",
  "unknown certificate",
  "self signed certificate",
  "unable to verify the first certificate",
  "self-signed certificate in certificate chain",
]

export type RetryableErrorGroup = "transport" | "status" | "stream"

type CopilotStreamErrorInput = {
  error: unknown
  request: Request | URL | string
  statusCode?: number
  responseHeaders?: Headers
}

type JsonRecord = Record<string, unknown>

export type CopilotRepairDecision =
  | { kind: "skip" }
  | {
      kind: "connection-mismatch"
      responseText: string
      shouldAttemptSessionRepair: boolean
    }
  | {
      kind: "input-id-too-long"
      responseText: string
      serverReportedIndex?: number
      reportedLength?: number
      shouldAttemptSessionRepair: boolean
    }

export type CopilotRetryPolicy = NetworkRetryPolicy & {
  shouldRunResponseRepair: (request: Request | URL | string) => boolean
  decideResponseRepair: (input: {
    request: Request | URL | string
    response: Response
    requestPayload: JsonRecord | undefined
    sessionID?: string
  }) => Promise<CopilotRepairDecision>
  normalizeStreamError: (input: CopilotStreamErrorInput) => unknown
}

type CreateCopilotRetryPolicyOptions = {
  extraRetryableClassifier?: (error: unknown) => boolean
}

function isSseReadTimeoutError(error: unknown) {
  return getErrorMessage(error).includes("sse read timed out")
}

function isCopilotResponsesPath(request: Request | URL | string) {
  const raw = toRequestUrl(request)
  try {
    const url = new URL(raw)
    return url.pathname === "/responses"
  } catch {
    return false
  }
}

function hasLongInputIds(payload: JsonRecord | undefined) {
  const input = payload?.input
  if (!Array.isArray(input)) return false
  return input.some((item) => {
    const id = (item as { id?: unknown } | undefined)?.id
    return typeof id === "string" && id.length > 64
  })
}

function collectInputItemIds(payload: JsonRecord | undefined) {
  const input = payload?.input
  if (!Array.isArray(input)) return []
  return [...new Set(input.flatMap((item) => {
    const id = (item as { id?: unknown } | undefined)?.id
    return typeof id === "string" && id.length > 0 ? [id] : []
  }))]
}

function isInputIdTooLongMessage(text: string) {
  const message = text.toLowerCase()
  return message.includes("string too long") && (message.includes("input id") || message.includes(".id'"))
}

function isConnectionMismatchInputIdMessage(text: string) {
  const message = text.toLowerCase()
  return message.includes("does not belong to this connection") && /item(?:\s+with)?\s+id/.test(message)
}

function isInputIdTooLongErrorBody(payload: unknown) {
  if (!payload || typeof payload !== "object") return false
  const error = (payload as { error?: { message?: unknown } }).error
  const message = String(error?.message ?? "").toLowerCase()
  return message.includes("string too long") && (message.includes("input id") || message.includes(".id'"))
}

function isConnectionMismatchInputIdErrorBody(payload: unknown) {
  if (!payload || typeof payload !== "object") return false
  const error = (payload as { error?: { message?: unknown } }).error
  return isConnectionMismatchInputIdMessage(String(error?.message ?? ""))
}

function parseInputIdTooLongDetails(text: string) {
  const matched = isInputIdTooLongMessage(text)
  if (!matched) return { matched }
  const index = text.match(/input\[(\d+)\]\.id/i)
  const length = text.match(/got a string with length\s+(\d+)/i) ?? text.match(/length\s+(\d+)/i)
  return {
    matched,
    serverReportedIndex: index ? Number(index[1]) : undefined,
    reportedLength: length ? Number(length[1]) : undefined,
  }
}

export function isCopilotUrl(request: Request | URL | string) {
  const raw = toRequestUrl(request)
  try {
    const url = new URL(raw)
    return url.hostname === "api.githubcopilot.com" || url.hostname.startsWith("copilot-api.")
  } catch {
    return false
  }
}

const isRetryableCopilotTransportErrorByMessage = createMessageRetryClassifier({
  retryableMessages: COPILOT_RETRYABLE_MESSAGES,
  isAbortError,
})

export function isRetryableCopilotTransportError(error: unknown) {
  return isRetryableCopilotTransportErrorByMessage(error)
}

export function toRetryableApiCallError(
  error: unknown,
  request: { url: string; body?: string },
  options?: {
    group?: RetryableErrorGroup
    requestBodyValues?: unknown
    statusCode?: number
    responseHeaders?: Headers | Record<string, string>
    responseBody?: string
  },
) {
  return toRetryableApiCallErrorByCommon(error, request, {
    providerLabel: "Copilot",
    group: options?.group ?? "transport",
    requestBodyValues: options?.requestBodyValues,
    statusCode: options?.statusCode,
    responseHeaders: options?.responseHeaders,
    responseBody: options?.responseBody,
  })
}

export function isRetryableApiCallError(error: unknown): error is RetryableApiCallError {
  return isRetryableApiCallErrorByMarker(error)
}

function normalizeRetryableStatusResponseForCopilot(response: Response, request: NetworkRetryRequest) {
  return normalizeRetryableStatusResponse({
    response,
    request,
    providerLabel: "Copilot",
    group: "status",
    isRetryableStatus: (status) => status === 499,
  })
}

export function createCopilotRetryPolicy(options?: CreateCopilotRetryPolicyOptions): CopilotRetryPolicy {
  const policy: CopilotRetryPolicy = {
    matchesRequest: (request) => isCopilotUrl(request),
    classifyFailure: async ({ error }) => {
      if (isRetryableApiCallError(error)) {
        return { retryable: false, category: "already-normalized" }
      }
      if (isRetryableCopilotTransportError(error) || options?.extraRetryableClassifier?.(error) === true) {
        return { retryable: true, category: "transport" }
      }
      return { retryable: false, category: "none" }
    },
    handleResponse: async ({ response, request }) => normalizeRetryableStatusResponseForCopilot(response, request),
    normalizeFailure: ({ error, classification, request }) => {
      if (classification.retryable && classification.category === "transport") {
        return toRetryableApiCallError(error, request)
      }
      return error
    },
    buildRepairPlan: async () => undefined,
    shouldRunResponseRepair: (request) => isCopilotUrl(request) && isCopilotResponsesPath(request),
    decideResponseRepair: async ({ request, response, requestPayload, sessionID }) => {
      if (!isCopilotUrl(request) || !isCopilotResponsesPath(request)) {
        return { kind: "skip" }
      }
      if (response.ok) return { kind: "skip" }

      const responseText = await response.clone().text().catch(() => "")
      if (!responseText) return { kind: "skip" }

      const removableIds = collectInputItemIds(requestPayload)
      let isConnectionMismatch = isConnectionMismatchInputIdMessage(responseText)
      if (!isConnectionMismatch) {
        try {
          const bodyPayload = JSON.parse(responseText)
          isConnectionMismatch = isConnectionMismatchInputIdErrorBody(bodyPayload)
        } catch {
          isConnectionMismatch = false
        }
      }
      if (isConnectionMismatch && removableIds.length > 0) {
        return {
          kind: "connection-mismatch",
          responseText,
          shouldAttemptSessionRepair: Boolean(sessionID) && removableIds.length > 0,
        }
      }

      if (!hasLongInputIds(requestPayload)) return { kind: "skip" }

      let parsed = parseInputIdTooLongDetails(responseText)
      let matched = parsed.matched
      if (!matched) {
        try {
          const bodyPayload = JSON.parse(responseText)
          const error = (bodyPayload as { error?: { message?: unknown } }).error
          parsed = parseInputIdTooLongDetails(String(error?.message ?? ""))
          matched = parsed.matched || isInputIdTooLongErrorBody(bodyPayload)
        } catch {
          matched = false
        }
      }
      if (!matched) return { kind: "skip" }

      return {
        kind: "input-id-too-long",
        responseText,
        serverReportedIndex: parsed.serverReportedIndex,
        reportedLength: parsed.reportedLength,
        shouldAttemptSessionRepair: Boolean(sessionID) && hasLongInputIds(requestPayload),
      }
    },
    normalizeStreamError: ({ error, request, statusCode, responseHeaders }) => {
      if (isSseReadTimeoutError(error)) return error
      if (!isRetryableCopilotTransportError(error)) return error
      return toRetryableApiCallError(error, {
        url: toRequestUrl(request),
      }, {
        group: "stream",
        statusCode,
        responseHeaders,
      })
    },
  }

  return policy
}
