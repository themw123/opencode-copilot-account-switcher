import type { NetworkRetryRequest } from "../network-retry-engine.js"

const AI_ERROR_MARKER = Symbol.for("vercel.ai.error")
const API_CALL_ERROR_MARKER = Symbol.for("vercel.ai.error.AI_APICallError")

export type RetryableApiCallError = Error & {
  url: string
  requestBodyValues: unknown
  statusCode?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  isRetryable: boolean
  cause: unknown
  [key: symbol]: unknown
}

export function toRequestUrl(request: Request | URL | string) {
  return request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)
}

export function getErrorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).toLowerCase()
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

export function createMessageRetryClassifier(options: {
  retryableMessages: string[]
  isAbortError?: (error: unknown) => boolean
}) {
  return function isRetryableByMessage(error: unknown) {
    if (!error) return false
    if (options.isAbortError?.(error) ?? isAbortError(error)) return false
    const message = getErrorMessage(error)
    return options.retryableMessages.some((part) => message.includes(part))
  }
}

function buildRetryableApiCallMessage(providerLabel: string, group: string, detail: string) {
  return `${providerLabel} retryable error [${group}]: ${detail}`
}

export function toRetryableApiCallError(
  error: unknown,
  request: { url: string; body?: string },
  options: {
    providerLabel: string
    group: string
    requestBodyValues?: unknown
    statusCode?: number
    responseHeaders?: Headers | Record<string, string>
    responseBody?: string
  },
) {
  const base = error instanceof Error ? error : new Error(String(error))
  const wrapped = new Error(buildRetryableApiCallMessage(options.providerLabel, options.group, base.message)) as RetryableApiCallError
  wrapped.name = "AI_APICallError"
  wrapped.url = request.url
  wrapped.requestBodyValues = options.requestBodyValues ?? (() => {
    if (!request.body) return {}
    try {
      return JSON.parse(request.body)
    } catch {
      return {}
    }
  })()
  wrapped.statusCode = options.statusCode
  wrapped.responseHeaders = options.responseHeaders instanceof Headers
    ? Object.fromEntries(options.responseHeaders.entries())
    : options.responseHeaders
  wrapped.responseBody = options.responseBody
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

export async function normalizeRetryableStatusResponse(input: {
  response: Response
  request: NetworkRetryRequest
  providerLabel: string
  group: string
  isRetryableStatus: (status: number) => boolean
}) {
  if (!input.isRetryableStatus(input.response.status)) return input.response

  const responseBody = await input.response.clone().text().catch(() => "")
  throw toRetryableApiCallError(new Error(responseBody || `status code ${input.response.status}`), input.request, {
    providerLabel: input.providerLabel,
    group: input.group,
    statusCode: input.response.status,
    responseHeaders: input.response.headers,
    responseBody: responseBody || undefined,
  })
}
