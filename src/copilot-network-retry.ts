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

const MAX_INPUT_ID_REPAIR_ATTEMPTS = 3

export type FetchLike = (request: Request | URL | string, init?: RequestInit) => Promise<Response>

type RetryableSystemError = Error & {
  code: string
  syscall: string
  cause: unknown
}

type JsonRecord = Record<string, unknown>

export type CopilotRetryContext = {
  client?: {
    session?: {
      messages?: (input: { path: { id: string } }) => Promise<{ data?: Array<{ info?: { id?: string; role?: string }; parts?: Array<JsonRecord> }> }>
      message?: (input: { path: { id: string; messageID: string } }) => Promise<{ data?: { parts?: Array<JsonRecord> } }>
    }
  }
  directory?: string
  serverUrl?: URL
  wait?: (ms: number) => Promise<void>
  patchPart?: (request: { url: string; init: RequestInit }) => Promise<unknown>
}

const INTERNAL_SESSION_HEADER = "x-opencode-session-id"

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
  return message.includes("string too long") && (message.includes("input id") || message.includes(".id'"))
}

function isInputIdTooLongMessage(text: string) {
  const message = text.toLowerCase()
  return message.includes("string too long") && (message.includes("input id") || message.includes(".id'"))
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

function buildIdPreview(id: string) {
  return `${id.slice(0, 12)}...`
}

function getPayloadCandidates(payload: JsonRecord) {
  const input = payload.input
  if (!Array.isArray(input)) return []
  return input.flatMap((item, payloadIndex) => {
    const id = (item as { id?: unknown } | undefined)?.id
    if (typeof id !== "string" || id.length <= 64) return []
    const content = (item as { content?: Array<{ type?: unknown }> } | undefined)?.content
    const itemKind = Array.isArray(content) && typeof content[0]?.type === "string" ? String(content[0].type) : "unknown"
    return [{ payloadIndex, idLength: id.length, itemKind, idPreview: buildIdPreview(id) }]
  })
}

function hasLongInputIds(payload: JsonRecord) {
  const input = payload.input
  if (!Array.isArray(input)) return false
  return input.some((item) => typeof (item as { id?: unknown })?.id === "string" && ((item as { id?: string }).id?.length ?? 0) > 64)
}

function getTargetedLongInputId(payload: JsonRecord, reportedLength?: number) {
  const input = payload.input
  if (!Array.isArray(input)) return undefined

  const matches = input.filter(
    (item) => typeof (item as { id?: unknown })?.id === "string" && ((item as { id?: string }).id?.length ?? 0) > 64,
  )
  if (matches.length === 0) return undefined

  const lengthMatches = reportedLength
    ? matches.filter((item) => String((item as { id?: unknown }).id ?? "").length === reportedLength)
    : matches
  if (lengthMatches.length === 1) return lengthMatches[0] as JsonRecord
  if (lengthMatches.length > 1) return lengthMatches[0] as JsonRecord
  if (matches.length === 1) return matches[0] as JsonRecord
  return matches.reduce((best, item) => {
    const bestLength = String((best as { id?: unknown }).id ?? "").length
    const itemLength = String((item as { id?: unknown }).id ?? "").length
    return itemLength > bestLength ? (item as JsonRecord) : best
  }, matches[0] as JsonRecord)
}

function stripTargetedLongInputId(payload: JsonRecord, reportedLength?: number) {
  const input = payload.input
  if (!Array.isArray(input)) return payload

  const target = getTargetedLongInputId(payload, reportedLength)
  if (!target) return payload

  let changed = false
  const nextInput = input.map((item) => {
    if (item !== target) return item
    changed = true
    const clone = { ...(item as JsonRecord) }
    delete (clone as { id?: unknown }).id
    return clone
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
  headers.delete(INTERNAL_SESSION_HEADER)
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return {
    ...init,
    headers,
    body: JSON.stringify(payload),
  }
}

function stripInternalSessionHeaderFromRequest(request: Request | URL | string) {
  if (!(request instanceof Request)) return request
  if (!request.headers.has(INTERNAL_SESSION_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(INTERNAL_SESSION_HEADER)
  return new Request(request, { headers })
}

function getHeader(request: Request | URL | string, init: RequestInit | undefined, name: string) {
  const initHeaders = new Headers(init?.headers)
  const initValue = initHeaders.get(name)
  if (initValue) return initValue
  if (request instanceof Request) return request.headers.get(name) ?? undefined
  return undefined
}

function getTargetedInputId(payload: JsonRecord, reportedLength?: number) {
  const target = getTargetedLongInputId(payload, reportedLength)
  const id = (target as { id?: unknown } | undefined)?.id
  if (typeof id !== "string") return undefined
  return id
}

function stripOpenAIItemId(part: JsonRecord) {
  const metadata = part.metadata
  if (!metadata || typeof metadata !== "object") return part
  const openai = (metadata as { openai?: unknown }).openai
  if (!openai || typeof openai !== "object") return part
  if (!Object.hasOwn(openai, "itemId")) return part

  const nextOpenai = { ...(openai as JsonRecord) }
  delete nextOpenai.itemId
  return {
    ...part,
    metadata: {
      ...(metadata as JsonRecord),
      openai: nextOpenai,
    },
  }
}

async function repairSessionPart(sessionID: string, failingId: string, ctx?: CopilotRetryContext) {
  const messages = await ctx?.client?.session?.messages?.({
    path: { id: sessionID },
  })
  const matches = (messages?.data ?? []).flatMap((message) => {
    if (message.info?.role !== "assistant") return []
    return (message.parts ?? []).flatMap((part) => {
      const itemId = (part.metadata as { openai?: { itemId?: unknown } } | undefined)?.openai?.itemId
      if (itemId !== failingId || typeof message.info?.id !== "string" || typeof part.id !== "string") return []
      return [{ messageID: message.info.id, partID: part.id, partType: String(part.type ?? "unknown") }]
    })
  })
  debugLog("input-id retry session candidates", {
    sessionID,
    count: matches.length,
    candidates: matches,
  })
  if (matches.length !== 1) return false

  const match = matches[0]
  debugLog("input-id retry session match", match)
  const latest = await ctx?.client?.session?.message?.({
    path: {
      id: sessionID,
      messageID: match.messageID,
    },
  })
  const part = latest?.data?.parts?.find((item) => item.id === match.partID)
  if (!part) return false

  const body = stripOpenAIItemId(part)
  const url = new URL(`/session/${sessionID}/message/${match.messageID}/part/${match.partID}`, ctx?.serverUrl)
  if (ctx?.directory) url.searchParams.set("directory", ctx.directory)
  const init = {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }

  if (ctx?.patchPart) {
    await ctx.patchPart({ url: url.href, init })
    debugLog("input-id retry session repair", {
      partID: match.partID,
      messageID: match.messageID,
      sessionID,
    })
    return true
  }

  const response = await fetch(url, init)
  debugLog("input-id retry session repair", {
    partID: match.partID,
    messageID: match.messageID,
    sessionID,
    ok: response.ok,
  })
  return response.ok
}

async function maybeRetryInputIdTooLong(
  request: Request | URL | string,
  init: RequestInit | undefined,
  response: Response,
  baseFetch: FetchLike,
  ctx?: CopilotRetryContext,
  sessionID?: string,
) {
  if (response.status !== 400) return { response, retried: false as const, nextInit: init }

  const requestPayload = parseJsonBody(init)
  if (!requestPayload || !hasLongInputIds(requestPayload)) {
    debugLog("skip input-id retry: request has no long ids")
    return { response, retried: false as const, nextInit: init }
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
    return { response, retried: false as const, nextInit: init }
  }

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

  debugLog("input-id retry detection", {
    matched,
    serverReportedIndex: parsed.serverReportedIndex,
    reportedLength: parsed.reportedLength,
    bodyPreview: responseText.slice(0, 200),
  })
  debugLog("input-id retry parsed", {
    serverReportedIndex: parsed.serverReportedIndex,
    reportedLength: parsed.reportedLength,
  })

  if (!matched) return { response, retried: false as const, nextInit: init }

  if (parsed.serverReportedIndex === undefined) {
    debugLog("skip input-id retry: missing server input index", {
      reportedLength: parsed.reportedLength,
    })
    return { response, retried: false as const, nextInit: init }
  }

  const payloadCandidates = getPayloadCandidates(requestPayload)
  debugLog("input-id retry payload candidates", {
    serverReportedIndex: parsed.serverReportedIndex,
    candidates: payloadCandidates,
  })

  const failingId = getTargetedInputId(requestPayload, parsed.reportedLength)
  const targetedPayload = payloadCandidates.find((item) => item.idLength === parsed.reportedLength) ?? payloadCandidates[0]
  if (targetedPayload) {
    debugLog("input-id retry payload target", {
      targetedPayloadIndex: targetedPayload.payloadIndex,
      itemKind: targetedPayload.itemKind,
      idLength: targetedPayload.idLength,
      idPreview: targetedPayload.idPreview,
    })
  }
  if (sessionID && failingId) {
    await repairSessionPart(sessionID, failingId, ctx).catch(() => false)
  }

  const sanitized = stripTargetedLongInputId(requestPayload, parsed.reportedLength)
  if (sanitized === requestPayload) {
    debugLog("skip input-id retry: sanitize made no changes")
    return { response, retried: false as const, nextInit: init }
  }

  debugLog("input-id retry triggered", {
    removedLongIds: true,
    hadPreviousResponseId: typeof requestPayload.previous_response_id === "string",
  })

  const nextInit = buildRetryInit(init, sanitized)
  const retried = await baseFetch(request, nextInit)
  debugLog("input-id retry response", {
    status: retried.status,
    contentType: retried.headers.get("content-type") ?? undefined,
  })
  return { response: retried, retried: true as const, nextInit }
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
  options?: CopilotRetryContext,
) {
  void options

  return async function retryingFetch(request: Request | URL | string, init?: RequestInit) {
    const sessionID = getHeader(request, init, INTERNAL_SESSION_HEADER)
    const safeRequest = stripInternalSessionHeaderFromRequest(request)
    const initHeaders = new Headers(init?.headers)
    initHeaders.delete(INTERNAL_SESSION_HEADER)
    const effectiveInit: RequestInit | undefined = init
      ? {
          ...init,
          headers: initHeaders,
        }
      : undefined
    debugLog("fetch start", {
      url: safeRequest instanceof Request ? safeRequest.url : safeRequest instanceof URL ? safeRequest.href : String(safeRequest),
      isCopilot: isCopilotUrl(safeRequest),
    })

    try {
      const response = await baseFetch(safeRequest, effectiveInit)
      debugLog("fetch resolved", {
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
      })

      if (isCopilotUrl(safeRequest)) {
        let currentResponse = response
        let currentInit = effectiveInit
        for (let attempt = 0; attempt < MAX_INPUT_ID_REPAIR_ATTEMPTS; attempt += 1) {
          const result = await maybeRetryInputIdTooLong(safeRequest, currentInit, currentResponse, baseFetch, options, sessionID)
          currentResponse = result.response
          currentInit = result.nextInit
          if (!result.retried) break
        }
        return withStreamDebugLogs(currentResponse, safeRequest)
      }
      return response
    } catch (error) {
      debugLog("fetch threw", {
        message: getErrorMessage(error),
        retryableByMessage: isRetryableCopilotFetchError(error),
      })

      if (!isCopilotUrl(safeRequest) || !isRetryableCopilotFetchError(error)) {
        throw error
      }

      throw toRetryableSystemError(error)
    }
  }
}
