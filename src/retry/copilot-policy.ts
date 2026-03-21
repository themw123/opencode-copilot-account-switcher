import type { NetworkRetryPolicy, NetworkRetryRequest } from "../network-retry-engine.js"

const AI_ERROR_MARKER = Symbol.for("vercel.ai.error")
const API_CALL_ERROR_MARKER = Symbol.for("vercel.ai.error.AI_APICallError")

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

type RetryableApiCallError = Error & {
  url: string
  requestBodyValues: unknown
  statusCode?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  isRetryable: boolean
  cause: unknown
  [key: symbol]: unknown
}

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

function toRequestUrl(request: Request | URL | string) {
  return request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)
}

function getErrorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).toLowerCase()
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
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

export function isRetryableCopilotTransportError(error: unknown) {
  if (!error || isAbortError(error)) return false
  const message = getErrorMessage(error)
  return COPILOT_RETRYABLE_MESSAGES.some((part) => message.includes(part))
}

function buildRetryableApiCallMessage(group: RetryableErrorGroup, detail: string) {
  return `Copilot retryable error [${group}]: ${detail}`
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
  const base = error instanceof Error ? error : new Error(String(error))
  const wrapped = new Error(buildRetryableApiCallMessage(options?.group ?? "transport", base.message)) as RetryableApiCallError
  wrapped.name = "AI_APICallError"
  wrapped.url = request.url
  wrapped.requestBodyValues = options?.requestBodyValues ?? (() => {
    if (!request.body) return {}
    try {
      return JSON.parse(request.body)
    } catch {
      return {}
    }
  })()
  wrapped.statusCode = options?.statusCode
  wrapped.responseHeaders = options?.responseHeaders instanceof Headers
    ? Object.fromEntries(options.responseHeaders.entries())
    : options?.responseHeaders
  wrapped.responseBody = options?.responseBody
  wrapped.isRetryable = true
  wrapped.cause = error
  wrapped[AI_ERROR_MARKER] = true
  wrapped[API_CALL_ERROR_MARKER] = true
  return wrapped
}

export function isRetryableApiCallError(error: unknown): error is RetryableApiCallError {
  return Boolean(
    error
      && typeof error === "object"
      && (error as RetryableApiCallError)[AI_ERROR_MARKER] === true
      && (error as RetryableApiCallError)[API_CALL_ERROR_MARKER] === true,
  )
}

function normalizeRetryableStatusResponse(response: Response, request: NetworkRetryRequest) {
  if (response.status !== 499) return response
  return response.clone().text().catch(() => "").then((responseBody) => {
    throw toRetryableApiCallError(new Error(responseBody || `status code ${response.status}`), request, {
      group: "status",
      statusCode: response.status,
      responseHeaders: response.headers,
      responseBody: responseBody || undefined,
    })
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
    handleResponse: async ({ response, request }) => normalizeRetryableStatusResponse(response, request),
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
