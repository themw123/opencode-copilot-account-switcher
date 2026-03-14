import {
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
import { readStoreSafe, writeStore, type StoreFile } from "./store.js"
import {
  loadOfficialCopilotConfig,
  type CopilotAuthState,
  type CopilotProviderConfig,
  type OfficialCopilotConfig,
} from "./upstream/copilot-loader-adapter.js"

type AuthLoader = NonNullable<CopilotPluginHooks["auth"]>["loader"]
type AuthProvider = Parameters<NonNullable<AuthLoader>>[1]
type ChatHeadersHook = (input: {
  sessionID: string
  agent: string
  model: {
    providerID: string
  }
  provider: {
    source: string
    info: object
    options: object
  }
  message: {
    id: string
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
}

function readRetryStoreContext(store: StoreFile | undefined): RetryStoreContext | undefined {
  if (!store) return undefined

  const maybeLastAccountSwitchAt = (store as StoreFile & { lastAccountSwitchAt?: unknown }).lastAccountSwitchAt
  return {
    networkRetryEnabled: store.networkRetryEnabled,
    lastAccountSwitchAt: typeof maybeLastAccountSwitchAt === "number" ? maybeLastAccountSwitchAt : undefined,
  }
}

export function buildPluginHooks(input: {
  auth: NonNullable<CopilotPluginHooks["auth"]>
  loadStore?: () => Promise<StoreFile | undefined>
  writeStore?: (store: StoreFile) => Promise<void>
  loadOfficialConfig?: (input: {
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
  }) => Promise<OfficialCopilotConfig | undefined>
  createRetryFetch?: (fetch: FetchLike, ctx?: CopilotRetryContext) => FetchLike
  client?: CopilotRetryContext["client"]
  directory?: CopilotRetryContext["directory"]
  serverUrl?: CopilotRetryContext["serverUrl"]
  clearAccountSwitchContext?: (lastAccountSwitchAt?: number) => Promise<void>
  now?: () => number
}): CopilotPluginHooksWithChatHeaders {
  const loadStore = input.loadStore ?? readStoreSafe
  const persistStore = input.writeStore ?? writeStore
  const loadOfficialConfig = input.loadOfficialConfig ?? loadOfficialCopilotConfig
  const createRetryFetch = input.createRetryFetch ?? createCopilotRetryingFetch

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
      await persistStore(latestStore)
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

  const chatHeaders: ChatHeadersHook = async (hookInput, output) => {
    if (!isCopilotProvider(hookInput.model.providerID)) return
    output.headers["x-opencode-session-id"] = hookInput.sessionID
  }

  return {
    auth: {
      ...input.auth,
      provider: input.auth.provider ?? "github-copilot",
      loader,
    } as AuthProvider extends never ? never : NonNullable<CopilotPluginHooks["auth"]>,
    "chat.headers": chatHeaders,
    "experimental.chat.system.transform": createLoopSafetySystemTransform(loadStore),
  }
}
