import { createLoopSafetySystemTransform, type CopilotPluginHooks } from "./loop-safety-plugin.js"
import { createCopilotRetryingFetch } from "./copilot-network-retry.js"
import { readStoreSafe, type StoreFile } from "./store.js"
import {
  loadOfficialCopilotConfig,
  type CopilotAuthState,
  type CopilotProviderConfig,
  type OfficialCopilotConfig,
} from "./upstream/copilot-loader-adapter.js"

type AuthLoader = NonNullable<CopilotPluginHooks["auth"]>["loader"]
type AuthProvider = Parameters<NonNullable<AuthLoader>>[1]

export function buildPluginHooks(input: {
  auth: NonNullable<CopilotPluginHooks["auth"]>
  loadStore?: () => Promise<StoreFile | undefined>
  loadOfficialConfig?: (input: {
    getAuth: () => Promise<CopilotAuthState | undefined>
    provider?: CopilotProviderConfig
  }) => Promise<OfficialCopilotConfig | undefined>
  createRetryFetch?: typeof createCopilotRetryingFetch
}): CopilotPluginHooks {
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
      fetch: createRetryFetch(config.fetch),
    }
  }

  return {
    auth: {
      ...input.auth,
      provider: input.auth.provider ?? "github-copilot",
      loader,
    } as AuthProvider extends never ? never : NonNullable<CopilotPluginHooks["auth"]>,
    "experimental.chat.system.transform": createLoopSafetySystemTransform(loadStore),
  }
}
