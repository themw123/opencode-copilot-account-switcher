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
import { readStoreSafe, type StoreFile } from "./store.js"
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

export function buildPluginHooks(input: {
  auth: NonNullable<CopilotPluginHooks["auth"]>
  loadStore?: () => Promise<StoreFile | undefined>
  loadOfficialConfig?: (input: {
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
  }) => Promise<OfficialCopilotConfig | undefined>
  createRetryFetch?: (fetch: FetchLike, ctx?: CopilotRetryContext) => FetchLike
  client?: CopilotRetryContext["client"]
  directory?: CopilotRetryContext["directory"]
  serverUrl?: CopilotRetryContext["serverUrl"]
}): CopilotPluginHooksWithChatHeaders {
  const loadStore = input.loadStore ?? readStoreSafe
  const loadOfficialConfig = input.loadOfficialConfig ?? loadOfficialCopilotConfig
  const createRetryFetch = input.createRetryFetch ?? createCopilotRetryingFetch

  const loader: AuthLoader = async (getAuth, provider) => {
    const config = await loadOfficialConfig({
      getAuth: getAuth as () => Promise<CopilotAuthState | undefined>,
      provider: provider as unknown as CopilotProviderConfig | undefined,
    })
    if (!config) return {}

    const store = await loadStore().catch(() => undefined)
    if (store?.networkRetryEnabled !== true) {
      return config
    }

    return {
      ...config,
      fetch: createRetryFetch(config.fetch, {
        client: input.client,
        directory: input.directory,
        serverUrl: input.serverUrl,
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
