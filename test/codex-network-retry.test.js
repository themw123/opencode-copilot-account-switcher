import assert from "node:assert/strict"
import test from "node:test"

const AI_ERROR_MARKER = Symbol.for("vercel.ai.error")
const API_CALL_ERROR_MARKER = Symbol.for("vercel.ai.error.AI_APICallError")

function assertRetryableApiCallError(error, { message, statusCode }) {
  assert.equal(error?.name, "AI_APICallError")
  assert.equal(error?.[AI_ERROR_MARKER], true)
  assert.equal(error?.[API_CALL_ERROR_MARKER], true)
  assert.equal(error?.isRetryable, true)
  assert.match(String(error?.message ?? ""), message)
  assert.equal(error?.statusCode, statusCode)
  return true
}

test("codex retry policy only targets codex backend urls", async () => {
  const { createCodexRetryPolicy } = await import(`../dist/retry/codex-policy.js?codex-policy-${Date.now()}`)
  const policy = createCodexRetryPolicy()

  assert.equal(policy.matchesRequest("https://chatgpt.com/backend-api/codex/responses"), true)
  assert.equal(policy.matchesRequest("https://chatgpt.com/backend-api/codex/usage"), true)
  assert.equal(policy.matchesRequest("https://chatgpt.com/backend-api/conversations"), false)
  assert.equal(policy.matchesRequest("https://api.githubcopilot.com/responses"), false)
})

test("normalizes codex transient transport errors into retryable API-call-shaped failures", async () => {
  let attempts = 0
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-transport-${Date.now()}`)
  const wrapped = createCodexRetryingFetch(async () => {
    attempts += 1
    throw new Error("failed to fetch")
  })

  await assert.rejects(
    wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(attempts, 1)
      assertRetryableApiCallError(error, {
        message: /codex retryable error \[transport\]: failed to fetch/i,
        statusCode: undefined,
      })
      return true
    },
  )
})

test("normalizes codex timeout transport errors into retryable API-call-shaped failures", async () => {
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-timeout-${Date.now()}`)
  const wrapped = createCodexRetryingFetch(async () => {
    throw new Error("request timeout while connecting")
  })

  await assert.rejects(
    wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
    }),
    (error) => assertRetryableApiCallError(error, {
      message: /codex retryable error \[transport\]: request timeout while connecting/i,
      statusCode: undefined,
    }),
  )
})

test("does not normalize codex AbortError transport failures", async () => {
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-abort-${Date.now()}`)
  const wrapped = createCodexRetryingFetch(async () => {
    const error = new Error("request aborted")
    error.name = "AbortError"
    throw error
  })

  await assert.rejects(
    wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(error?.name, "AbortError")
      assert.equal(error?.isRetryable, undefined)
      return true
    },
  )
})

test("normalizes codex 429 responses into retryable API-call-shaped failures", async () => {
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-429-${Date.now()}`)
  const wrapped = createCodexRetryingFetch(async () => new Response("too many requests", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  }))

  await assert.rejects(
    wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
    }),
    (error) => assertRetryableApiCallError(error, {
      message: /codex retryable error \[status\]: too many requests|codex retryable error \[status\]: status code 429/i,
      statusCode: 429,
    }),
  )
})

test("normalizes codex 5xx responses into retryable API-call-shaped failures", async () => {
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-5xx-${Date.now()}`)
  const wrapped = createCodexRetryingFetch(async () => new Response("service unavailable", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  }))

  await assert.rejects(
    wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
    }),
    (error) => assertRetryableApiCallError(error, {
      message: /codex retryable error \[status\]: service unavailable|codex retryable error \[status\]: status code 503/i,
      statusCode: 503,
    }),
  )
})

test("does not normalize codex 400 401 403 responses", async () => {
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-non-retry-status-${Date.now()}`)
  const statuses = [400, 401, 403]

  for (const status of statuses) {
    const wrapped = createCodexRetryingFetch(async () => new Response(`status-${status}`, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    }))

    const response = await wrapped("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
    })

    assert.equal(response.status, status)
  }
})

test("does not apply codex retry policy to non-codex urls", async () => {
  let attempts = 0
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-non-target-${Date.now()}`)
  const wrapped = createCodexRetryingFetch(async () => {
    attempts += 1
    throw new Error("failed to fetch")
  })

  await assert.rejects(
    wrapped("https://example.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(attempts, 1)
      assert.equal(error?.name, "Error")
      assert.match(String(error?.message ?? ""), /failed to fetch/i)
      assert.equal(error?.isRetryable, undefined)
      return true
    },
  )
})

test("codex retry fetch does not apply copilot header mutation semantics", async () => {
  const outboundHeaders = []
  const { createCodexRetryingFetch } = await import(`../dist/codex-network-retry.js?codex-no-copilot-semantics-${Date.now()}`)
  const wrapped = createCodexRetryingFetch(async (_request, init) => {
    outboundHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()))
    return new Response("ok", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    })
  })

  await wrapped("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session-id": "session-123",
      "x-opencode-debug-link-id": "debug-link-1",
      "x-initiator": "agent",
    },
    body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }),
  })

  assert.equal(outboundHeaders.length, 1)
  assert.equal(outboundHeaders[0]["x-opencode-session-id"], "session-123")
  assert.equal(outboundHeaders[0]["x-opencode-debug-link-id"], "debug-link-1")
  assert.equal(outboundHeaders[0]["x-initiator"], "agent")
})
