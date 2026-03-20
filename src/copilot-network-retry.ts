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

type RetryableApiCallError = Error & {
  url: string
  requestBodyValues: unknown
  statusCode?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  isRetryable: boolean
  data?: unknown
  cause: unknown
  [key: symbol]: unknown
}

type RetryableErrorGroup = "transport" | "status" | "stream"

type JsonRecord = Record<string, unknown>

const AI_ERROR_MARKER = Symbol.for("vercel.ai.error")
const API_CALL_ERROR_MARKER = Symbol.for("vercel.ai.error.AI_APICallError")

export type AccountSwitchCleanupResult = {
  payload: JsonRecord
  changed: boolean
  strategy: "bulk" | "targeted-fallback" | "none"
}

type AccountSwitchCleanupPhaseResult = {
  payload: JsonRecord
  changed: boolean
  patchedSessionState?: boolean
}

export type AccountSwitchCleanupInput = {
  payload: JsonRecord
  bulkCleanup?: (input: { payload: JsonRecord }) => Promise<AccountSwitchCleanupPhaseResult>
  targetedCleanup?: (input: { payload: JsonRecord }) => Promise<AccountSwitchCleanupPhaseResult>
}

export type RateLimitEvidence = {
  matched: boolean
  retryAfterMs?: number
}

export type CopilotRetryContext = {
  client?: {
    session?: {
      get?: (input: { path: { id: string }; query?: { directory?: string }; throwOnError?: boolean }) => Promise<{ data?: { parentID?: string } }>
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

type InternalRequestInit = RequestInit & {
  [INTERNAL_SESSION_CONTEXT_KEY]?: string
}

const INTERNAL_SESSION_HEADER = "x-opencode-session-id"
const INTERNAL_DEBUG_LINK_HEADER = "x-opencode-debug-link-id"
export const INTERNAL_SESSION_CONTEXT_KEY = "__opencodeInternalSessionID"

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

function isConnectionMismatchInputIdErrorBody(payload: unknown) {
  if (!payload || typeof payload !== "object") return false
  const error = (payload as { error?: { message?: unknown } }).error
  return isConnectionMismatchInputIdMessage(String(error?.message ?? ""))
}

function isInputIdTooLongMessage(text: string) {
  const message = text.toLowerCase()
  return message.includes("string too long") && (message.includes("input id") || message.includes(".id'"))
}

function isConnectionMismatchInputIdMessage(text: string) {
  const message = text.toLowerCase()
  return message.includes("does not belong to this connection") && /item(?:\s+with)?\s+id/.test(message)
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

function countInputIdCandidates(payload: JsonRecord | undefined) {
  const input = payload?.input
  if (!Array.isArray(input)) return 0
  return input.filter((item) => typeof (item as { id?: unknown })?.id === "string" && ((item as { id?: string }).id?.length ?? 0) > 0)
    .length
}

function collectInputItemIds(payload: JsonRecord | undefined) {
  const input = payload?.input
  if (!Array.isArray(input)) return []
  return [...new Set(input.flatMap((item) => {
    const id = (item as { id?: unknown } | undefined)?.id
    return typeof id === "string" && id.length > 0 ? [id] : []
  }))]
}

type SessionRepairMatch = {
  messageID: string
  partID: string
  partType: string
  itemId?: string
}

type SessionMessagesResponse = {
  data?: Array<{
    info?: {
      id?: string
      role?: string
    }
    parts?: Array<JsonRecord>
  }>
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

function stripAllInputIds(payload: JsonRecord) {
  const input = payload.input
  if (!Array.isArray(input)) return payload

  let changed = false
  const nextInput = input.map((item) => {
    const id = (item as { id?: unknown } | undefined)?.id
    if (typeof id !== "string" || id.length === 0) return item
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

function bulkStripLongInputIds(payload: JsonRecord): AccountSwitchCleanupPhaseResult {
  const input = payload.input
  if (!Array.isArray(input)) {
    return {
      payload,
      changed: false,
      patchedSessionState: true,
    }
  }

  let changed = false
  const nextInput = input.map((item) => {
    const id = (item as { id?: unknown } | undefined)?.id
    if (typeof id !== "string" || id.length <= 64) return item
    changed = true
    const clone = { ...(item as JsonRecord) }
    delete (clone as { id?: unknown }).id
    return clone
  })

  if (!changed) {
    return {
      payload,
      changed: false,
      patchedSessionState: true,
    }
  }

  return {
    payload: {
      ...payload,
      input: nextInput,
    },
    changed: true,
    patchedSessionState: true,
  }
}

function stripSingleLongInputId(payload: JsonRecord): AccountSwitchCleanupPhaseResult {
  const input = payload.input
  if (!Array.isArray(input)) {
    return {
      payload,
      changed: false,
    }
  }

  const nextPayload = stripTargetedLongInputId(payload)
  return {
    payload: nextPayload,
    changed: nextPayload !== payload,
  }
}

export async function cleanupLongIdsForAccountSwitch(input: AccountSwitchCleanupInput): Promise<AccountSwitchCleanupResult> {
  const bulkCleanup = input.bulkCleanup ?? (async ({ payload }) => bulkStripLongInputIds(payload))
  const targetedCleanup = input.targetedCleanup ?? (async ({ payload }) => stripSingleLongInputId(payload))

  const bulkResult = await bulkCleanup({ payload: input.payload })
  if (bulkResult.changed && bulkResult.patchedSessionState !== false) {
    return {
      payload: bulkResult.payload,
      changed: true,
      strategy: "bulk",
    }
  }

  const targetedResult = await targetedCleanup({ payload: bulkResult.payload })
  if (targetedResult.changed) {
    return {
      payload: targetedResult.payload,
      changed: true,
      strategy: "targeted-fallback",
    }
  }

  return {
    payload: bulkResult.payload,
    changed: false,
    strategy: "none",
  }
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfterMsHeader = headers.get("retry-after-ms")
  if (retryAfterMsHeader) {
    const value = Number(retryAfterMsHeader)
    if (Number.isFinite(value) && value >= 0) return value
  }

  const retryAfterHeader = headers.get("retry-after")
  if (!retryAfterHeader) return undefined

  const seconds = Number(retryAfterHeader)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const at = Date.parse(retryAfterHeader)
  if (Number.isFinite(at)) {
    return Math.max(0, at - Date.now())
  }

  return undefined
}

async function readJsonResponseBody(response: Response): Promise<JsonRecord | undefined> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) return undefined

  const text = await response.clone().text().catch(() => "")
  if (!text) return undefined

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as JsonRecord
  } catch {
    return undefined
  }
}

export async function detectRateLimitEvidence(response: Response): Promise<RateLimitEvidence> {
  const retryAfterMs = parseRetryAfterMs(response.headers)
  if (response.ok) {
    return {
      matched: false,
    }
  }

  const payload = await readJsonResponseBody(response)
  const error = payload?.error
  const errorRecord = error && typeof error === "object" && !Array.isArray(error)
    ? (error as JsonRecord)
    : undefined
  const errorType = typeof errorRecord?.type === "string" ? errorRecord.type.toLowerCase() : ""
  const errorCode = typeof errorRecord?.code === "string" ? errorRecord.code.toLowerCase() : ""

  if (retryAfterMs !== undefined || errorType === "too_many_requests" || errorCode.includes("rate_limit")) {
    return {
      matched: true,
      retryAfterMs,
    }
  }

  return {
    matched: false,
  }
}

function isRetryableRepairError(error: unknown) {
  return isRetryableCopilotFetchError(error)
}

function toHeaderRecord(headers: RequestInit["headers"] | undefined) {
  if (!headers) return undefined
  return Object.fromEntries(new Headers(headers).entries())
}

function stripInternalHeaders(headers: RequestInit["headers"] | undefined) {
  const nextHeaders = toHeaderRecord(headers)
  if (!nextHeaders) {
    return {
      headers: undefined,
      removed: [] as string[],
    }
  }
  const removed = []
  for (const name of [INTERNAL_SESSION_HEADER, INTERNAL_DEBUG_LINK_HEADER]) {
    if (Object.hasOwn(nextHeaders, name)) {
      delete nextHeaders[name]
      removed.push(name)
    }
  }
  return {
    headers: nextHeaders,
    removed,
  }
}

function buildRetryInit(init: RequestInit | undefined, payload: JsonRecord): RequestInit {
  const headers = stripInternalHeaders(init?.headers).headers ?? {}
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json"
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
  if (!request.headers.has(INTERNAL_SESSION_HEADER) && !request.headers.has(INTERNAL_DEBUG_LINK_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(INTERNAL_SESSION_HEADER)
  headers.delete(INTERNAL_DEBUG_LINK_HEADER)
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

function getInternalPatchClient(client: CopilotRetryContext["client"]) {
  const patch = (client as {
    _client?: {
      patch?: (input: {
        url: string
        path?: Record<string, unknown>
        query?: Record<string, unknown>
        body?: JsonRecord
        headers?: Record<string, string>
      }) => Promise<unknown>
    }
  } | undefined)?._client?.patch
  return typeof patch === "function" ? patch : undefined
}

function collectSessionRepairMatches(
  messages: SessionMessagesResponse | undefined,
  predicate: (itemId: string | undefined) => boolean,
) {
  return (messages?.data ?? []).flatMap((message) => {
    if (message.info?.role !== "assistant") return []
    return (message.parts ?? []).flatMap((part) => {
      const itemId = (part.metadata as { openai?: { itemId?: unknown } } | undefined)?.openai?.itemId
      const normalizedItemId = typeof itemId === "string" ? itemId : undefined
      if (!predicate(normalizedItemId) || typeof message.info?.id !== "string" || typeof part.id !== "string") return []
      return [{
        messageID: message.info.id,
        partID: part.id,
        partType: String(part.type ?? "unknown"),
        itemId: normalizedItemId,
      } satisfies SessionRepairMatch]
    })
  })
}

async function patchSessionPart(sessionID: string, match: SessionRepairMatch, ctx?: CopilotRetryContext) {
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
      if (isRetryableRepairError(error)) return false
      throw error
    }
  }

  const internalPatch = getInternalPatchClient(ctx?.client)
  if (internalPatch) {
    const query = ctx?.directory
      ? {
          directory: ctx.directory,
        }
      : undefined
    try {
      await internalPatch({
        url: "/session/{sessionID}/message/{messageID}/part/{partID}",
        path: {
          sessionID,
          messageID: match.messageID,
          partID: match.partID,
        },
        query,
        body,
        headers: {
          "Content-Type": "application/json",
        },
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
      if (isRetryableRepairError(error)) return false
      throw error
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
      if (isRetryableRepairError(error)) return false
      throw error
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
    if (isRetryableRepairError(error)) return false
    throw error
  }
}

async function repairSessionPart(sessionID: string, failingId: string, ctx?: CopilotRetryContext) {
  const messages = await ctx?.client?.session?.messages?.({
    path: { id: sessionID },
  })
  const matches = collectSessionRepairMatches(messages, (itemId) => itemId === failingId)
  debugLog("input-id retry session candidates", {
    sessionID,
    count: matches.length,
    candidates: matches.map(({ messageID, partID, partType }) => ({ messageID, partID, partType })),
  })
  if (matches.length !== 1) return false

  const match = matches[0]
  debugLog("input-id retry session match", {
    messageID: match.messageID,
    partID: match.partID,
    partType: match.partType,
  })
  return patchSessionPart(sessionID, match, ctx)
}

async function repairSessionParts(sessionID: string, itemIds: string[], ctx?: CopilotRetryContext) {
  const requestedIds = new Set(itemIds.filter((itemId) => typeof itemId === "string" && itemId.length > 0))
  if (requestedIds.size === 0) return false

  const messages = await ctx?.client?.session?.messages?.({
    path: { id: sessionID },
  })
  const matches = collectSessionRepairMatches(messages, (itemId) => typeof itemId === "string" && requestedIds.has(itemId))
  debugLog("input-id retry session candidates", {
    sessionID,
    count: matches.length,
    candidates: matches.map(({ messageID, partID, partType, itemId }) => ({
      messageID,
      partID,
      partType,
      itemIdPreview: typeof itemId === "string" ? buildIdPreview(itemId) : undefined,
    })),
  })
  if (matches.length === 0) return false

  let patchedAll = true
  for (const match of matches) {
    debugLog("input-id retry session match", {
      messageID: match.messageID,
      partID: match.partID,
      partType: match.partType,
    })
    const patched = await patchSessionPart(sessionID, match, ctx)
    if (!patched) patchedAll = false
  }
  return patchedAll
}

async function maybeRetryConnectionMismatchItemIds(
  request: Request | URL | string,
  init: RequestInit | undefined,
  response: Response,
  baseFetch: FetchLike,
  requestPayload: JsonRecord | undefined,
  ctx?: CopilotRetryContext,
  sessionID?: string,
  startedNotified = false,
) {
  if (response.ok) {
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
  }

  const removableIds = collectInputItemIds(requestPayload)
  if (!requestPayload || removableIds.length === 0) {
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
  }

  const responseText = await response
    .clone()
    .text()
    .catch(() => "")
  if (!responseText) {
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
  }

  let matched = isConnectionMismatchInputIdMessage(responseText)
  if (!matched) {
    try {
      const bodyPayload = JSON.parse(responseText)
      matched = isConnectionMismatchInputIdErrorBody(bodyPayload)
    } catch {
      matched = false
    }
  }
  if (!matched) {
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: undefined as InputIdRetryState | undefined,
    }
  }

  const remainingBefore = countInputIdCandidates(requestPayload)
  const notifiedStarted = startedNotified || remainingBefore > 0
  let repairFailed = false
  if (sessionID) {
    repairFailed = !(await repairSessionParts(sessionID, removableIds, ctx).catch(() => false))
  }

  const sanitized = stripAllInputIds(requestPayload)
  if (sanitized === requestPayload) {
    return {
      response,
      retried: false as const,
      nextInit: init,
      nextPayload: requestPayload,
      retryState: {
        previousServerReportedIndex: undefined,
        previousErrorMessagePreview: buildMessagePreview(responseText),
        remainingLongIdCandidatesBefore: remainingBefore,
        remainingLongIdCandidatesAfter: remainingBefore,
        previousReportedLength: undefined,
        notifiedStarted,
        repairFailed,
      } satisfies InputIdRetryState,
    }
  }

  debugLog("input-id retry triggered", {
    removedLongIds: true,
    cleanupMode: "connection-mismatch-bulk",
    hadPreviousResponseId: typeof requestPayload.previous_response_id === "string",
  })

  const nextInit = buildRetryInit(init, sanitized)
  const retried = await baseFetch(request, nextInit)
  const retryState: InputIdRetryState = {
    previousServerReportedIndex: undefined,
    previousErrorMessagePreview: buildMessagePreview(responseText),
    remainingLongIdCandidatesBefore: remainingBefore,
    remainingLongIdCandidatesAfter: countInputIdCandidates(parseJsonBody(nextInit)),
    previousReportedLength: undefined,
    notifiedStarted,
    repairFailed,
  }
  debugLog("input-id retry response", {
    status: retried.status,
    contentType: retried.headers.get("content-type") ?? undefined,
  })
  return { response: retried, retried: true as const, nextInit, nextPayload: sanitized, retryState }
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
  if (response.ok) {
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

function getRequestUrl(request: Request | URL | string) {
  return request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)
}

function buildRetryableApiCallMessage(group: RetryableErrorGroup, detail: string) {
  return `Copilot retryable error [${group}]: ${detail}`
}

function toRetryableApiCallError(
  error: unknown,
  request: Request | URL | string,
  options?: {
    group: RetryableErrorGroup
    requestBodyValues?: unknown
    statusCode?: number
    responseHeaders?: Headers | Record<string, string>
    responseBody?: string
  },
): RetryableApiCallError {
  const base = error instanceof Error ? error : new Error(String(error))
  const wrapped = new Error(buildRetryableApiCallMessage(options?.group ?? "transport", base.message)) as RetryableApiCallError
  wrapped.name = "AI_APICallError"
  wrapped.url = getRequestUrl(request)
  wrapped.requestBodyValues = options?.requestBodyValues ?? {}
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

function isRetryableApiCallError(error: unknown): error is RetryableApiCallError {
  return Boolean(
    error
      && typeof error === "object"
      && (error as RetryableApiCallError)[AI_ERROR_MARKER] === true
      && (error as RetryableApiCallError)[API_CALL_ERROR_MARKER] === true,
  )
}

function isRetryableCopilotStatus(status: number) {
  return status === 499
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
  if (response.ok) return undefined

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
          const retryable = RETRYABLE_MESSAGES.some((part) => message.includes(part))
          if (isDebugEnabled()) {
            debugLog("sse stream read error", {
              url: rawUrl,
              message,
              retryableByMessage: retryable,
            })
          }
          controller.error(retryable
            ? toRetryableApiCallError(error, request, {
                group: "stream",
                statusCode: response.status,
                responseHeaders: response.headers,
              })
            : error)
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
    const headersBeforeWrapper = toHeaderRecord(init?.headers) ?? (request instanceof Request ? toHeaderRecord(request.headers) : undefined)
    debugLog("fetch headers before wrapper", {
      headers: headersBeforeWrapper,
      isRetry: false,
    })
    const safeRequest = stripInternalSessionHeaderFromRequest(request)
    const strippedHeaders = stripInternalHeaders(init?.headers)
    const initHeaders = strippedHeaders.headers
    const effectiveInit: InternalRequestInit | undefined = init || sessionID
      ? {
          ...(init ?? {}),
          headers: initHeaders,
          [INTERNAL_SESSION_CONTEXT_KEY]: sessionID,
        }
      : undefined
    debugLog("fetch headers after wrapper", {
      headers: initHeaders ?? (safeRequest instanceof Request ? toHeaderRecord(safeRequest.headers) : undefined),
      removedInternalHeaders: strippedHeaders.removed,
      isRetry: false,
    })
    debugLog("fetch start", {
      url: safeRequest instanceof Request ? safeRequest.url : safeRequest instanceof URL ? safeRequest.href : String(safeRequest),
      isCopilot: isCopilotUrl(safeRequest),
    })
    debugLog("fetch headers before network", {
      headers: toHeaderRecord(effectiveInit?.headers) ?? (safeRequest instanceof Request ? toHeaderRecord(safeRequest.headers) : undefined),
      isRetry: false,
    })
    let currentPayload = await parseJsonRequestPayload(safeRequest, effectiveInit)

    try {
      const response = await baseFetch(safeRequest, effectiveInit)
      debugLog("fetch resolved", {
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
      })

      if (isCopilotUrl(safeRequest) && isRetryableCopilotStatus(response.status)) {
        const responseBody = await response.clone().text().catch(() => "")
        throw toRetryableApiCallError(new Error(responseBody || `status code ${response.status}`), safeRequest, {
          group: "status",
          requestBodyValues: currentPayload,
          statusCode: response.status,
          responseHeaders: response.headers,
          responseBody: responseBody || undefined,
        })
      }

      if (isCopilotUrl(safeRequest)) {
        let currentResponse = response
        let currentInit = effectiveInit
        let attempts = 0
        let shouldContinueInputIdRepair = countInputIdCandidates(currentPayload) > 0
        let startedNotified = false
        let finishedNotified = false
        let repairWarningNotified = false
        const handleRetryResult = async (result: Awaited<ReturnType<typeof maybeRetryInputIdTooLong>>) => {
          currentResponse = result.response
          currentInit = result.nextInit
          currentPayload = result.nextPayload

          if (!result.retryState) {
            return {
              handled: false,
              stop: false,
              shouldContinue: false,
            }
          }

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
            return {
              handled: true,
              stop: true,
              shouldContinue: false,
            }
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
          if (!result.retried) {
            if (startedNotified && !finishedNotified) {
              await notify(notifier, "stopped", result.retryState.remainingLongIdCandidatesAfter)
              finishedNotified = true
            }
            return {
              handled: true,
              stop: true,
              shouldContinue: false,
            }
          }

          return {
            handled: true,
            stop: false,
            shouldContinue: madeProgress && result.retryState.remainingLongIdCandidatesAfter > 0,
          }
        }
        while (shouldContinueInputIdRepair) {
          shouldContinueInputIdRepair = false

          const connectionMismatchResult = await maybeRetryConnectionMismatchItemIds(
            safeRequest,
            currentInit,
            currentResponse,
            baseFetch,
            currentPayload,
            options,
            sessionID,
            startedNotified,
          )

          const handledConnectionMismatch = await handleRetryResult(connectionMismatchResult)
          if (handledConnectionMismatch.stop) break
          if (handledConnectionMismatch.handled) {
            attempts += 1
            shouldContinueInputIdRepair = handledConnectionMismatch.shouldContinue
            continue
          }

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

          const handled = await handleRetryResult(result)
          if (handled.stop) break
          if (!handled.handled) {
            if (startedNotified && !finishedNotified) {
              await notify(notifier, "stopped", countInputIdCandidates(currentPayload))
              finishedNotified = true
            }
            break
          }

          attempts += 1
          shouldContinueInputIdRepair = handled.shouldContinue
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

      if (isRetryableApiCallError(error)) {
        throw error
      }

      throw toRetryableApiCallError(error, safeRequest, {
        group: "transport",
        requestBodyValues: currentPayload,
      })
    }
  }
}
