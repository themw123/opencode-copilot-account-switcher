const RETRYABLE_MESSAGES = [
  "load failed",
  "failed to fetch",
  "network request failed",
  "econnreset",
  "etimedout",
  "socket hang up",
  "unknown certificate",
  "self signed certificate",
  "unable to verify the first certificate",
  "self-signed certificate in certificate chain",
]

const RETRYABLE_PATH_SEGMENTS = ["/chat/completions", "/responses", "/models", "/token"]

type FetchLike = (request: Request | URL | string, init?: RequestInit) => Promise<Response>

type RetryableSystemError = Error & {
  code: string
  syscall: string
  cause: unknown
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function getErrorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).toLowerCase()
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
    if (!isCopilotHost) return false
    return RETRYABLE_PATH_SEGMENTS.some((segment) => url.pathname.includes(segment))
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
      return await baseFetch(request, init)
    } catch (error) {
      if (!isCopilotUrl(request) || !isRetryableCopilotFetchError(error)) {
        throw error
      }

      throw toRetryableSystemError(error)
    }
  }
}
