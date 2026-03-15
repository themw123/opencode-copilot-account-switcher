import { CopilotAuthPlugin, officialCopilotExportBridge } from "./copilot-plugin.snapshot.js"

export type CopilotAuthState = {
  type: string
  refresh?: string
  access?: string
  expires?: number
  enterpriseUrl?: string
}

export type CopilotProviderModel = {
  id?: string
  api: { url?: string; npm?: string }
  cost?: {
    input: number
    output: number
    cache: {
      read: number
      write: number
    }
  }
}

export type CopilotProviderConfig = {
  models?: Record<string, CopilotProviderModel>
}

export type OfficialCopilotConfig = {
  baseURL?: string
  apiKey: string
  fetch: (request: Request | URL | string, init?: RequestInit) => Promise<Response>
}

export type OfficialChatHeadersHook = (input: {
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

type OfficialHooks = {
  auth?: {
    loader?: (
      getAuth: () => Promise<CopilotAuthState | undefined>,
      provider?: CopilotProviderConfig,
    ) => Promise<OfficialCopilotConfig | Record<string, never>>
  }
  "chat.headers"?: OfficialChatHeadersHook
}

function runWithOfficialBridge<T>(input: {
  baseFetch?: typeof fetch
  version?: string
}, fn: () => Promise<T>): Promise<T> {
  return officialCopilotExportBridge.run({
    fetchImpl: input.baseFetch ?? globalThis.fetch,
    version: input.version,
  }, fn)
}

async function loadOfficialHooks(input: {
  client?: object
  directory?: string
  baseFetch?: typeof fetch
  version?: string
}): Promise<OfficialHooks> {
  return runWithOfficialBridge(input, async () => {
    const hooks = await CopilotAuthPlugin({
      client: input.client,
      directory: input.directory,
    })
    return hooks as OfficialHooks
  })
}

export async function loadOfficialCopilotConfig(input: {
  getAuth: () => Promise<CopilotAuthState | undefined>
  baseFetch?: typeof fetch
  provider?: CopilotProviderConfig
  version?: string
}): Promise<OfficialCopilotConfig | undefined> {
  const hooks = await loadOfficialHooks({
    baseFetch: input.baseFetch,
    version: input.version,
  })
  const loader = hooks.auth?.loader
  if (typeof loader !== "function") {
    return undefined
  }

  const result = await runWithOfficialBridge(input, async () => loader(input.getAuth, input.provider))

  if (!("fetch" in result) || typeof result.fetch !== "function") {
    return undefined
  }

  return {
    baseURL: result.baseURL,
    apiKey: result.apiKey,
    fetch(request, init) {
      return runWithOfficialBridge(input, async () => result.fetch(request, init))
    },
  }
}

export function createOfficialFetchAdapter(input: {
  getAuth: () => Promise<CopilotAuthState | undefined>
  baseFetch?: typeof fetch
  provider?: CopilotProviderConfig
  version?: string
}) {
  return async function fetchWithOfficialHeaders(request: Request | URL | string, init?: RequestInit) {
    const config = await loadOfficialCopilotConfig(input)
    const fallback = input.baseFetch ?? fetch
    if (!config) {
      return fallback(request, init)
    }

    return config.fetch(request, init)
  }
}

export async function loadOfficialCopilotChatHeaders(input: {
  client?: object
  directory?: string
}): Promise<OfficialChatHeadersHook> {
  const hooks = await loadOfficialHooks(input)
  const chatHeaders = hooks["chat.headers"]
  if (typeof chatHeaders !== "function") {
    throw new Error("Official Copilot plugin is missing chat.headers hook")
  }
  return chatHeaders
}
