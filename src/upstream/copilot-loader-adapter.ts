import { createOfficialCopilotLoader, createOfficialCopilotChatHeaders } from "./copilot-plugin.snapshot.js"

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

export async function loadOfficialCopilotConfig(input: {
  getAuth: () => Promise<CopilotAuthState | undefined>
  baseFetch?: typeof fetch
  provider?: CopilotProviderConfig
  version?: string
}): Promise<OfficialCopilotConfig | undefined> {
  const loader = createOfficialCopilotLoader({
    fetchImpl: input.baseFetch,
    version: input.version,
  })
  const result = await loader(input.getAuth, input.provider)

  if (!("fetch" in result) || typeof result.fetch !== "function") {
    return undefined
  }

  return {
    baseURL: result.baseURL,
    apiKey: result.apiKey,
    fetch: result.fetch,
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
  return createOfficialCopilotChatHeaders(input)
}
