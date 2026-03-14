const RETRYABLE_MESSAGES = [
  "load failed",
  "failed to fetch",
  "network request failed",
  "sse read timed out",
  "unable to connect",
  "econnreset",
  "etimedout",
  "socket hang up",
  "unknown certificate",
  "self signed certificate",
  "unable to verify the first certificate",
  "self-signed certificate in certificate chain",
]

type FetchLike = (request: Request | URL | string, init?: RequestInit) => Promise<Response>

type RetryableSystemError = Error & {
  code: string
  syscall: string
  cause: unknown
}

type JsonRecord = Record<string, unknown>

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function getErrorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).toLowerCase()
}

function isJsonContentType(headers: Headers) {
  return headers.get("content-type")?.toLowerCase().includes("application/json") === true
}

function isInputIdTooLongErrorBody(payload: unknown) {
  if (!payload || typeof payload !== "object") return false
  const error = (payload as { error?: { message?: unknown } }).error
  const message = String(error?.message ?? "").toLowerCase()
  return message.includes("invalid 'input[") && message.includes(".id'") && message.includes("string too long")
}

function hasLongInputIds(payload: JsonRecord) {
  const input = payload.input
  if (!Array.isArray(input)) return false
  return input.some((item) => typeof (item as { id?: unknown })?.id === "string" && ((item as { id?: string }).id?.length ?? 0) > 64)
}

function stripLongInputIds(payload: JsonRecord) {
  const input = payload.input
  if (!Array.isArray(input)) return payload

  let changed = false
  const nextInput = input.map((item) => {
    if (!item || typeof item !== "object") return item
    const id = (item as { id?: unknown }).id
    if (typeof id === "string" && id.length > 64) {
      changed = true
      const clone = { ...(item as JsonRecord) }
      delete (clone as { id?: unknown }).id
      return clone
    }
    return item
  })

  if (!changed) return payload
  return {
    ...payload,
    input: nextInput,
  }
}

function parseJsonBody(init?: RequestInit) {
  if (typeof init?.body !== "string") return undefined
  try {
    const parsed = JSON.parse(init.body)
    if (!parsed || typeof parsed !== "object") return undefined
    return parsed as JsonRecord
  } catch {
    return undefined
  }
}

function buildRetryInit(init: RequestInit | undefined, payload: JsonRecord): RequestInit {
  const headers = new Headers(init?.headers)
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return {
    ...init,
    headers,
    body: JSON.stringify(payload),
  }
}

async function maybeRetryInputIdTooLong(
  request: Request | URL | string,
  init: RequestInit | undefined,
  response: Response,
  baseFetch: FetchLike,
) {
  if (response.status !== 400) return response

  const requestPayload = parseJsonBody(init)
  if (!requestPayload || !hasLongInputIds(requestPayload)) return response

  if (!isJsonContentType(response.headers)) return response

  const bodyPayload = await response
    .clone()
    .json()
    .catch(() => undefined)

  if (!isInputIdTooLongErrorBody(bodyPayload)) return response

  const sanitized = stripLongInputIds(requestPayload)
  if (sanitized === requestPayload) return response

  return baseFetch(request, buildRetryInit(init, sanitized))
}

function toRetryableSystemError(error: unknown): RetryableSystemError {
  const base = error instanceof Error ? error : new Error(String(error))
  const wrapped = new Error(`[copilot-network-retry normalized] ${base.message}`) as RetryableSystemError
  wrapped.name = base.name
  wrapped.code = "ECONNRESET"
  wrapped.syscall = "fetch"
  wrapped.cause = error
  return wrapped
}

function isCopilotUrl(request: Request | URL | string) {
  const raw = request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)

  try {
    const url = new URL(raw)
    const isCopilotHost =
      url.hostname === "api.githubcopilot.com" || url.hostname.startsWith("copilot-api.")
    return isCopilotHost
  } catch {
    return false
  }
}

export function isRetryableCopilotFetchError(error: unknown) {
  if (!error || isAbortError(error)) return false
  const message = getErrorMessage(error)
  return RETRYABLE_MESSAGES.some((part) => message.includes(part))
}

export function createCopilotRetryingFetch(
  baseFetch: FetchLike,
  options?: {
    wait?: (ms: number) => Promise<void>
  },
) {
  void options

  return async function retryingFetch(request: Request | URL | string, init?: RequestInit) {
    try {
      const response = await baseFetch(request, init)
      if (isCopilotUrl(request)) {
        return maybeRetryInputIdTooLong(request, init, response, baseFetch)
      }
      return response
    } catch (error) {
      if (!isCopilotUrl(request) || !isRetryableCopilotFetchError(error)) {
        throw error
      }

      throw toRetryableSystemError(error)
    }
  }
}
