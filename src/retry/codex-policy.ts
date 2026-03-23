import type { NetworkRetryPolicy, NetworkRetryRequest } from "../network-retry-engine.js"
import {
  createMessageRetryClassifier,
  isAbortError,
  isRetryableApiCallError,
  normalizeRetryableStatusResponse,
  toRequestUrl,
  toRetryableApiCallError,
} from "./common-policy.js"

export const CODEX_RETRYABLE_MESSAGES = [
  "load failed",
  "failed to fetch",
  "network request failed",
  "unable to connect",
  "connection reset",
  "connection aborted",
  "econnreset",
  "etimedout",
  "timeout",
  "socket hang up",
]

export type CodexRetryableErrorGroup = "transport" | "status"

function isCodexUrl(request: Request | URL | string) {
  const raw = toRequestUrl(request)
  try {
    const url = new URL(raw)
    return url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex/")
  } catch {
    return false
  }
}

const isRetryableCodexTransportErrorByMessage = createMessageRetryClassifier({
  retryableMessages: CODEX_RETRYABLE_MESSAGES,
  isAbortError,
})

export function isRetryableCodexTransportError(error: unknown) {
  return isRetryableCodexTransportErrorByMessage(error)
}

function isRetryableCodexStatus(status: number) {
  if (status === 429) return true
  return status >= 500 && status <= 599
}

function normalizeRetryableStatusResponseForCodex(response: Response, request: NetworkRetryRequest) {
  return normalizeRetryableStatusResponse({
    response,
    request,
    providerLabel: "Codex",
    group: "status",
    isRetryableStatus: isRetryableCodexStatus,
  })
}

function toCodexRetryableApiCallError(
  error: unknown,
  request: { url: string; body?: string },
  options?: {
    group?: CodexRetryableErrorGroup
    statusCode?: number
    responseHeaders?: Headers | Record<string, string>
    responseBody?: string
  },
) {
  return toRetryableApiCallError(error, request, {
    providerLabel: "Codex",
    group: options?.group ?? "transport",
    statusCode: options?.statusCode,
    responseHeaders: options?.responseHeaders,
    responseBody: options?.responseBody,
  })
}

export function createCodexRetryPolicy(): NetworkRetryPolicy {
  return {
    matchesRequest: (request) => isCodexUrl(request),
    classifyFailure: async ({ error }) => {
      if (isRetryableApiCallError(error)) {
        return { retryable: false, category: "already-normalized" }
      }
      if (isRetryableCodexTransportError(error)) {
        return { retryable: true, category: "transport" }
      }
      return { retryable: false, category: "none" }
    },
    handleResponse: async ({ response, request }) => normalizeRetryableStatusResponseForCodex(response, request),
    normalizeFailure: ({ error, classification, request }) => {
      if (classification.retryable && classification.category === "transport") {
        return toCodexRetryableApiCallError(error, request)
      }
      return error
    },
    buildRepairPlan: async () => undefined,
  }
}
