import test from "node:test"
import assert from "node:assert/strict"
test("codex loader adapter exports official config and chat headers helpers", async () => {
  const mod = await import("../dist/upstream/codex-loader-adapter.js")

  assert.equal(typeof mod.loadOfficialCodexConfig, "function")
  assert.equal(typeof mod.loadOfficialCodexChatHeaders, "function")
  assert.equal(typeof mod.loadOfficialCodexAuthMethods, "function")
})

test("loadOfficialCodexAuthMethods returns snapshot browser/headless/api methods", async () => {
  const { loadOfficialCodexAuthMethods } = await import("../dist/upstream/codex-loader-adapter.js")

  const methods = await loadOfficialCodexAuthMethods()

  assert.equal(Array.isArray(methods), true)
  assert.equal(methods.length, 3)

  assert.equal(methods[0].label, "ChatGPT Pro/Plus (browser)")
  assert.equal(methods[0].type, "oauth")
  assert.equal(typeof methods[0].authorize, "function")

  assert.equal(methods[1].label, "ChatGPT Pro/Plus (headless)")
  assert.equal(methods[1].type, "oauth")
  assert.equal(typeof methods[1].authorize, "function")

  assert.equal(methods[2].label, "Manually enter API Key")
  assert.equal(methods[2].type, "api")
})

test("loadOfficialCodexAuthMethods wraps browser authorize in official bridge", async () => {
  const { loadOfficialCodexAuthMethods } = await import("../dist/upstream/codex-loader-adapter.js")
  const requests = []

  const methods = await loadOfficialCodexAuthMethods({
    version: "browser-version",
    baseFetch: async (input, init) => {
      const url = input instanceof URL ? input.href : input.toString()
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      })

      if (!url.endsWith("/oauth/token")) {
        throw new Error(`Unexpected URL: ${url}`)
      }

      return new Response(JSON.stringify({
        id_token: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0X2Jyb3dzZXIifQ.",
        access_token: "browser-access-token",
        refresh_token: "browser-refresh-token",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  const browserMethod = methods.find((method) => method.label === "ChatGPT Pro/Plus (browser)")
  assert.ok(browserMethod)
  assert.equal(typeof browserMethod.authorize, "function")

  const pending = await browserMethod.authorize()
  assert.match(pending.url, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/
)
  assert.equal(pending.method, "auto")
  assert.equal(typeof pending.callback, "function")

  const callbackUrl = new URL("http://127.0.0.1:1455/auth/callback")
  callbackUrl.searchParams.set("code", "browser-code")
  callbackUrl.searchParams.set("state", new URL(pending.url).searchParams.get("state"))

  const response = await fetch(callbackUrl, { method: "GET" })
  assert.equal(response.status, 200)

  const result = await pending.callback()
  assert.equal(result.type, "success")
  assert.equal(result.refresh, "browser-refresh-token")
  assert.equal(result.access, "browser-access-token")
  assert.equal(result.accountId, "acct_browser")

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "https://auth.openai.com/oauth/token")
  assert.match(requests[0].body ?? "", /code=browser-code/)
})

test("loadOfficialCodexAuthMethods wraps headless authorize and callback in official bridge", async () => {
  const { loadOfficialCodexAuthMethods } = await import("../dist/upstream/codex-loader-adapter.js")
  const observed = []

  const methods = await loadOfficialCodexAuthMethods({
    version: "test-version",
    baseFetch: async (input, init) => {
      const url = input instanceof URL ? input.href : input.toString()
      observed.push({
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      })

      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev-auth-id",
          user_code: "USER-CODE",
          interval: "1",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "auth-code",
          code_verifier: "pkce-verifier",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      if (url.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({
          id_token: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0X2hlYWRsZXNzIn0.",
          access_token: "headless-access-token",
          refresh_token: "headless-refresh-token",
          expires_in: 3600,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      throw new Error(`Unexpected URL: ${url}`)
    },
  })

  const headlessMethod = methods.find((method) => method.label === "ChatGPT Pro/Plus (headless)")
  assert.ok(headlessMethod)
  assert.equal(typeof headlessMethod.authorize, "function")

  const pending = await headlessMethod.authorize()
  assert.equal(pending.url, "https://auth.openai.com/codex/device")
  assert.match(pending.instructions, /USER-CODE/)
  assert.equal(typeof pending.callback, "function")

  const result = await pending.callback()
  assert.equal(result.type, "success")
  assert.equal(result.refresh, "headless-refresh-token")
  assert.equal(result.access, "headless-access-token")
  assert.equal(result.accountId, "acct_headless")

  assert.equal(observed.length, 3)
  assert.equal(observed[0].url, "https://auth.openai.com/api/accounts/deviceauth/usercode")
  assert.equal(observed[1].url, "https://auth.openai.com/api/accounts/deviceauth/token")
  assert.equal(observed[2].url, "https://auth.openai.com/oauth/token")

  assert.equal(observed[0].headers.get("user-agent"), "opencode/test-version")
  assert.equal(observed[1].headers.get("user-agent"), "opencode/test-version")
  assert.equal(observed[2].headers.get("user-agent"), null)
})

test("loadOfficialCodexConfig returns undefined for non oauth auth", async () => {
  const { loadOfficialCodexConfig } = await import("../dist/upstream/codex-loader-adapter.js")

  const result = await loadOfficialCodexConfig({
    getAuth: async () => ({ type: "api" }),
  })

  assert.equal(result, undefined)
})

test("loadOfficialCodexConfig returns fetch config for oauth auth", async () => {
  const { loadOfficialCodexConfig } = await import("../dist/upstream/codex-loader-adapter.js")
  const calls = []

  const result = await loadOfficialCodexConfig({
    getAuth: async () => ({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
      accountId: "acct_123",
    }),
    baseFetch: async (input, init) => {
      calls.push({ input: input instanceof URL ? input.href : input.toString(), headers: new Headers(init?.headers) })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    provider: {
      models: {
        "gpt-5.3-codex": {
          id: "gpt-5.3-codex",
          api: { id: "gpt-5.3-codex", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
          cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
        },
      },
    },
  })

  assert.ok(result)
  assert.equal(result.apiKey, "official-codex-oauth")
  assert.equal(typeof result.fetch, "function")

  await result.fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer stale",
      "x-test": "keep",
    },
    body: JSON.stringify({ model: "gpt-5.3-codex", input: "hi" }),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, "https://chatgpt.com/backend-api/codex/responses")
  assert.equal(calls[0].headers.get("authorization"), "Bearer access-token")
  assert.equal(calls[0].headers.get("chatgpt-account-id"), "acct_123")
  assert.equal(calls[0].headers.get("x-test"), "keep")
})

test("loadOfficialCodexChatHeaders returns official chat headers hook", async () => {
  const { loadOfficialCodexChatHeaders } = await import("../dist/upstream/codex-loader-adapter.js")
  const hook = await loadOfficialCodexChatHeaders()

  const output = { headers: {} }
  await hook({
    sessionID: "session-1",
    model: { providerID: "openai" },
  }, output)

  assert.equal(output.headers.originator, "opencode")
  assert.match(output.headers["User-Agent"], /^opencode\//)
  assert.equal(output.headers.session_id, "session-1")
})
