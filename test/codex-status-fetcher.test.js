import test from "node:test"
import assert from "node:assert/strict"

async function loadCodexStatusFetcherOrFail() {
  try {
    return await import("../dist/codex-status-fetcher.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("codex status fetcher module is missing: ../dist/codex-status-fetcher.js")
    }
    throw error
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("fetches codex usage with Authorization and ChatGPT-Account-Id headers", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()
  const calls = []

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "access_token_1", refresh: "refresh_token_1" },
    accountId: "acct_123",
    now: () => 1700000000000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ account_id: "acct_123" })
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/usage")
  const headers = new Headers(calls[0].init?.headers)
  assert.equal(headers.get("Authorization"), "Bearer access_token_1")
  assert.equal(headers.get("ChatGPT-Account-Id"), "acct_123")
  assert.equal(headers.get("Accept"), "application/json")
  assert.equal(headers.get("User-Agent"), "Codex CLI")
  assert.equal(result.ok, true)
})

test("normalizes real codex usage payload into identity and window snapshots", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const payload = {
    account_id: "acct_from_payload",
    email: "user@example.com",
    plan_type: "team",
    rate_limit: {
      primary_window: {
        used_percent: 38,
        limit_window_seconds: 18000,
        reset_at: 1774134584,
      },
      secondary_window: {
        used_percent: 94,
        limit_window_seconds: 604800,
        reset_at: 1774666375,
      },
    },
  }

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "access_token_1", refresh: "refresh_token_1" },
    accountId: "acct_header",
    now: () => 1700000000000,
    fetchImpl: async () => jsonResponse(payload),
  })

  assert.equal(result.ok, true)
  assert.equal(result.status.identity.accountId, "acct_from_payload")
  assert.equal(result.status.identity.email, "user@example.com")
  assert.equal(result.status.identity.plan, "team")
  assert.equal(result.status.windows.primary.entitlement, 100)
  assert.equal(result.status.windows.primary.remaining, 62)
  assert.equal(result.status.windows.primary.used, 38)
  assert.equal(result.status.windows.primary.resetAt, 1774134584000)
  assert.equal(result.status.windows.secondary.entitlement, 100)
  assert.equal(result.status.windows.secondary.remaining, 6)
  assert.equal(result.status.windows.secondary.used, 94)
  assert.equal(result.status.windows.secondary.resetAt, 1774666375000)
  assert.equal(result.status.credits.total, undefined)
  assert.equal(result.status.credits.remaining, undefined)
  assert.equal(result.status.credits.used, undefined)
  assert.equal(result.status.updatedAt, 1700000000000)
})

test("retries once with refreshed oauth tokens after 401", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()
  const usedTokens = []
  const refreshCalls = []

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "expired_access", refresh: "refresh_token_1" },
    accountId: "acct_123",
    now: () => 1700000000000,
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers)
      usedTokens.push(headers.get("Authorization"))
      if (usedTokens.length === 1) return jsonResponse({ error: "unauthorized" }, 401)
      return jsonResponse({ account_id: "acct_123" }, 200)
    },
    refreshTokens: async (oauth) => {
      refreshCalls.push(oauth)
      return {
        type: "oauth",
        access: "new_access",
        refresh: "new_refresh",
        expires: 123456,
        accountId: "acct_123",
      }
    },
  })

  assert.equal(refreshCalls.length, 1)
  assert.deepEqual(usedTokens, ["Bearer expired_access", "Bearer new_access"])
  assert.deepEqual(result.authPatch, {
    access: "new_access",
    refresh: "new_refresh",
    expires: 123456,
    accountId: "acct_123",
  })
  assert.equal(result.ok, true)
})

test("uses refreshed accountId on retry when caller does not pass accountId", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()
  const accountHeaders = []

  const result = await fetchCodexStatus({
    oauth: {
      type: "oauth",
      access: "expired_access",
      refresh: "refresh_token_1",
      accountId: "acct_old",
    },
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers)
      accountHeaders.push(headers.get("ChatGPT-Account-Id"))
      if (accountHeaders.length === 1) return jsonResponse({ error: "unauthorized" }, 401)
      return jsonResponse({ account_id: "acct_new" }, 200)
    },
    refreshTokens: async () => ({
      type: "oauth",
      access: "new_access",
      refresh: "new_refresh",
      accountId: "acct_new",
    }),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(accountHeaders, ["acct_old", "acct_new"])
})

test("degrades cleanly on 429 timeout 5xx and non-json responses", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const rateLimited = await fetchCodexStatus({
    oauth: { type: "oauth", access: "a", refresh: "r" },
    fetchImpl: async () => jsonResponse({ error: "too_many_requests" }, 429),
  })
  assert.equal(rateLimited.ok, false)
  assert.equal(rateLimited.error.kind, "rate_limited")
  assert.equal(rateLimited.error.status, 429)
  assert.match(rateLimited.error.message, /rate limit/i)

  const timedOut = await fetchCodexStatus({
    oauth: { type: "oauth", access: "a", refresh: "r" },
    fetchImpl: async () => {
      const error = new Error("request timed out")
      error.name = "AbortError"
      throw error
    },
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.error.kind, "timeout")
  assert.match(timedOut.error.message, /timed out|timeout/i)

  const serverError = await fetchCodexStatus({
    oauth: { type: "oauth", access: "a", refresh: "r" },
    fetchImpl: async () => jsonResponse({ error: "server_down" }, 503),
  })
  assert.equal(serverError.ok, false)
  assert.equal(serverError.error.kind, "server_error")
  assert.equal(serverError.error.status, 503)
  assert.match(serverError.error.message, /server/i)

  const nonJson = await fetchCodexStatus({
    oauth: { type: "oauth", access: "a", refresh: "r" },
    fetchImpl: async () =>
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  })
  assert.equal(nonJson.ok, false)
  assert.equal(nonJson.error.kind, "invalid_response")
  assert.match(nonJson.error.message, /json/i)
})

test("returns structured error when token refresh throws", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const resultPromise = fetchCodexStatus({
    oauth: { type: "oauth", access: "expired_access", refresh: "refresh_token_1" },
    fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    refreshTokens: async () => {
      throw new Error("refresh service unavailable")
    },
  })

  await assert.doesNotReject(resultPromise)
  const result = await resultPromise
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, "network_error")
  assert.match(result.error.message, /refresh service unavailable/i)
})

test("returns invalid_account only when refresh token flow reports structured 400", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "expired_access", refresh: "refresh_token_1" },
    fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    refreshTokens: async () => {
      throw {
        kind: "invalid_account",
        status: 400,
        message: "oauth refresh token invalid for account",
      }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.kind, "invalid_account")
  assert.equal(result.error.status, 400)
  assert.match(result.error.message, /invalid/i)
})

test("maps refresh token Error('...400') into invalid_account", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "expired_access", refresh: "refresh_token_1" },
    fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    refreshTokens: async () => {
      throw new Error("Token refresh failed: 400")
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.kind, "invalid_account")
  assert.equal(result.error.status, 400)
  assert.match(result.error.message, /refresh failed: 400/i)
})

test("maps refresh token status=400 object errors into invalid_account", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "expired_access", refresh: "refresh_token_1" },
    fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    refreshTokens: async () => {
      throw {
        status: 400,
        message: "refresh token rejected",
      }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.kind, "invalid_account")
  assert.equal(result.error.status, 400)
  assert.match(result.error.message, /refresh token rejected/i)
})

test("does not map refresh token non-400 errors into invalid_account", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const unauthorizedRefresh = await fetchCodexStatus({
    oauth: { type: "oauth", access: "expired_access", refresh: "refresh_token_1" },
    fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    refreshTokens: async () => {
      throw {
        status: 401,
        message: "refresh unauthorized",
      }
    },
  })
  assert.equal(unauthorizedRefresh.ok, false)
  assert.equal(unauthorizedRefresh.error.kind, "network_error")

  const serverRefresh = await fetchCodexStatus({
    oauth: { type: "oauth", access: "expired_access", refresh: "refresh_token_1" },
    fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    refreshTokens: async () => {
      throw new Error("Token refresh failed: 500")
    },
  })
  assert.equal(serverRefresh.ok, false)
  assert.equal(serverRefresh.error.kind, "network_error")
})

test("keeps normal usage 400 responses as network_error", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "a", refresh: "r" },
    fetchImpl: async () => jsonResponse({ error: "bad_request" }, 400),
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.kind, "network_error")
  assert.match(result.error.message, /status 400/i)
})

test("keeps missing quota fields as undefined instead of fabricating values", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "access", refresh: "refresh" },
    now: () => 1700000000000,
    fetchImpl: async () =>
      jsonResponse({
        account_id: "acct_1",
        windows: {
          primary: {
            remaining: 9,
          },
        },
      }),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.status.windows.primary, {
    entitlement: undefined,
    remaining: 9,
    used: undefined,
    resetAt: undefined,
  })
})

test("aborts hanging codex usage requests and returns timeout", async () => {
  const { fetchCodexStatus } = await loadCodexStatusFetcherOrFail()

  let aborted = false
  const result = await fetchCodexStatus({
    oauth: { type: "oauth", access: "access", refresh: "refresh" },
    timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        aborted = true
        const error = new Error("request timed out")
        error.name = "AbortError"
        reject(error)
        return
      }
      signal?.addEventListener("abort", () => {
        aborted = true
        const error = new Error("request timed out")
        error.name = "AbortError"
        reject(error)
      }, { once: true })
    }),
  })

  assert.equal(aborted, true)
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, "timeout")
  assert.match(result.error.message, /timed out|timeout/i)
})
