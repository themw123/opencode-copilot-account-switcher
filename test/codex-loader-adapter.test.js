import test from "node:test"
import assert from "node:assert/strict"
test("codex loader adapter exports official config and chat headers helpers", async () => {
  const mod = await import("../dist/upstream/codex-loader-adapter.js")

  assert.equal(typeof mod.loadOfficialCodexConfig, "function")
  assert.equal(typeof mod.loadOfficialCodexChatHeaders, "function")
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
