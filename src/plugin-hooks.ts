import { appendFileSync } from "node:fs"
import {
  createCompactionLoopSafetyBypass,
  createLoopSafetySystemTransform,
  isCopilotProvider,
  type CopilotPluginHooks,
} from "./loop-safety-plugin.js"
import {
  createCopilotRetryingFetch,
  type CopilotRetryContext,
  type FetchLike,
} from "./copilot-network-retry.js"
import { createCopilotRetryNotifier } from "./copilot-retry-notifier.js"
import { readStoreSafe, writeStore, type StoreFile, type StoreWriteDebugMeta } from "./store.js"
import {
  loadOfficialCopilotConfig,
  loadOfficialCopilotChatHeaders,
  type CopilotAuthState,
  type CopilotProviderConfig,
  type OfficialCopilotConfig,
  type OfficialChatHeadersHook,
} from "./upstream/copilot-loader-adapter.js"
import { createNotifyTool } from "./notify-tool.js"

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

export function buildPluginHooks(input: {
  auth: NonNullable<CopilotPluginHooks["auth"]>
  loadStore?: () => Promise<StoreFile | undefined>
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
}): CopilotPluginHooksWithChatHeaders {
  const compactionLoopSafetyBypass = createCompactionLoopSafetyBypass()
  const loadStore = input.loadStore ?? readStoreSafe
  const persistStore = input.writeStore ?? writeStore
  const loadOfficialConfig = input.loadOfficialConfig ?? loadOfficialCopilotConfig
  const loadOfficialChatHeaders = input.loadOfficialChatHeaders ?? loadOfficialCopilotChatHeaders
  const createRetryFetch = input.createRetryFetch ?? createCopilotRetryingFetch

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
    const config = await loadOfficialConfig({
      getAuth: getAuth as () => Promise<CopilotAuthState | undefined>,
      provider: provider as unknown as CopilotProviderConfig | undefined,
    })
    if (!config) return {}

    const store = readRetryStoreContext(await loadStore().catch(() => undefined))
    if (store?.networkRetryEnabled !== true) {
      return config
    }

    return {
      ...config,
      fetch: createRetryFetch(config.fetch, {
        client: input.client,
        directory: input.directory,
        serverUrl: input.serverUrl,
        lastAccountSwitchAt: store.lastAccountSwitchAt,
        notifier: createCopilotRetryNotifier({
          client: input.client,
          lastAccountSwitchAt: store.lastAccountSwitchAt,
          getLastAccountSwitchAt: getLatestLastAccountSwitchAt,
          clearAccountSwitchContext,
          now: input.now,
        }),
        clearAccountSwitchContext: async () => clearAccountSwitchContext(store.lastAccountSwitchAt),
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
    tool: {
      notify: createNotifyTool({
        client: input.client,
      }),
    },
    "chat.headers": chatHeaders,
    "experimental.chat.system.transform": createLoopSafetySystemTransform(
      loadStore,
      compactionLoopSafetyBypass.consume,
      lookupSessionAncestry,
    ),
    "experimental.session.compacting": compactionLoopSafetyBypass.hook,
  }
}
