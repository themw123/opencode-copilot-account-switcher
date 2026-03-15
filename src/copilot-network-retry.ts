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

export type FetchLike = (request: Request | URL | string, init?: RequestInit) => Promise<Response>

export type CopilotRetryNotifier = {
  started: (state: { remaining: number }) => Promise<void>
  progress: (state: { remaining: number }) => Promise<void>
  repairWarning: (state: { remaining: number }) => Promise<void>
  completed: (state: { remaining: number }) => Promise<void>
  stopped: (state: { remaining: number }) => Promise<void>
}

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
    part?: {
      update?: (input: {
        sessionID: string
        messageID: string
        partID: string
        directory?: string
        part?: JsonRecord
      }) => Promise<unknown>
    }
    tui?: {
      showToast?: (options: {
        body: {
          title?: string
          message: string
          variant: "info" | "success" | "warning" | "error"
          duration?: number
        }
        query?: undefined
      }) => Promise<unknown>
    }
  }
  directory?: string
  serverUrl?: URL
  lastAccountSwitchAt?: number
  clearAccountSwitchContext?: () => Promise<void>
  wait?: (ms: number) => Promise<void>
  patchPart?: (request: { url: string; init: RequestInit }) => Promise<unknown>
  notifier?: CopilotRetryNotifier
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

function buildMessagePreview(message: string) {
  return message.slice(0, 160)
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

function countLongInputIdCandidates(payload: JsonRecord | undefined) {
  const input = payload?.input
  if (!Array.isArray(input)) return 0
  return input.filter((item) => typeof (item as { id?: unknown })?.id === "string" && ((item as { id?: string }).id?.length ?? 0) > 64)
    .length
}

type LongInputIdCandidate = {
  item: JsonRecord
  payloadIndex: number
  idLength: number
}

type TargetedInputIdSelection = {
  candidate?: LongInputIdCandidate
  strategy: "single-long-id" | "reported-length" | "index-hint" | "ambiguous"
  candidates: LongInputIdCandidate[]
  reportedLengthMatched: boolean
}

function collectLongInputIdCandidates(payload: JsonRecord) {
  const input = payload.input
  if (!Array.isArray(input)) return []
  return input.flatMap((item, payloadIndex) => {
    const id = (item as { id?: unknown } | undefined)?.id
    if (typeof id !== "string" || id.length <= 64) return []
    return [{ item: item as JsonRecord, payloadIndex, idLength: id.length } satisfies LongInputIdCandidate]
  })
}

function getTargetedLongInputIdSelection(
  payload: JsonRecord,
  serverReportedIndex?: number,
  reportedLength?: number,
): TargetedInputIdSelection {
  const matches = collectLongInputIdCandidates(payload)
  if (matches.length === 0) {
    return {
      strategy: "ambiguous",
      candidates: [],
      reportedLengthMatched: reportedLength === undefined,
    }
  }

  const lengthMatches = reportedLength
    ? matches.filter((item) => item.idLength === reportedLength)
    : matches

  if (reportedLength !== undefined && lengthMatches.length === 0) {
    return {
      strategy: "ambiguous",
      candidates: [],
      reportedLengthMatched: false,
    }
  }

  if (lengthMatches.length === 1) {
    return {
      candidate: lengthMatches[0],
      strategy: reportedLength !== undefined && matches.length > 1 ? "reported-length" : "single-long-id",
      candidates: lengthMatches,
      reportedLengthMatched: true,
    }
  }
  if (matches.length === 1) {
    return {
      candidate: matches[0],
      strategy: "single-long-id",
      candidates: matches,
      reportedLengthMatched: reportedLength === undefined,
    }
  }

  const narrowedCandidates = lengthMatches.length > 0 ? lengthMatches : matches
  if (typeof serverReportedIndex === "number") {
    const hintedCandidates = narrowedCandidates.filter(
      (candidate) => candidate.payloadIndex === serverReportedIndex || candidate.payloadIndex + 1 === serverReportedIndex,
    )
    if (hintedCandidates.length === 1) {
      return {
        candidate: hintedCandidates[0],
        strategy: "index-hint",
        candidates: narrowedCandidates,
        reportedLengthMatched: true,
      }
    }
  }

  return {
    strategy: "ambiguous",
    candidates: narrowedCandidates,
    reportedLengthMatched: true,
  }
}

function stripTargetedLongInputId(payload: JsonRecord, serverReportedIndex?: number, reportedLength?: number) {
  const input = payload.input
  if (!Array.isArray(input)) return payload

  const target = getTargetedLongInputIdSelection(payload, serverReportedIndex, reportedLength).candidate?.item
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

type InputIdRetryState = {
  previousServerReportedIndex?: number
  previousErrorMessagePreview: string
  remainingLongIdCandidatesBefore: number
  remainingLongIdCandidatesAfter: number
  previousReportedLength?: number
  notifiedStarted: boolean
  repairFailed: boolean
  stopReason?: string
}

const noopNotifier: CopilotRetryNotifier = {
  started: async () => {},
  progress: async () => {},
  repairWarning: async () => {},
  completed: async () => {},
  stopped: async () => {},
}

async function notify(notifier: CopilotRetryNotifier, event: keyof CopilotRetryNotifier, remaining: number) {
  try {
    await notifier[event]({ remaining })
  } catch (error) {
    console.warn(`[copilot-network-retry] notifier ${event} failed`, error)
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

function getTargetedInputId(payload: JsonRecord, serverReportedIndex?: number, reportedLength?: number) {
  const target = getTargetedLongInputIdSelection(payload, serverReportedIndex, reportedLength).candidate?.item
  const id = (target as { id?: unknown } | undefined)?.id
  if (typeof id !== "string") return undefined
  return id
}

function logCleanupStopped(reason: string, details?: Record<string, unknown>) {
  debugLog("input-id retry cleanup-stopped", {
    reason,
    ...(details ?? {}),
  })
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

  if (ctx?.client?.part?.update) {
    try {
      await ctx.client.part.update({
        sessionID,
        messageID: match.messageID,
        partID: match.partID,
        directory: ctx.directory,
        part: body,
      })
      debugLog("input-id retry session repair", {
        partID: match.partID,
        messageID: match.messageID,
        sessionID,
      })
      return true
    } catch (error) {
      debugLog("input-id retry session repair failed", {
        partID: match.partID,
        messageID: match.messageID,
        sessionID,
        error: String(error instanceof Error ? error.message : error),
      })
      return false
    }
  }

  if (ctx?.patchPart) {
    try {
      await ctx.patchPart({ url: url.href, init })
      debugLog("input-id retry session repair", {
        partID: match.partID,
        messageID: match.messageID,
        sessionID,
      })
      return true
    } catch (error) {
      debugLog("input-id retry session repair failed", {
        partID: match.partID,
        messageID: match.messageID,
        sessionID,
        error: String(error instanceof Error ? error.message : error),
      })
      return false
    }
  }

  try {
    const response = await fetch(url, init)
    debugLog("input-id retry session repair", {
      partID: match.partID,
      messageID: match.messageID,
      sessionID,
      ok: response.ok,
    })
    if (!response.ok) {
      debugLog("input-id retry session repair failed", {
        partID: match.partID,
        messageID: match.messageID,
        sessionID,
        status: response.status,
      })
    }
    return response.ok
  } catch (error) {
    debugLog("input-id retry session repair failed", {
      partID: match.partID,
      messageID: match.messageID,
      sessionID,
      error: String(error instanceof Error ? error.message : error),
    })
    return false
  }
}

async function maybeRetryInputIdTooLong(
  request: Request | URL | string,
  init: RequestInit | undefined,
  response: Response,
  baseFetch: FetchLike,
  requestPayload: JsonRecord | undefined,
  ctx?: CopilotRetryContext,
  sessionID?: string,
  startedNotified = false,
) {
  if (response.status !== 400) {
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
  }

  if (!requestPayload || !hasLongInputIds(requestPayload)) {
    debugLog("skip input-id retry: request has no long ids")
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
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
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
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

  if (!matched) {
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
  }

  const payloadCandidates = getPayloadCandidates(requestPayload)
  const targetSelection = getTargetedLongInputIdSelection(
    requestPayload,
    parsed.serverReportedIndex,
    parsed.reportedLength,
  )
  debugLog("input-id retry payload candidates", {
    serverReportedIndex: parsed.serverReportedIndex,
    candidates: payloadCandidates,
  })

  const failingId = getTargetedInputId(requestPayload, parsed.serverReportedIndex, parsed.reportedLength)
  const targetedPayload = targetSelection.candidate
    ? payloadCandidates.find((item) => item.payloadIndex === targetSelection.candidate?.payloadIndex)
    : undefined
  debugLog("input-id retry payload target", {
    serverReportedIndex: parsed.serverReportedIndex,
    targetedPayloadIndex: targetedPayload?.payloadIndex,
    itemKind: targetedPayload?.itemKind,
    idLength: targetedPayload?.idLength,
    idPreview: targetedPayload?.idPreview,
    strategy: targetSelection.strategy,
  })
  const remainingBefore = countLongInputIdCandidates(requestPayload)
  if (!targetSelection.candidate) {
    logCleanupStopped("evidence-insufficient", {
      serverReportedIndex: parsed.serverReportedIndex,
      reportedLength: parsed.reportedLength,
      candidateCount: targetSelection.candidates.length,
      reportedLengthMatched: targetSelection.reportedLengthMatched,
    })
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
        retryState: {
          previousServerReportedIndex: parsed.serverReportedIndex,
          previousErrorMessagePreview: buildMessagePreview(responseText),
          remainingLongIdCandidatesBefore: remainingBefore,
          remainingLongIdCandidatesAfter: remainingBefore,
          previousReportedLength: parsed.reportedLength,
          notifiedStarted: startedNotified || remainingBefore > 0,
          repairFailed: false,
          stopReason: "evidence-insufficient",
        } satisfies InputIdRetryState,
      }
    }
  const notifiedStarted = startedNotified || remainingBefore > 0

  let repairFailed = false
  if (sessionID && failingId) {
    repairFailed = !(await repairSessionPart(sessionID, failingId, ctx).catch(() => false))
  }

  const sanitized = stripTargetedLongInputId(requestPayload, parsed.serverReportedIndex, parsed.reportedLength)
  if (sanitized === requestPayload) {
    debugLog("skip input-id retry: sanitize made no changes")
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: {
        previousServerReportedIndex: parsed.serverReportedIndex,
        previousErrorMessagePreview: buildMessagePreview(responseText),
        remainingLongIdCandidatesBefore: remainingBefore,
        remainingLongIdCandidatesAfter: remainingBefore,
        previousReportedLength: parsed.reportedLength,
        notifiedStarted,
        repairFailed,
      } satisfies InputIdRetryState,
    }
  }

  debugLog("input-id retry triggered", {
    removedLongIds: true,
    hadPreviousResponseId: typeof requestPayload.previous_response_id === "string",
  })

  const nextInit = buildRetryInit(init, sanitized)
  const retried = await baseFetch(request, nextInit)
  const retryState: InputIdRetryState = {
    previousServerReportedIndex: parsed.serverReportedIndex,
    previousErrorMessagePreview: buildMessagePreview(responseText),
    remainingLongIdCandidatesBefore: remainingBefore,
    remainingLongIdCandidatesAfter: countLongInputIdCandidates(parseJsonBody(nextInit)),
    previousReportedLength: parsed.reportedLength,
    notifiedStarted,
    repairFailed,
  }
  debugLog("input-id retry response", {
    status: retried.status,
    contentType: retried.headers.get("content-type") ?? undefined,
  })
  return { response: retried, retried: true as const, nextInit, nextPayload: sanitized, retryState }
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

async function getInputIdRetryErrorDetails(response: Response) {
  if (response.status !== 400) return undefined

  const responseText = await response
    .clone()
    .text()
    .catch(() => "")
  if (!responseText) return undefined

  let parsed = parseInputIdTooLongDetails(responseText)
  let matched = parsed.matched
  let message = responseText
  if (!matched) {
    try {
      const bodyPayload = JSON.parse(responseText)
      const error = (bodyPayload as { error?: { message?: unknown } }).error
      message = String(error?.message ?? "")
      parsed = parseInputIdTooLongDetails(message)
      matched = parsed.matched || isInputIdTooLongErrorBody(bodyPayload)
    } catch {
      matched = false
    }
  }

  if (!matched) return undefined
  return {
    serverReportedIndex: parsed.serverReportedIndex,
    reportedLength: parsed.reportedLength,
    errorMessagePreview: buildMessagePreview(message),
  }
}

async function parseJsonRequestPayload(request: Request | URL | string, init?: RequestInit) {
  const initPayload = parseJsonBody(init)
  if (initPayload) return initPayload
  if (!(request instanceof Request)) return undefined

  try {
    const body = await request.clone().text()
    if (!body) return undefined
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== "object") return undefined
    return parsed as JsonRecord
  } catch {
    return undefined
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
  const notifier = options?.notifier ?? noopNotifier

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
    let currentPayload = await parseJsonRequestPayload(safeRequest, effectiveInit)

    try {
      const response = await baseFetch(safeRequest, effectiveInit)
      debugLog("fetch resolved", {
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
      })

      if (isCopilotUrl(safeRequest)) {
        let currentResponse = response
        let currentInit = effectiveInit
        let attempts = 0
        let shouldContinueInputIdRepair = countLongInputIdCandidates(currentPayload) > 0
        let startedNotified = false
        let finishedNotified = false
        let repairWarningNotified = false
        while (shouldContinueInputIdRepair) {
          shouldContinueInputIdRepair = false

          const result = await maybeRetryInputIdTooLong(
            safeRequest,
            currentInit,
            currentResponse,
            baseFetch,
            currentPayload,
            options,
            sessionID,
            startedNotified,
          )
          currentResponse = result.response
          currentInit = result.nextInit
          currentPayload = result.nextPayload
          if (result.retryState) {
            if (!startedNotified && result.retryState.notifiedStarted) {
              startedNotified = true
              await notify(notifier, "started", result.retryState.remainingLongIdCandidatesBefore)
            }
            if (result.retryState.repairFailed && !repairWarningNotified) {
              await notify(notifier, "repairWarning", result.retryState.remainingLongIdCandidatesBefore)
              repairWarningNotified = true
            }
            const currentError = await getInputIdRetryErrorDetails(currentResponse)
            let stopReason: string | undefined = result.retryState.stopReason
            const madeProgress =
              result.retryState.remainingLongIdCandidatesAfter < result.retryState.remainingLongIdCandidatesBefore
            if (!stopReason && result.retryState.remainingLongIdCandidatesAfter >= result.retryState.remainingLongIdCandidatesBefore) {
              stopReason = "remaining-candidates-not-reduced"
            }
            if (
              !stopReason &&
              currentError &&
              result.retryState.remainingLongIdCandidatesAfter > 0 &&
              result.retryState.previousServerReportedIndex === currentError.serverReportedIndex &&
              result.retryState.previousReportedLength === currentError.reportedLength
            ) {
              stopReason = "same-server-item-persists"
            }
            if (!stopReason && currentError && result.retryState.remainingLongIdCandidatesAfter === 0) {
              stopReason = "local-candidates-exhausted"
            }
            if ((currentError || stopReason) && stopReason !== "evidence-insufficient") {
              debugLog("input-id retry progress", {
                attempt: attempts + 1,
                previousServerReportedIndex: result.retryState.previousServerReportedIndex,
                currentServerReportedIndex: currentError?.serverReportedIndex,
                serverIndexChanged: result.retryState.previousServerReportedIndex !== currentError?.serverReportedIndex,
                previousErrorMessagePreview: result.retryState.previousErrorMessagePreview,
                currentErrorMessagePreview: currentError?.errorMessagePreview,
                remainingLongIdCandidatesBefore: result.retryState.remainingLongIdCandidatesBefore,
                remainingLongIdCandidatesAfter: result.retryState.remainingLongIdCandidatesAfter,
                stopReason,
              })
            }
            if (stopReason === "local-candidates-exhausted") {
              logCleanupStopped("local-candidates-exhausted", {
                attempt: attempts + 1,
                previousServerReportedIndex: result.retryState.previousServerReportedIndex,
                currentServerReportedIndex: currentError?.serverReportedIndex,
              })
            }
            if (stopReason) {
              await notify(notifier, "stopped", result.retryState.remainingLongIdCandidatesAfter)
              finishedNotified = true
              break
            }
            if (result.retried && madeProgress && result.retryState.remainingLongIdCandidatesAfter > 0) {
              await notify(notifier, "progress", result.retryState.remainingLongIdCandidatesAfter)
            }
            if (result.retried && result.retryState.remainingLongIdCandidatesAfter === 0 && currentResponse.ok) {
              await notify(notifier, "completed", 0)
              finishedNotified = true
            }
            if (result.retried && result.retryState.remainingLongIdCandidatesAfter === 0 && !currentResponse.ok) {
              await notify(notifier, "stopped", 0)
              finishedNotified = true
            }
            if (result.retried && madeProgress && result.retryState.remainingLongIdCandidatesAfter > 0) {
              shouldContinueInputIdRepair = true
            }
          }
          if (!result.retried) {
            if (startedNotified && !finishedNotified) {
              await notify(notifier, "stopped", countLongInputIdCandidates(currentPayload))
              finishedNotified = true
            }
            break
          }
          attempts += 1
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
