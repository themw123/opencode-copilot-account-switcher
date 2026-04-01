import { CodexAuthPlugin, officialCodexExportBridge } from "./codex-plugin.snapshot.js"

export type CodexAuthState = {
  type: string
  refresh?: string
  access?: string
  expires?: number
  accountId?: string
}

export type CodexProviderModel = {
  id?: string
  api?: {
    id?: string
    url?: string
    npm?: string
  }
  cost?: {
    input: number
    output: number
    cache: {
      read: number
      write: number
    }
  }
}

export type CodexProviderConfig = {
  models: Record<string, CodexProviderModel>
}

export type OfficialCodexConfig = {
  apiKey: string
  fetch: (request: Request | URL | string, init?: RequestInit) => Promise<Response>
}

export type OfficialCodexChatHeadersHook = (input: {
  sessionID: string
  model: {
    providerID: string
  }
}, output: {
  headers: Record<string, string>
}) => Promise<void>

type OfficialHooks = {
  auth?: {
    loader?: (
      getAuth: () => Promise<CodexAuthState | undefined>,
      provider: CodexProviderConfig,
    ) => Promise<OfficialCodexConfig | Record<string, never>>
    methods?: OfficialCodexAuthMethod[]
  }
  "chat.headers"?: OfficialCodexChatHeadersHook
}

type OfficialCodexAuthResult = {
  type: "success"
  refresh: string
  access: string
  expires: number
  accountId?: string
} | {
  type: "failed"
}

type OfficialCodexAuthorizePending = {
  url: string
  instructions?: string
  method?: string
  callback?: () => Promise<OfficialCodexAuthResult>
}

export type OfficialCodexAuthMethod = {
  label: string
  type: string
  authorize?: () => Promise<OfficialCodexAuthorizePending>
}

function runWithOfficialBridge<T>(input: {
  baseFetch?: typeof fetch
  version?: string
}, fn: () => Promise<T>): Promise<T> {
  return officialCodexExportBridge.run({
    fetchImpl: input.baseFetch ?? globalThis.fetch,
    version: input.version,
  }, fn)
}

async function loadOfficialHooks(input: {
  client?: {
    auth?: {
      set?: (value: unknown) => Promise<unknown>
    }
  }
  baseFetch?: typeof fetch
  version?: string
}): Promise<OfficialHooks> {
  return runWithOfficialBridge(input, async () => {
    const hooks = await CodexAuthPlugin({
      client: input.client,
    })
    return hooks as OfficialHooks
  })
}

export async function loadOfficialCodexAuthMethods(input: {
  client?: {
    auth?: {
      set?: (value: unknown) => Promise<unknown>
    }
  }
  baseFetch?: typeof fetch
  version?: string
} = {}): Promise<OfficialCodexAuthMethod[]> {
  const hooks = await loadOfficialHooks(input)
  const methods = hooks.auth?.methods
  if (!Array.isArray(methods)) {
    return []
  }

  return methods.map((method) => {
    if (typeof method.authorize !== "function") {
      return method
    }

    return {
      ...method,
      authorize: async () => {
        const pending = await runWithOfficialBridge(input, () => method.authorize!())
        if (!pending || typeof pending.callback !== "function") {
          return pending
        }

        return {
          ...pending,
          callback: () => runWithOfficialBridge(input, () => pending.callback!()),
        }
      },
    }
  })
}

export async function loadOfficialCodexConfig(input: {
  getAuth: () => Promise<CodexAuthState | undefined>
  provider?: CodexProviderConfig
  baseFetch?: typeof fetch
  version?: string
  client?: {
    auth?: {
      set?: (value: unknown) => Promise<unknown>
    }
  }
}): Promise<OfficialCodexConfig | undefined> {
  const hooks = await loadOfficialHooks({
    client: input.client,
    baseFetch: input.baseFetch,
    version: input.version,
  })
  const loader = hooks.auth?.loader
  if (typeof loader !== "function") {
    return undefined
  }

  const provider = input.provider ?? { models: {} }
  const result = await runWithOfficialBridge(input, async () => loader(input.getAuth, provider))
  if (!("fetch" in result) || typeof result.fetch !== "function") {
    return undefined
  }

  return {
    apiKey: result.apiKey,
    fetch(request, init) {
      return runWithOfficialBridge(input, async () => result.fetch(request, init))
    },
  }
}

export function createOfficialCodexFetchAdapter(input: {
  getAuth: () => Promise<CodexAuthState | undefined>
  provider?: CodexProviderConfig
  baseFetch?: typeof fetch
  version?: string
  client?: {
    auth?: {
      set?: (value: unknown) => Promise<unknown>
    }
  }
}) {
  return async function fetchWithOfficialHeaders(request: Request | URL | string, init?: RequestInit) {
    const config = await loadOfficialCodexConfig(input)
    const fallback = input.baseFetch ?? fetch
    if (!config) {
      return fallback(request, init)
    }

    return config.fetch(request, init)
  }
}

export async function loadOfficialCodexChatHeaders(input: {
  client?: {
    auth?: {
      set?: (value: unknown) => Promise<unknown>
    }
  }
  baseFetch?: typeof fetch
  version?: string
} = {}): Promise<OfficialCodexChatHeadersHook> {
  const hooks = await loadOfficialHooks(input)
  const chatHeaders = hooks["chat.headers"]
  if (typeof chatHeaders !== "function") {
    throw new Error("Official Codex plugin is missing chat.headers hook")
  }
  return async (hookInput, output) => runWithOfficialBridge(input, async () => chatHeaders(hookInput, output))
}
