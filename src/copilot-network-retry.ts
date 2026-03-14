import { appendFileSync } from "node:fs"

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

const defaultDebugLogFile = (() => {
  const tmp = process.env.TEMP || process.env.TMP || "/tmp"
  return `${tmp}/opencode-copilot-retry-debug.log`
})()

function isDebugEnabled() {
  return process.env.OPENCODE_COPILOT_RETRY_DEBUG === "1"
}

function debugLog(message: string, details?: Record<string, unknown>) {
  if (!isDebugEnabled()) return
  const suffix = details ? ` ${JSON.stringify(details)}` : ""
  const line = `[copilot-network-retry debug] ${new Date().toISOString()} ${message}${suffix}`
  console.warn(line)

  const filePath = process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE || defaultDebugLogFile
  if (!filePath) return

  try {
    appendFileSync(filePath, `${line}\n`)
  } catch (error) {
    console.warn(
      `[copilot-network-retry debug] failed to write log file ${JSON.stringify({ filePath, error: String(error) })}`,
    )
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function getErrorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).toLowerCase()
}

function isInputIdTooLongErrorBody(payload: unknown) {
  if (!payload || typeof payload !== "object") return false
  const error = (payload as { error?: { message?: unknown } }).error
  const message = String(error?.message ?? "").toLowerCase()
  return message.includes("invalid 'input[") && message.includes(".id'") && message.includes("string too long")
}

function isInputIdTooLongMessage(text: string) {
  const message = text.toLowerCase()
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
  if (!requestPayload || !hasLongInputIds(requestPayload)) {
    debugLog("skip input-id retry: request has no long ids")
    return response
  }

  debugLog("input-id retry candidate", {
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
  })

  const responseText = await response
    .clone()
    .text()
    .catch(() => "")

  if (!responseText) {
    debugLog("skip input-id retry: empty response body")
    return response
  }

  let matched = isInputIdTooLongMessage(responseText)
  if (!matched) {
    try {
      const bodyPayload = JSON.parse(responseText)
      matched = isInputIdTooLongErrorBody(bodyPayload)
    } catch {
      matched = false
    }
  }

  debugLog("input-id retry detection", {
    matched,
    bodyPreview: responseText.slice(0, 200),
  })

  if (!matched) return response

  const sanitized = stripLongInputIds(requestPayload)
  if (sanitized === requestPayload) {
    debugLog("skip input-id retry: sanitize made no changes")
    return response
  }

  debugLog("input-id retry triggered", {
    removedLongIds: true,
    hadPreviousResponseId: typeof requestPayload.previous_response_id === "string",
  })

  const retried = await baseFetch(request, buildRetryInit(init, sanitized))
  debugLog("input-id retry response", {
    status: retried.status,
    contentType: retried.headers.get("content-type") ?? undefined,
  })
  return retried
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

function withStreamDebugLogs(response: Response, request: Request | URL | string) {
  if (!isDebugEnabled()) return response
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("text/event-stream") || !response.body) return response

  const rawUrl = request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = response.body!.getReader()
      const pump = async () => {
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) {
              debugLog("sse stream finished", { url: rawUrl })
              controller.close()
              break
            }
            controller.enqueue(next.value)
          }
        } catch (error) {
          const message = getErrorMessage(error)
          debugLog("sse stream read error", {
            url: rawUrl,
            message,
            retryableByMessage: RETRYABLE_MESSAGES.some((part) => message.includes(part)),
          })
          controller.error(error)
        }
      }

      void pump()
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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
    debugLog("fetch start", {
      url: request instanceof Request ? request.url : request instanceof URL ? request.href : String(request),
      isCopilot: isCopilotUrl(request),
    })

    try {
      const response = await baseFetch(request, init)
      debugLog("fetch resolved", {
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
      })

      if (isCopilotUrl(request)) {
        const retried = await maybeRetryInputIdTooLong(request, init, response, baseFetch)
        return withStreamDebugLogs(retried, request)
      }
      return response
    } catch (error) {
      debugLog("fetch threw", {
        message: getErrorMessage(error),
        retryableByMessage: isRetryableCopilotFetchError(error),
      })

      if (!isCopilotUrl(request) || !isRetryableCopilotFetchError(error)) {
        throw error
      }

      throw toRetryableSystemError(error)
    }
  }
}
