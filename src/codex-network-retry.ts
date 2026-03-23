import { createNetworkRetryEngine } from "./network-retry-engine.js"
import { createCodexRetryPolicy } from "./retry/codex-policy.js"

export type FetchLike = (request: Request | URL | string, init?: RequestInit) => Promise<Response>

export function createCodexRetryingFetch(baseFetch: FetchLike) {
  const policy = createCodexRetryPolicy()
  const retryEngine = createNetworkRetryEngine({
    policy,
  })
  return retryEngine(baseFetch)
}
