import { appendFileSync } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  createCompactionLoopSafetyBypass,
  createLoopSafetySystemTransform,
  getLoopSafetyProviderScope,
  isCopilotProvider,
  type LoopSafetyProviderScope,
  type CopilotPluginHooks,
} from "./loop-safety-plugin.js"
import {
  createCopilotRetryingFetch,
  detectRateLimitEvidence,
  type CopilotRetryContext,
  type FetchLike,
} from "./copilot-network-retry.js"
import { createCopilotRetryNotifier } from "./copilot-retry-notifier.js"
import { resolveCopilotModelAccounts, type ResolvedModelAccountCandidate } from "./model-account-map.js"
import { normalizeDomain } from "./copilot-api-helpers.js"
import { readStoreSafe, readStoreSafeSync, writeStore, type StoreFile, type StoreWriteDebugMeta } from "./store.js"
import {
  loadOfficialCopilotConfig,
  loadOfficialCopilotChatHeaders,
  type CopilotAuthState,
  type CopilotProviderConfig,
  type OfficialCopilotConfig,
  type OfficialChatHeadersHook,
} from "./upstream/copilot-loader-adapter.js"
import { createNotifyTool } from "./notify-tool.js"
import { createWaitTool } from "./wait-tool.js"
import { refreshActiveAccountQuota, type RefreshActiveAccountQuotaResult } from "./active-account-quota.js"
import { handleStatusCommand, showStatusToast } from "./status-command.js"
import {
  type AppendSessionTouchEventInput,
  appendRoutingEvent,
  appendSessionTouchEvent,
  buildCandidateAccountLoads,
  readRoutingState,
  routingStatePath,
  type RoutingEvent,
} from "./routing-state.js"

type AuthLoader = NonNullable<CopilotPluginHooks["auth"]>["loader"]
type AuthProvider = Parameters<NonNullable<AuthLoader>>[1]
type ChatHeadersHook = (input: {
  sessionID: string
  agent: string
  model: {
    providerID: string
    api?: {
      npm?: string
    }
  }
  provider: {
    source: string
    info: object
    options: object
  }
  message: {
    id: string
    sessionID?: string
  }
}, output: {
  headers: Record<string, string>
}) => Promise<void>

type CopilotPluginHooksWithChatHeaders = CopilotPluginHooks & {
  "chat.headers"?: ChatHeadersHook
}

type StatusCommandHandler = typeof handleStatusCommand
type RefreshQuota = (store: StoreFile) => Promise<RefreshActiveAccountQuotaResult>

type CandidateAccountLoads = Record<string, number> | Map<string, number>
type SessionBinding = {
  accountName: string
  lastUsedAt: number
}

const SESSION_BINDING_IDLE_TTL_MS = 30 * 60 * 1000
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT_HIT_THRESHOLD = 3
const MAX_SESSION_BINDINGS = 256
const TOUCH_WRITE_CACHE_IDLE_TTL_MS = 30 * 60 * 1000
const MAX_TOUCH_WRITE_CACHE_ENTRIES = 2048

export class InjectCommandHandledError extends Error {
  constructor() {
    super("copilot-inject-handled")
    this.name = "InjectCommandHandledError"
  }
}

export class PolicyScopeCommandHandledError extends Error {
  constructor() {
    super("copilot-policy-scope-handled")
    this.name = "PolicyScopeCommandHandledError"
  }
}

type RetryStoreContext = {
  networkRetryEnabled?: boolean
  lastAccountSwitchAt?: number
  syntheticAgentInitiatorEnabled?: boolean
}

type DebugPart = {
  type?: unknown
  text?: unknown
  synthetic?: unknown
}

type DebugSessionMessage = {
  info?: {
    id?: string
    role?: string
  }
  parentID?: string
  summary?: boolean
  finish?: string
  parts?: Array<DebugPart>
}

type SessionGetResponse = {
  data?: {
    parentID?: unknown
  }
}

function isDebugEnabled() {
  return process.env.OPENCODE_COPILOT_RETRY_DEBUG === "1"
}

function normalizePreview(value: string, limit = 80) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit)
}

function toPartTypeList(parts: Array<DebugPart> | undefined) {
  return (parts ?? []).map((part) => (typeof part?.type === "string" ? part.type : "unknown"))
}

function toCurrentMessageTextParts(parts: Array<DebugPart> | undefined) {
  return (parts ?? [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => ({
      synthetic: part.synthetic,
      preview: normalizePreview(String(part.text)),
    }))
}

function debugLog(message: string, details: Record<string, unknown>) {
  if (!isDebugEnabled()) return
  const filePath = process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
  if (!filePath) return
  appendFileSync(filePath, `[copilot-plugin-hooks debug] ${message} ${JSON.stringify(details)}\n`)
}

function readRetryStoreContext(store: StoreFile | undefined): RetryStoreContext | undefined {
  if (!store) return undefined

  const maybeLastAccountSwitchAt = (store as StoreFile & { lastAccountSwitchAt?: unknown }).lastAccountSwitchAt
  return {
    networkRetryEnabled: store.networkRetryEnabled,
    lastAccountSwitchAt: typeof maybeLastAccountSwitchAt === "number" ? maybeLastAccountSwitchAt : undefined,
    syntheticAgentInitiatorEnabled: store.syntheticAgentInitiatorEnabled === true,
  }
}

function areExperimentalSlashCommandsEnabled(store: StoreFile | undefined) {
  if (store?.experimentalSlashCommandsEnabled === false) return false
  if (store?.experimentalStatusSlashCommandEnabled === false) return false
  return true
}

async function readRequestBody(request: Request | URL | string, init?: RequestInit) {
  if (typeof init?.body === "string") return init.body
  if (request instanceof Request) return request.clone().text().catch(() => undefined)
  return undefined
}

async function readRequestModelID(request: Request | URL | string, init?: RequestInit) {
  const raw = await readRequestBody(request, init)
  if (!raw) return undefined

  try {
    const body = JSON.parse(raw) as { model?: unknown }
    return typeof body.model === "string" && body.model.length > 0 ? body.model : undefined
  } catch {
    return undefined
  }
}

function rewriteRequestForAccount(request: Request | URL | string, enterpriseUrl?: string) {
  const nextBase = enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"

  try {
    const current = new URL(request instanceof Request ? request.url : request.toString())
    const target = new URL(nextBase)
    if (current.origin === target.origin) return request
    current.protocol = target.protocol
    current.host = target.host
    if (request instanceof Request) return new Request(current, request)
    if (request instanceof URL) return current
    return current.toString()
  } catch {
    return request
  }
}

function mergeAndRewriteRequestHeaders(
  request: Request | URL | string,
  init?: RequestInit,
  rewriteHeaders?: (headers: Headers) => void,
): {
  request: Request | URL | string
  init: RequestInit | undefined
} {
  const hasRequestHeaders = request instanceof Request && [...request.headers].length > 0
  const hasInitHeaders = init?.headers != null && [...new Headers(init.headers)].length > 0
  if (!hasRequestHeaders && !hasInitHeaders && !rewriteHeaders) {
    return {
      request,
      init,
    }
  }

  const headers = new Headers(request instanceof Request ? request.headers : undefined)
  if (init?.headers != null) {
    for (const [name, value] of new Headers(init.headers).entries()) {
      headers.set(name, value)
    }
  }
  rewriteHeaders?.(headers)

  const normalizedInit = init == null ? undefined : { ...init, headers }

  if (request instanceof Request) {
    return {
      request: new Request(request, { headers }),
      init: normalizedInit,
    }
  }

  return {
    request,
    init: normalizedInit ?? { headers },
  }
}

function getMergedRequestHeader(request: Request | URL | string, init: RequestInit | undefined, name: string) {
  const headers = new Headers(request instanceof Request ? request.headers : undefined)
  for (const [headerName, value] of new Headers(init?.headers).entries()) {
    headers.set(headerName, value)
  }
  return headers.get(name)
}

function toLoadMap(value: CandidateAccountLoads | undefined) {
  if (value instanceof Map) return value

  const loads = new Map<string, number>()
  if (!value) return loads
  for (const [name, count] of Object.entries(value)) {
    if (typeof count !== "number" || Number.isFinite(count) === false) continue
    loads.set(name, count)
  }
  return loads
}

function chooseCandidateAccount(input: {
  candidates: ResolvedModelAccountCandidate[]
  sessionID: string
  allowReselect: boolean
  sessionBindings: Map<string, SessionBinding>
  loads: Map<string, number>
}) {
  const ranked = [...input.candidates].sort((a, b) => (input.loads.get(a.name) ?? 0) - (input.loads.get(b.name) ?? 0))
  const lowest = ranked[0]
  const boundName = input.sessionBindings.get(input.sessionID)?.accountName
  const bound = typeof boundName === "string" ? input.candidates.find((item) => item.name === boundName) : undefined

  if (!bound) return lowest
  if (!input.allowReselect) return bound

  const currentLoad = input.loads.get(bound.name) ?? 0
  const minimumLoad = input.loads.get(lowest.name) ?? 0
  if (currentLoad - minimumLoad >= 3) {
    return lowest
  }
  return bound
}

function normalizeStoreForRouting(store: StoreFile) {
  const assignments = (store as StoreFile & {
    modelAccountAssignments?: Record<string, unknown>
  }).modelAccountAssignments
  if (!assignments) return store

  let changed = false
  const normalized: Record<string, string[]> = {}
  for (const [modelID, candidate] of Object.entries(assignments as Record<string, unknown>)) {
    if (Array.isArray(candidate)) {
      normalized[modelID] = candidate
      continue
    }
    if (typeof candidate === "string" && candidate.length > 0) {
      normalized[modelID] = [candidate]
      changed = true
      continue
    }
    changed = true
  }

  if (!changed) return store
  return {
    ...store,
    modelAccountAssignments: normalized,
  }
}

function pruneSessionBindings(bindings: Map<string, SessionBinding>, now: number) {
  for (const [sessionID, binding] of bindings.entries()) {
    if (now - binding.lastUsedAt > SESSION_BINDING_IDLE_TTL_MS) {
      bindings.delete(sessionID)
    }
  }

  if (bindings.size <= MAX_SESSION_BINDINGS) return

  const oldest = [...bindings.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
  for (const [sessionID] of oldest) {
    if (bindings.size <= MAX_SESSION_BINDINGS) break
    bindings.delete(sessionID)
  }
}

function pruneTouchWriteCache(input: {
  cache: Map<string, number>
  now: number
  idleTtlMs: number
  maxEntries: number
}) {
  for (const [key, lastWriteAt] of input.cache.entries()) {
    if (input.now - lastWriteAt > input.idleTtlMs) {
      input.cache.delete(key)
    }
  }

  if (input.cache.size <= input.maxEntries) return

  const oldest = [...input.cache.entries()].sort((a, b) => a[1] - b[1])
  for (const [key] of oldest) {
    if (input.cache.size <= input.maxEntries) break
    input.cache.delete(key)
  }
}

export function buildPluginHooks(input: {
  auth: NonNullable<CopilotPluginHooks["auth"]>
  loadStore?: () => Promise<StoreFile | undefined>
  loadStoreSync?: () => StoreFile | undefined
  writeStore?: (store: StoreFile, meta?: StoreWriteDebugMeta) => Promise<void>
  loadOfficialConfig?: (input: {
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
  }) => Promise<OfficialCopilotConfig | undefined>
  loadOfficialChatHeaders?: (input: { client?: object; directory?: string }) => Promise<OfficialChatHeadersHook>
  createRetryFetch?: (fetch: FetchLike, ctx?: CopilotRetryContext) => FetchLike
  client?: CopilotRetryContext["client"]
  directory?: CopilotRetryContext["directory"]
  serverUrl?: CopilotRetryContext["serverUrl"]
  clearAccountSwitchContext?: (lastAccountSwitchAt?: number) => Promise<void>
  now?: () => number
  refreshQuota?: RefreshQuota
  handleStatusCommandImpl?: StatusCommandHandler
  loadCandidateAccountLoads?: (input: {
    sessionID: string
    modelID?: string
    store: StoreFile
    candidates: ResolvedModelAccountCandidate[]
  }) => Promise<CandidateAccountLoads | undefined>
  routingStateDirectory?: string
  appendSessionTouchEventImpl?: (input: AppendSessionTouchEventInput) => Promise<boolean>
  appendRoutingEventImpl?: (input: { directory: string; event: RoutingEvent }) => Promise<void>
  touchWriteCacheIdleTtlMs?: number
  touchWriteCacheMaxEntries?: number
}): CopilotPluginHooksWithChatHeaders {
  const compactionLoopSafetyBypass = createCompactionLoopSafetyBypass()
  const loadStore = input.loadStore ?? readStoreSafe
  const loadStoreSync = input.loadStoreSync ?? readStoreSafeSync
  const persistStore = (store: StoreFile, meta?: StoreWriteDebugMeta) => {
    if (input.writeStore) return input.writeStore(store, meta)
    return writeStore(store, { debug: meta })
  }
  const refreshQuota = input.refreshQuota ?? ((store: StoreFile) => refreshActiveAccountQuota({ store }))
  const handleStatusCommandImpl = input.handleStatusCommandImpl ?? handleStatusCommand
  const loadOfficialConfig = input.loadOfficialConfig ?? loadOfficialCopilotConfig
  const loadOfficialChatHeaders = input.loadOfficialChatHeaders ?? loadOfficialCopilotChatHeaders
  const createRetryFetch = input.createRetryFetch ?? createCopilotRetryingFetch
  const now = input.now ?? (() => Date.now())
  let injectArmed = false
  let policyScopeOverride: LoopSafetyProviderScope | undefined
  const modelAccountFirstUse = new Set<string>()
  const sessionAccountBindings = new Map<string, SessionBinding>()
  const rateLimitQueues = new Map<string, number[]>()
  const lastTouchWrites = new Map<string, number>()
  const routingDirectory = input.routingStateDirectory ?? routingStatePath()
  const touchWriteCacheIdleTtlMs = input.touchWriteCacheIdleTtlMs ?? TOUCH_WRITE_CACHE_IDLE_TTL_MS
  const touchWriteCacheMaxEntries = input.touchWriteCacheMaxEntries ?? MAX_TOUCH_WRITE_CACHE_ENTRIES
  const appendSessionTouchEventImpl = input.appendSessionTouchEventImpl ?? appendSessionTouchEvent
  const appendRoutingEventImpl = input.appendRoutingEventImpl ?? appendRoutingEvent

  const loadCandidateAccountLoads = input.loadCandidateAccountLoads ?? (async (ctx: {
    candidates: ResolvedModelAccountCandidate[]
  }) => {
    const snapshot = await readRoutingState(routingDirectory)
    return buildCandidateAccountLoads({
      snapshot,
      candidateAccountNames: ctx.candidates.map((item) => item.name),
      now: now(),
    })
  })

  const getPolicyScope = (store: StoreFile | undefined) => getLoopSafetyProviderScope(store, policyScopeOverride)

  const showInjectToast = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    await showStatusToast({
      client: input.client,
      message,
      variant,
      warn: (scope, error) => {
        console.warn(`[${scope}] failed to show toast`, error)
      },
    })
  }

  const lookupSessionAncestry = async (sessionID: string) => {
    const session = await (input.client?.session?.get as undefined | ((input: {
      path: {
        id: string
      }
      query?: {
        directory?: string
      }
      throwOnError?: boolean
    }) => Promise<SessionGetResponse | undefined>))?.({
      path: {
        id: sessionID,
      },
      query: {
        directory: input.directory,
      },
      throwOnError: true,
    })

    return [{
      sessionID,
      parentID: typeof session?.data?.parentID === "string" && session.data.parentID.length > 0
        ? session.data.parentID
        : undefined,
    }]
  }

  const getLatestLastAccountSwitchAt = async () => {
    const store = readRetryStoreContext(await loadStore().catch(() => undefined))
    return store?.lastAccountSwitchAt
  }

  const clearAccountSwitchContext = input.clearAccountSwitchContext ?? (async (capturedLastAccountSwitchAt?: number) => {
    if (capturedLastAccountSwitchAt === undefined) return

    try {
      const latestStore = await loadStore().catch(() => undefined)
      if (!latestStore) return
      if (latestStore.lastAccountSwitchAt !== capturedLastAccountSwitchAt) return
      delete latestStore.lastAccountSwitchAt
      await persistStore(latestStore, {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      })
    } catch (error) {
      console.warn("[plugin-hooks] failed to clear account-switch context", error)
    }
  })

  const loader: AuthLoader = async (getAuth, provider) => {
    const authOverride = new AsyncLocalStorage<CopilotAuthState | undefined>()
    const getScopedAuth = async () => authOverride.getStore() ?? getAuth()
    const config = await loadOfficialConfig({
      getAuth: getScopedAuth as () => Promise<CopilotAuthState | undefined>,
      provider: provider as unknown as CopilotProviderConfig | undefined,
    })
    if (!config) return {}

    const store = await loadStore().catch(() => undefined)
    const retryStore = readRetryStoreContext(store)
    const fetchWithModelAccount = async (request: Request | URL | string, init?: RequestInit) => {
      const latestStoreRaw = await loadStore().catch(() => undefined)
      const latestStore = latestStoreRaw ? normalizeStoreForRouting(latestStoreRaw) : undefined
      const modelID = await readRequestModelID(request, init)
      const requestAt = now()
      pruneSessionBindings(sessionAccountBindings, requestAt)
      pruneTouchWriteCache({
        cache: lastTouchWrites,
        now: requestAt,
        idleTtlMs: touchWriteCacheIdleTtlMs,
        maxEntries: touchWriteCacheMaxEntries,
      })
      const sessionID = getMergedRequestHeader(request, init, "x-opencode-session-id") ?? ""
      const initiator = getMergedRequestHeader(request, init, "x-initiator")
      const allowReselect = initiator === "user"
      const candidates = latestStore ? resolveCopilotModelAccounts(latestStore, modelID) : []
      const loads = latestStore && candidates.length > 0
        ? toLoadMap(await loadCandidateAccountLoads({
          sessionID,
          modelID,
          store: latestStore,
          candidates,
        }).catch(() => undefined))
        : new Map<string, number>()
      const resolved = candidates.length > 0
        ? chooseCandidateAccount({
          candidates,
          sessionID,
          allowReselect,
          sessionBindings: sessionAccountBindings,
          loads,
        })
        : undefined
      if (!resolved) return config.fetch(request, init)

      if (sessionID.length > 0) {
        sessionAccountBindings.set(sessionID, {
          accountName: resolved.name,
          lastUsedAt: requestAt,
        })

        await appendSessionTouchEventImpl({
          directory: routingDirectory,
          accountName: resolved.name,
          sessionID,
          at: requestAt,
          lastTouchWrites,
        }).catch(() => undefined)
      }

      const isFirstUse = modelAccountFirstUse.has(resolved.name) === false
      if (isFirstUse) {
        modelAccountFirstUse.add(resolved.name)
      }

      let nextRequest = request
      let nextInit = init
      if (isFirstUse) {
        const currentInitiator = getMergedRequestHeader(request, init, "x-initiator")
        if (currentInitiator === "agent") {
          const rewritten = mergeAndRewriteRequestHeaders(request, init, (headers) => {
            headers.delete("x-initiator")
          })
          nextRequest = rewritten.request
          nextInit = rewritten.init
        }
      }

      const auth: CopilotAuthState = {
        type: "oauth",
        refresh: resolved.entry.refresh,
        access: resolved.entry.access,
        expires: resolved.entry.expires,
        enterpriseUrl: resolved.entry.enterpriseUrl,
      }

      const response = await authOverride.run(auth, () => config.fetch(
        rewriteRequestForAccount(nextRequest, resolved.entry.enterpriseUrl),
        nextInit,
      ))

      let rateLimitEvidence: { matched: boolean; retryAfterMs?: number } = { matched: false }
      try {
        rateLimitEvidence = await detectRateLimitEvidence(response)
      } catch {
        rateLimitEvidence = { matched: false }
      }
      if (rateLimitEvidence.matched) {
        const existingQueue = rateLimitQueues.get(resolved.name) ?? []
        const cutoff = requestAt - RATE_LIMIT_WINDOW_MS
        const queue = existingQueue.filter((at) => at >= cutoff)
        queue.push(requestAt)
        rateLimitQueues.set(resolved.name, queue)

        if (queue.length === RATE_LIMIT_HIT_THRESHOLD) {
          await appendRoutingEventImpl({
            directory: routingDirectory,
            event: {
              type: "rate-limit-flagged",
              accountName: resolved.name,
              at: requestAt,
              retryAfterMs: rateLimitEvidence.retryAfterMs,
            },
          }).catch(() => undefined)
        }
      }

      return response
    }

    if (retryStore?.networkRetryEnabled !== true) return {
      ...config,
      fetch: fetchWithModelAccount,
    }

    return {
      ...config,
      fetch: createRetryFetch(fetchWithModelAccount, {
        client: input.client,
        directory: input.directory,
        serverUrl: input.serverUrl,
        lastAccountSwitchAt: retryStore.lastAccountSwitchAt,
        notifier: createCopilotRetryNotifier({
          client: input.client,
          lastAccountSwitchAt: retryStore.lastAccountSwitchAt,
          getLastAccountSwitchAt: getLatestLastAccountSwitchAt,
          clearAccountSwitchContext,
          now: input.now,
        }),
        clearAccountSwitchContext: async () => clearAccountSwitchContext(retryStore.lastAccountSwitchAt),
      }),
    }
  }

  const officialChatHeaders = loadOfficialChatHeaders({
    client: input.client,
    directory: input.directory,
  })

  const chatHeaders: ChatHeadersHook = async (hookInput, output) => {
    if (!isCopilotProvider(hookInput.model.providerID)) return
    const headersBeforeOfficial = { ...output.headers }
    await (await officialChatHeaders)(hookInput, output)

    const store = readRetryStoreContext(await loadStore().catch(() => undefined))
    const initiatorBeforeOfficial = headersBeforeOfficial["x-initiator"]
    const initiatorAfterOfficial = output.headers["x-initiator"]
    const officialWroteInitiator = initiatorAfterOfficial !== initiatorBeforeOfficial
    const messageID = hookInput.message.id
    const shouldCheckSyntheticInitiator =
      store?.syntheticAgentInitiatorEnabled === true
      && officialWroteInitiator !== true
      && typeof messageID === "string"
      && messageID.length > 0

    if (shouldCheckSyntheticInitiator) {
      const currentMessage = await (input.client?.session?.message as undefined | ((input: {
        path: {
          id: string
          messageID: string
        }
        query?: {
          directory?: string
        }
        throwOnError?: boolean
      }) => Promise<{ data?: { parts?: Array<DebugPart> } } | undefined>))?.({
        path: {
          id: hookInput.message.sessionID ?? hookInput.sessionID,
          messageID,
        },
        query: {
          directory: input.directory,
        },
        throwOnError: true,
      }).catch(() => undefined)
      const currentParts = Array.isArray(currentMessage?.data?.parts) ? currentMessage.data.parts as Array<DebugPart> : undefined
      const hasSyntheticTextPart = currentParts?.some((part) => part?.type === "text" && part?.synthetic === true) === true

      if (hasSyntheticTextPart) {
        output.headers["x-initiator"] = "agent"
      }
    }

    if (isDebugEnabled()) {
      const currentMessage = await input.client?.session?.message?.({
        path: {
          id: hookInput.message.sessionID ?? hookInput.sessionID,
          messageID: hookInput.message.id,
        },
      }).catch(() => undefined)
      const session = await input.client?.session?.get?.({
        path: {
          id: hookInput.sessionID,
        },
        query: {
          directory: input.directory,
        },
        throwOnError: true,
      }).catch(() => undefined)
      const recentMessages = await input.client?.session?.messages?.({
        path: {
          id: hookInput.sessionID,
        },
      }).catch(() => undefined)
      const currentParts = Array.isArray(currentMessage?.data?.parts) ? currentMessage.data.parts as Array<DebugPart> : []
      const currentTextParts = toCurrentMessageTextParts(currentParts)
      const messageList = (recentMessages?.data ?? []) as Array<DebugSessionMessage>
      const assistantMessages = messageList.filter((message) => message?.info?.role === "assistant")
      const nearestAssistant = assistantMessages[0]

      debugLog("chat.headers evidence", {
        evidence: {
          session_id: hookInput.sessionID,
          message_id: hookInput.message.id,
          message_session_id: hookInput.message.sessionID,
          model_provider_id: hookInput.model.providerID,
          model_api_npm: hookInput.model.api?.npm,
          current_message_part_types: toPartTypeList(currentParts),
          current_message_text_parts: currentTextParts,
          session_parent_id_present: typeof session?.data?.parentID === "string",
          direct_parent_assistant: nearestAssistant
            ? {
                id: nearestAssistant.info?.id,
                summary: nearestAssistant.summary === true,
                finish: nearestAssistant.finish,
              }
            : undefined,
          recent_messages: messageList.slice(0, 4).map((message) => ({
            id: message.info?.id,
            role: message.info?.role,
            parent_id_present: typeof message.parentID === "string",
            summary: message.summary === true,
            finish: message.finish,
            part_types: toPartTypeList(message.parts as Array<DebugPart> | undefined),
          })),
          headers_before_official: headersBeforeOfficial,
          headers_after_official: { ...output.headers },
        },
        candidates: {
          synthetic_text_count: currentTextParts.filter((part) => Boolean(part.synthetic)).length,
          matches_continue_template: currentTextParts.some((part) => /continue/i.test(part.preview)),
          parent_assistant_is_summary: nearestAssistant?.summary === true,
          latest_assistant_is_summary: assistantMessages[0]?.summary === true,
        },
      })
    }
    output.headers["x-opencode-session-id"] = hookInput.sessionID
  }

  return {
    auth: {
      ...input.auth,
      provider: input.auth.provider ?? "github-copilot",
      methods: input.auth.methods,
      loader,
    } as AuthProvider extends never ? never : NonNullable<CopilotPluginHooks["auth"]>,
    config: async (config) => {
      if (!config.command) config.command = {}
      const store = loadStoreSync()
      if (!areExperimentalSlashCommandsEnabled(store)) return
      config.command["copilot-status"] = {
        template: "Show the current GitHub Copilot quota status via the experimental workaround path.",
        description: "Experimental Copilot quota status workaround",
      }
      config.command["copilot-inject"] = {
        template: "Arm an immediate tool-output inject marker flow that drives model to question.",
        description: "Experimental force-intervene hook for Copilot workflows",
      }
      config.command["copilot-policy-all-models"] = {
        template: "Toggle the current OpenCode instance policy injection scope between Copilot-only and all providers/models.",
        description: "Experimental policy scope toggle for all providers",
      }
    },
    "command.execute.before": async (hookInput) => {
      const store = await loadStore().catch(() => undefined)
      if (hookInput.command === "copilot-inject") {
        if (!areExperimentalSlashCommandsEnabled(store)) return
        injectArmed = true
        await showInjectToast("将在模型下次调用工具的时候要求模型立刻调用提问工具", "info")
        throw new InjectCommandHandledError()
      }

      if (hookInput.command === "copilot-policy-all-models") {
        if (!areExperimentalSlashCommandsEnabled(store)) return
        const next = getPolicyScope(store) === "all-models" ? "copilot-only" : "all-models"
        policyScopeOverride = next
        await showInjectToast(
          next === "all-models"
            ? "当前实例已将 policy 注入扩展到所有 provider 和所有模型"
            : "当前实例已恢复为仅对 Copilot provider 注入 policy",
          "info",
        )
        throw new PolicyScopeCommandHandledError()
      }

      if (hookInput.command === "copilot-status") {
        if (!areExperimentalSlashCommandsEnabled(store)) return
        await handleStatusCommandImpl({
          client: input.client,
          loadStore,
          writeStore: persistStore,
          refreshQuota,
        })
      }
    },
    "tool.execute.before": async (hookInput) => {
      if (!injectArmed) return
      if (hookInput.tool !== "question") return
      injectArmed = false
    },
    "tool.execute.after": async (hookInput, output) => {
      if (hookInput.tool === "question") {
        injectArmed = false
        return
      }

      if (!injectArmed) return

      const begin = "[COPILOT_INJECT_V1_BEGIN]"
      const body = "立即调用 question 工具并等待用户指示；在收到用户新指示前，不要继续执行后续任务。"
      const end = "[COPILOT_INJECT_V1_END]"
      const markerBlock = `${begin}\n${body}\n${end}`

      const currentOutput = output.output == null ? "" : String(output.output)
      const hasBegin = currentOutput.includes(begin)
      const hasEnd = currentOutput.includes(end)

      let normalized = currentOutput
      if (hasBegin !== hasEnd) {
        normalized = normalized
          .replace(begin, "")
          .replace(end, "")
          .trimEnd()
      }

      if (normalized.includes(begin) && normalized.includes(end)) {
        output.output = normalized
        return
      }

      output.output = `${normalized}${normalized.length > 0 ? "\n\n" : ""}${markerBlock}`
      await showInjectToast("已要求模型立刻调用提问工具", "warning")
    },
    tool: {
      notify: createNotifyTool({
        client: input.client,
      }),
      wait: createWaitTool(),
    },
    "tool.definition": async (hookInput, output) => {
      if (hookInput.toolID === "question") {
        output.description = "Use for required user response, explicit wait state, final handoff, or any uncertain routing case."
      }
      if (hookInput.toolID === "notify") {
        output.description = "Use for non-blocking progress and phase updates only; do not require immediate user response."
      }
    },
    "chat.headers": chatHeaders,
    "experimental.chat.system.transform": createLoopSafetySystemTransform(
      loadStore,
      compactionLoopSafetyBypass.consume,
      lookupSessionAncestry,
      getPolicyScope,
    ),
    "experimental.session.compacting": compactionLoopSafetyBypass.hook,
  }
}
