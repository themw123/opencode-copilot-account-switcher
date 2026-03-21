export type NetworkRetryRequest = {
  url: string
  method?: string
  body?: string
  headers?: Record<string, string>
}

export type NetworkRetryClassification = {
  retryable: boolean
  category: string
}

export type NetworkRetryPolicy = {
  matchesRequest: (request: Request | URL | string) => boolean
  classifyFailure: (input: { error: unknown; request: NetworkRetryRequest }) => Promise<NetworkRetryClassification>
  handleResponse?: (input: {
    response: Response
    request: NetworkRetryRequest
  }) => Promise<Response>
  normalizeFailure?: (input: {
    error: unknown
    classification: NetworkRetryClassification
    request: NetworkRetryRequest
  }) => unknown
  buildRepairPlan: (input: { request: NetworkRetryRequest; classification: NetworkRetryClassification }) => Promise<unknown>
}

function toHeaderRecord(headers: RequestInit["headers"] | Headers | undefined) {
  if (!headers) return undefined
  return Object.fromEntries(new Headers(headers).entries())
}

async function tryGetRequestBodyString(request: Request | URL | string, init?: RequestInit) {
  if (typeof init?.body === "string") return init.body
  if (!(request instanceof Request)) return undefined

  try {
    return await request.clone().text()
  } catch {
    return undefined
  }
}

async function toNetworkRetryRequest(request: Request | URL | string, init?: RequestInit): Promise<NetworkRetryRequest> {
  const url = request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)
  const method = init?.method ?? (request instanceof Request ? request.method : undefined)
  const headers = toHeaderRecord(init?.headers) ?? (request instanceof Request ? toHeaderRecord(request.headers) : undefined)
  const body = await tryGetRequestBodyString(request, init)
  return { url, method, headers, body }
}

export function createNetworkRetryEngine(input: { policy: NetworkRetryPolicy }) {
  return function wrapNetworkFetch(baseFetch: (request: Request | URL | string, init?: RequestInit) => Promise<Response>) {
    return async function retryingNetworkFetch(request: Request | URL | string, init?: RequestInit) {
      if (!input.policy.matchesRequest(request)) {
        return baseFetch(request, init)
      }

      const normalizedRequest = await toNetworkRetryRequest(request, init)

      try {
        const response = await baseFetch(request, init)
        if (!input.policy.handleResponse) return response
        return input.policy.handleResponse({
          response,
          request: normalizedRequest,
        })
      } catch (error) {
        const classification = await input.policy.classifyFailure({
          error,
          request: normalizedRequest,
        })
        if (!classification.retryable) throw error

        await input.policy.buildRepairPlan({
          request: normalizedRequest,
          classification,
        })
        if (!input.policy.normalizeFailure) throw error
        throw input.policy.normalizeFailure({
          error,
          classification,
          request: normalizedRequest,
        })
      }
    }
  }
}
