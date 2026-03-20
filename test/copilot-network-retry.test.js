import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createOpencodeClient } from "@opencode-ai/sdk"

const AI_ERROR_MARKER = Symbol.for("vercel.ai.error")
const API_CALL_ERROR_MARKER = Symbol.for("vercel.ai.error.AI_APICallError")

function assertRetryableApiCallError(error, { message, statusCode, responseBody }) {
  assert.equal(error.name, "AI_APICallError")
  assert.equal(error[AI_ERROR_MARKER], true)
  assert.equal(error[API_CALL_ERROR_MARKER], true)
  assert.equal(error.isRetryable, true)
  assert.match(error.message, message)
  assert.equal(error.statusCode, statusCode)
  if (responseBody === undefined) {
    assert.equal(error.responseBody, undefined)
  } else {
    assert.match(error.responseBody, responseBody)
  }
  return true
}

function assertWrappedRetryableMessage(error, tag, detail) {
  assert.match(error.message, new RegExp(`^Copilot retryable error \\[${tag}\\]: `, "i"))
  assert.match(error.message, detail)
}

test("normalizes retryable copilot network errors into retryable API-call-shaped failures", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("unknown certificate")
  })

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(attempts, 1)
      assertRetryableApiCallError(error, {
        message: /copilot retryable error \[transport\]: unknown certificate/i,
        statusCode: undefined,
      })
      assertWrappedRetryableMessage(error, "transport", /unknown certificate/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test("normalizes sse read timeout errors for copilot urls into retryable API-call-shaped failures", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("SSE read timed out")
  })

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(attempts, 1)
      assertRetryableApiCallError(error, {
        message: /copilot retryable error \[transport\]: sse read timed out/i,
        statusCode: undefined,
      })
      assertWrappedRetryableMessage(error, "transport", /sse read timed out/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test("normalizes 499 responses into retryable API-call-shaped failures for copilot urls", async () => {
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?status-499-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(async () => new Response("client closed request", {
    status: 499,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  }))

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assertRetryableApiCallError(error, {
        message: /copilot retryable error \[status\]: client closed request|copilot retryable error \[status\]: status code 499/i,
        statusCode: 499,
        responseBody: /client closed request/i,
      })
      assertWrappedRetryableMessage(error, "status", /client closed request|status code 499/i)
      assert.equal(error.responseHeaders["content-type"], "text/plain; charset=utf-8")
      assert.deepEqual(error.requestBodyValues, { messages: [{ role: "user", content: "hi" }] })
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test("preserves 499 API-call fields without rewrapping in catch", async () => {
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?status-499-preserve-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(async () => new Response("failed to fetch", {
    status: 499,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-test": "keep-me",
    },
  }))

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assertRetryableApiCallError(error, {
        message: /copilot retryable error \[status\]: failed to fetch/i,
        statusCode: 499,
        responseBody: /failed to fetch/i,
      })
      assertWrappedRetryableMessage(error, "status", /failed to fetch/i)
      assert.equal(error.responseHeaders["x-test"], "keep-me")
      assert.deepEqual(error.requestBodyValues, { messages: [{ role: "user", content: "hi" }] })
      return true
    },
  )
})

test("normalizes sse stream read timeout failures after the response starts streaming", async () => {
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?sse-stream-timeout-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(async () => {
    let sent = false
    const body = new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
          return
        }
        controller.error(new Error("SSE read timed out"))
      },
    })

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })

  await assert.rejects(
    response.text(),
    (error) => {
      assertRetryableApiCallError(error, {
        message: /copilot retryable error \[stream\]: sse read timed out/i,
        statusCode: 200,
      })
      assertWrappedRetryableMessage(error, "stream", /sse read timed out/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test("detects rate limit from semantic evidence including retry-after and too_many_requests payloads", async () => {
  const { detectRateLimitEvidence } = await import("../dist/copilot-network-retry.js")

  const fromStatus429 = await detectRateLimitEvidence(
    new Response("too many", {
      status: 429,
      headers: {
        "retry-after": "12",
      },
    }),
  )
  assert.equal(fromStatus429.matched, true)
  assert.equal(fromStatus429.retryAfterMs, 12_000)

  const fromTooManyRequestsPayload = await detectRateLimitEvidence(
    new Response(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }), {
      status: 400,
      headers: {
        "content-type": "application/json",
        "retry-after-ms": "2500",
      },
    }),
  )
  assert.equal(fromTooManyRequestsPayload.matched, true)
  assert.equal(fromTooManyRequestsPayload.retryAfterMs, 2_500)

  const fromRateLimitCode = await detectRateLimitEvidence(
    new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
      status: 400,
      headers: {
        "content-type": "application/json",
      },
    }),
  )
  assert.equal(fromRateLimitCode.matched, true)
})

test("does not match rate-limit payload evidence on successful responses", async () => {
  const { detectRateLimitEvidence } = await import("../dist/copilot-network-retry.js")

  const successTooManyRequests = await detectRateLimitEvidence(
    new Response(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  )
  assert.equal(successTooManyRequests.matched, false)

  const successRateLimitCode = await detectRateLimitEvidence(
    new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), {
      status: 201,
      headers: {
        "content-type": "application/json",
      },
    }),
  )
  assert.equal(successRateLimitCode.matched, false)
})

test("detects rate limit from retry-after headers even when status is not 429", async () => {
  const { detectRateLimitEvidence } = await import("../dist/copilot-network-retry.js")

  const fromRetryAfterHeader = await detectRateLimitEvidence(
    new Response("slow down", {
      status: 409,
      headers: {
        "retry-after": "7",
      },
    }),
  )

  assert.equal(fromRetryAfterHeader.matched, true)
  assert.equal(fromRetryAfterHeader.retryAfterMs, 7_000)
})

test("does not treat bare 429 without semantic evidence as a rate-limit type", async () => {
  const { detectRateLimitEvidence } = await import("../dist/copilot-network-retry.js")

  const bare429 = await detectRateLimitEvidence(
    new Response("upstream error", {
      status: 429,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    }),
  )

  assert.equal(bare429.matched, false)
  assert.equal(bare429.retryAfterMs, undefined)
})

test("normalizes unable to connect errors for copilot urls", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("Unable to connect. Is the computer able to access the url?")
  })

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(attempts, 1)
      assertRetryableApiCallError(error, {
        message: /copilot retryable error \[transport\]: unable to connect/i,
        statusCode: undefined,
      })
      assertWrappedRetryableMessage(error, "transport", /unable to connect/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test("normalizes retryable errors for copilot hosts even on non-whitelisted paths", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("unknown certificate verification error")
  })

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/internal/test-endpoint", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(attempts, 1)
      assertRetryableApiCallError(error, {
        message: /copilot retryable error \[transport\]: unknown certificate verification error/i,
        statusCode: undefined,
      })
      assertWrappedRetryableMessage(error, "transport", /unknown certificate verification error/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test("does not normalize transient errors for non copilot urls", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("failed to fetch")
  })

  await assert.rejects(
    wrapped("https://example.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(error.code, undefined)
      assert.match(error.message, /failed to fetch/i)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test("does not normalize urls that only contain githubcopilot.com as a substring", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("failed to fetch")
  })

  await assert.rejects(
    wrapped("https://notgithubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(error.code, undefined)
      assert.match(error.message, /failed to fetch/i)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test("does not normalize non transient errors", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("bad credentials")
  })

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(error.code, undefined)
      assert.match(error.message, /bad credentials/i)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test("does not normalize abort errors", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    const error = new Error("The operation was aborted")
    error.name = "AbortError"
    throw error
  })

  await assert.rejects(
    wrapped("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    (error) => {
      assert.equal(error.name, "AbortError")
      assert.equal(error.code, undefined)
      assert.match(error.message, /aborted/i)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test("normalizes retryable request errors without replaying consumed request bodies", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const request = new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })
  await request.text()

  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("failed to fetch")
  })

  await assert.rejects(wrapped(request), (error) => {
    assertRetryableApiCallError(error, {
      message: /copilot retryable error \[transport\]: failed to fetch/i,
      statusCode: undefined,
    })
    assertWrappedRetryableMessage(error, "transport", /failed to fetch/i)
    return true
  })
  assert.equal(attempts, 1)
})

test("normalizes retryable request-object errors on the first failure", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const request = new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    throw new Error("failed to fetch")
  })

  await assert.rejects(wrapped(request), (error) => {
    assertRetryableApiCallError(error, {
      message: /copilot retryable error \[transport\]: failed to fetch/i,
      statusCode: undefined,
    })
    assertWrappedRetryableMessage(error, "transport", /failed to fetch/i)
    return true
  })
  assert.equal(attempts, 1)
})

test("only strips the targeted failing input id instead of all long ids", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const originalBody = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "a" }],
        id: "x".repeat(200),
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "b" }],
        id: "x".repeat(408),
      },
    ],
    previous_response_id: "resp_123",
  }

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalBody),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input[1].id.length, 200)
  assert.equal(calls[0].input[2].id.length, 408)
  assert.equal(calls[1].input[1].id.length, 200)
  assert.equal(calls[1].input[2].id, undefined)
  assert.equal(calls[1].previous_response_id, "resp_123")
})

test("does not treat server input index as direct payload array index", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(
        "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 200 instead.",
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const body = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "large" }], id: "z".repeat(408) },
      { role: "assistant", content: [{ type: "output_text", text: "target" }], id: "y".repeat(200) },
      { role: "assistant", content: [{ type: "output_text", text: "tail" }], id: "short-id" },
    ],
  }

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id.length, 408)
  assert.equal(calls[1].input[2].id, undefined)
  assert.equal(calls[1].input[3].id, "short-id")
})

test("uses server-reported input index to disambiguate same-length long ids", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(
        "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 200 instead.",
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "a".repeat(200) },
        { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "b".repeat(200) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, "a".repeat(200))
  assert.equal(calls[1].input[2].id, undefined)
})

test("uses server-reported input index as a candidate hint instead of direct payload indexing", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(
        "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 200 instead.",
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "a".repeat(200) },
        { role: "assistant", content: [{ type: "output_text", text: "short" }], id: "short-id" },
        { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "b".repeat(200) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, "a".repeat(200))
  assert.equal(calls[1].input[2].id, "short-id")
  assert.equal(calls[1].input[3].id, undefined)
})

test("retries when reported length uniquely identifies the failing id without a server input index", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(
        "Invalid input id: string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "keep" }], id: "a".repeat(200) },
        { role: "assistant", content: [{ type: "output_text", text: "drop" }], id: "z".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id.length, 200)
  assert.equal(calls[1].input[2].id, undefined)
})

test("retries when only one long-id candidate exists without a server input index", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response("Invalid input id: string too long.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "only" }], id: "z".repeat(408) },
      ],
      previous_response_id: "resp_123",
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
  assert.equal(calls[1].previous_response_id, "resp_123")
})

test("does not retry when reported length matches no local long-id candidates", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    return new Response(
      "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 999 instead.",
      {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    )
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "only" }], id: "z".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 400)
  assert.equal(attempts, 1)
})

function getDebugEntries(logFile, fragment) {
  return readFile(logFile, "utf8").then((log) =>
    log
      .split("\n")
      .filter((line) => line.includes(fragment) && line.includes("{"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{")))),
  )
}

test("retry debug header logs wrapper before/after headers and strips debug link before network", async () => {
  const logFile = join(tmpdir(), `copilot-retry-debug-link-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    const outgoing = []
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?debug-link-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(async (_request, init) => {
      outgoing.push(Object.fromEntries(new Headers(init?.headers).entries()))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-opencode-session-id": "session-123",
        "x-opencode-debug-link-id": "debug-link-1",
        "x-initiator": "agent",
      }),
      body: JSON.stringify({
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    })

    assert.equal(outgoing.length, 1)
    assert.equal(outgoing[0]["x-opencode-session-id"], undefined)
    assert.equal(outgoing[0]["x-opencode-debug-link-id"], undefined)
    assert.equal(outgoing[0]["x-initiator"], "agent")

    const beforeEntries = await getDebugEntries(logFile, "fetch headers before wrapper")
    const afterEntries = await getDebugEntries(logFile, "fetch headers after wrapper")
    const networkEntries = await getDebugEntries(logFile, "fetch headers before network")

    assert.equal(beforeEntries.length, 1)
    assert.equal(afterEntries.length, 1)
    assert.equal(networkEntries.length, 1)
    assert.equal(beforeEntries[0].isRetry, false)
    assert.equal(afterEntries[0].isRetry, false)
    assert.equal(networkEntries[0].isRetry, false)
    assert.equal(beforeEntries[0].headers["x-opencode-debug-link-id"], "debug-link-1")
    assert.equal(afterEntries[0].headers["x-opencode-debug-link-id"], undefined)
    assert.equal(afterEntries[0].headers["x-opencode-session-id"], undefined)
    assert.deepEqual(afterEntries[0].removedInternalHeaders.sort(), ["x-opencode-debug-link-id", "x-opencode-session-id"])
    assert.equal(networkEntries[0].headers["x-opencode-debug-link-id"], undefined)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("stops with evidence-insufficient when missing server index leaves multiple candidates", async () => {
  const logFile = join(tmpdir(), `copilot-retry-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    let attempts = 0
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?evidence-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(async () => {
      attempts += 1
      return new Response(
        "Invalid input id: string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    })

    const response = await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "x".repeat(408) },
          { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "y".repeat(300) },
          { role: "assistant", content: [{ type: "output_text", text: "third" }], id: "z".repeat(300) },
        ],
      }),
    })

    assert.equal(response.status, 400)
    assert.equal(attempts, 1)

    const entries = await getDebugEntries(logFile, "cleanup-stopped")
    assert.equal(entries.length, 1)
    assert.equal(entries[0].reason, "evidence-insufficient")
    assert.equal(entries[0].candidateCount, 2)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("stops when too-long responses continue after local candidates are exhausted", async () => {
  const logFile = join(tmpdir(), `copilot-retry-exhausted-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    let attempts = 0
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?exhausted-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(async () => {
      attempts += 1
      return new Response(
        "Invalid input id: string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    })

    const response = await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "only" }], id: "x".repeat(408) },
        ],
      }),
    })

    assert.equal(response.status, 400)
    assert.equal(attempts, 2)

    const entries = await getDebugEntries(logFile, "cleanup-stopped")
    assert.equal(entries.length, 1)
    assert.equal(entries[0].reason, "local-candidates-exhausted")
    assert.equal(entries[0].attempt, 1)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("repairs the uniquely matched session part after a too-long input id 400", async () => {
  const calls = []
  const sessionReads = []
  const patchCalls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)

      if (calls.length === 1) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        )
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async ({ path }) => {
            sessionReads.push(path)
            return {
              data: [
                {
                  info: { id: "msg_1", role: "assistant" },
                  parts: [
                    {
                      id: "part_1",
                      messageID: "msg_1",
                      sessionID: "sess-123",
                      type: "text",
                      text: "hi",
                      metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                    },
                  ],
                },
              ],
            }
          },
          message: async ({ path }) => ({
            data: {
              info: { id: path.messageID, role: "assistant" },
              parts: [
                {
                  id: "part_1",
                  messageID: path.messageID,
                  sessionID: path.id,
                  type: "text",
                  text: "hi",
                  metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                },
              ],
            },
          }),
        },
      },
      patchPart: async (request) => {
        patchCalls.push(request)
        return { ok: true }
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(sessionReads, [{ id: "sess-123" }])
  assert.equal(patchCalls.length, 1)
  assert.equal(patchCalls[0].url, "http://localhost:4096/session/sess-123/message/msg_1/part/part_1?directory=C%3A%2Frepo")
  assert.equal(patchCalls[0].init.method, "PATCH")
  assert.equal(new Headers(patchCalls[0].init.headers).get("content-type"), "application/json")
  const patchedPart = JSON.parse(String(patchCalls[0].init.body))
  assert.equal(patchedPart.id, "part_1")
  assert.equal(patchedPart.messageID, "msg_1")
  assert.equal(patchedPart.sessionID, "sess-123")
  assert.equal(patchedPart.metadata.openai.itemId, undefined)
  assert.equal(patchedPart.metadata.openai.keep, true)
  assert.equal(patchedPart.metadata.custom.keep, "value")
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
})

test("bulk strips all input ids and repairs matching session parts when connection mismatch error is returned", async () => {
  const calls = []
  const patchCalls = []
  const messageParts = [
    {
      id: "part_1",
      messageID: "msg_1",
      sessionID: "sess-123",
      type: "text",
      text: "a",
      metadata: { openai: { itemId: "item_a", keep: true }, custom: { keep: "one" } },
    },
    {
      id: "part_2",
      messageID: "msg_1",
      sessionID: "sess-123",
      type: "text",
      text: "b",
      metadata: { openai: { itemId: "item_b", keep: true }, custom: { keep: "two" } },
    },
    {
      id: "part_3",
      messageID: "msg_1",
      sessionID: "sess-123",
      type: "text",
      text: "keep",
      metadata: { openai: { itemId: "item_keep", keep: true }, custom: { keep: "three" } },
    },
  ]
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?connection-mismatch-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)

      if (calls.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "Input item ID does not belong to this connection.",
          },
        }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: messageParts,
              },
            ],
          }),
          message: async () => ({
            data: {
              parts: messageParts,
            },
          }),
        },
      },
      patchPart: async (request) => {
        patchCalls.push(request)
        return { ok: true }
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "item_a" },
        { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "item_b" },
      ],
      previous_response_id: "resp_123",
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input[1].id, "item_a")
  assert.equal(calls[0].input[2].id, "item_b")
  assert.equal(calls[1].input[1].id, undefined)
  assert.equal(calls[1].input[2].id, undefined)
  assert.equal(calls[1].previous_response_id, "resp_123")
  assert.equal(patchCalls.length, 2)

  const patchedParts = patchCalls
    .map((request) => JSON.parse(String(request.init.body)))
    .sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(patchedParts.map((part) => part.id), ["part_1", "part_2"])
  assert.equal(patchedParts[0].metadata.openai.itemId, undefined)
  assert.equal(patchedParts[0].metadata.openai.keep, true)
  assert.equal(patchedParts[0].metadata.custom.keep, "one")
  assert.equal(patchedParts[1].metadata.openai.itemId, undefined)
  assert.equal(patchedParts[1].metadata.openai.keep, true)
  assert.equal(patchedParts[1].metadata.custom.keep, "two")
})

test("bulk strips all input ids for connection mismatch even when session repair fails", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?connection-mismatch-repair-fail-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)

      if (calls.length === 1) {
        return new Response("Input item ID does not belong to this connection.", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "item_a" } } },
                  { id: "part_2", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "b", metadata: { openai: { itemId: "item_b" } } },
                ],
              },
            ],
          }),
          message: async () => ({
            data: {
              parts: [
                { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "item_a" } } },
                { id: "part_2", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "b", metadata: { openai: { itemId: "item_b" } } },
              ],
            },
          }),
        },
      },
      patchPart: async () => {
        throw new TypeError("network failed")
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "item_a" },
        { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "item_b" },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
  assert.equal(calls[1].input[2].id, undefined)
})

test("bulk strips all input ids when connection mismatch message says item with ID", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?connection-mismatch-wording-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: "Input item with ID 'item_a' does not belong to this connection.",
        },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "item_a" },
        { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "item_b" },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
  assert.equal(calls[1].input[2].id, undefined)
})

test("bulk strips all input ids for connection mismatch even when server returns 409", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?connection-mismatch-409-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: "Input item ID does not belong to this connection.",
        },
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "item_a" },
        { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "item_b" },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
  assert.equal(calls[1].input[2].id, undefined)
})

test("repairs the uniquely matched session part through client part.update when no patchPart is provided", async () => {
  const calls = []
  const sessionReads = []
  const partUpdates = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?client-part-update-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)

      if (calls.length === 1) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        )
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async ({ path }) => {
            sessionReads.push(path)
            return {
              data: [
                {
                  info: { id: "msg_1", role: "assistant" },
                  parts: [
                    {
                      id: "part_1",
                      messageID: "msg_1",
                      sessionID: "sess-123",
                      type: "text",
                      text: "hi",
                      metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                    },
                  ],
                },
              ],
            }
          },
          message: async ({ path }) => ({
            data: {
              info: { id: path.messageID, role: "assistant" },
              parts: [
                {
                  id: "part_1",
                  messageID: path.messageID,
                  sessionID: path.id,
                  type: "text",
                  text: "hi",
                  metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                },
              ],
            },
          }),
        },
        part: {
          update: async (request) => {
            partUpdates.push(request)
            return { data: request.part }
          },
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(sessionReads, [{ id: "sess-123" }])
  assert.equal(partUpdates.length, 1)
  assert.equal(partUpdates[0].sessionID, "sess-123")
  assert.equal(partUpdates[0].messageID, "msg_1")
  assert.equal(partUpdates[0].partID, "part_1")
  assert.equal(partUpdates[0].directory, "C:/repo")
  assert.equal(partUpdates[0].part.id, "part_1")
  assert.equal(partUpdates[0].part.messageID, "msg_1")
  assert.equal(partUpdates[0].part.sessionID, "sess-123")
  assert.equal(partUpdates[0].part.metadata.openai.itemId, undefined)
  assert.equal(partUpdates[0].part.metadata.openai.keep, true)
  assert.equal(partUpdates[0].part.metadata.custom.keep, "value")
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
})

test("repairs the uniquely matched session part through client _client.patch when part.update is unavailable", async () => {
  const calls = []
  const sessionReads = []
  const patchCalls = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?client-internal-patch-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)

      if (calls.length === 1) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        )
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async ({ path }) => {
            sessionReads.push(path)
            return {
              data: [
                {
                  info: { id: "msg_1", role: "assistant" },
                  parts: [
                    {
                      id: "part_1",
                      messageID: "msg_1",
                      sessionID: "sess-123",
                      type: "text",
                      text: "hi",
                      metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                    },
                  ],
                },
              ],
            }
          },
          message: async ({ path }) => ({
            data: {
              info: { id: path.messageID, role: "assistant" },
              parts: [
                {
                  id: "part_1",
                  messageID: path.messageID,
                  sessionID: path.id,
                  type: "text",
                  text: "hi",
                  metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                },
              ],
            },
          }),
        },
        _client: {
          patch: async (request) => {
            patchCalls.push(request)
            return { data: JSON.parse(String(request.body ?? "{}")) }
          },
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(sessionReads, [{ id: "sess-123" }])
  assert.equal(patchCalls.length, 1)
  assert.equal(patchCalls[0].url, "/session/{sessionID}/message/{messageID}/part/{partID}")
  assert.deepEqual(patchCalls[0].path, {
    sessionID: "sess-123",
    messageID: "msg_1",
    partID: "part_1",
  })
  assert.equal(patchCalls[0].query.directory, "C:/repo")
  assert.equal(patchCalls[0].headers["Content-Type"], "application/json")
  assert.equal(patchCalls[0].body.id, "part_1")
  assert.equal(patchCalls[0].body.messageID, "msg_1")
  assert.equal(patchCalls[0].body.sessionID, "sess-123")
  assert.equal(patchCalls[0].body.metadata.openai.itemId, undefined)
  assert.equal(patchCalls[0].body.metadata.openai.keep, true)
  assert.equal(patchCalls[0].body.metadata.custom.keep, "value")
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
})

test("real sdk client exposes internal patch transport compatible with persistent repair", async () => {
  const calls = []
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: async (request) => {
      calls.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: request.method === "PATCH" ? await request.clone().json() : undefined,
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  await client.session.messages({
    path: { id: "sess-123" },
  })
  const patch = client._client.patch.bind(client._client)
  await patch({
    url: "/session/{sessionID}/message/{messageID}/part/{partID}",
    path: {
      sessionID: "sess-123",
      messageID: "msg_1",
      partID: "part_1",
    },
    query: {
      directory: "C:/repo",
    },
    body: {
      id: "part_1",
      messageID: "msg_1",
      sessionID: "sess-123",
      type: "text",
      text: "hi",
      metadata: { openai: { keep: true } },
    },
    headers: {
      "Content-Type": "application/json",
    },
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, "GET")
  assert.equal(calls[0].url, "http://localhost:4096/session/sess-123/message")
  assert.equal(calls[1].method, "PATCH")
  assert.equal(calls[1].url, "http://localhost:4096/session/sess-123/message/msg_1/part/part_1?directory=C%3A%2Frepo")
  assert.equal(calls[1].headers["content-type"], "application/json")
  assert.equal(calls[1].body.id, "part_1")
  assert.equal(calls[1].body.metadata.openai.keep, true)
})

test("falls back to targeted payload retry when client part.update fails with a network-style error", async () => {
  const calls = []
  const sessionReads = []
  const partUpdates = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?client-part-update-network-fail-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)

      if (calls.length === 1) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        )
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async ({ path }) => {
            sessionReads.push(path)
            return {
              data: [
                {
                  info: { id: "msg_1", role: "assistant" },
                  parts: [
                    {
                      id: "part_1",
                      messageID: "msg_1",
                      sessionID: "sess-123",
                      type: "text",
                      text: "hi",
                      metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                    },
                  ],
                },
              ],
            }
          },
          message: async ({ path }) => ({
            data: {
              info: { id: path.messageID, role: "assistant" },
              parts: [
                {
                  id: "part_1",
                  messageID: path.messageID,
                  sessionID: path.id,
                  type: "text",
                  text: "hi",
                  metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                },
              ],
            },
          }),
        },
        part: {
          update: async (request) => {
            partUpdates.push(request)
            throw new Error("Unable to connect. Is the computer able to access the url?")
          },
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(sessionReads, [{ id: "sess-123" }])
  assert.equal(partUpdates.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
})

test("falls back to targeted payload retry when client _client.patch fails with a network-style error", async () => {
  const calls = []
  const sessionReads = []
  const patchCalls = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?client-internal-patch-network-fail-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)

      if (calls.length === 1) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        )
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async ({ path }) => {
            sessionReads.push(path)
            return {
              data: [
                {
                  info: { id: "msg_1", role: "assistant" },
                  parts: [
                    {
                      id: "part_1",
                      messageID: "msg_1",
                      sessionID: "sess-123",
                      type: "text",
                      text: "hi",
                      metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                    },
                  ],
                },
              ],
            }
          },
          message: async ({ path }) => ({
            data: {
              info: { id: path.messageID, role: "assistant" },
              parts: [
                {
                  id: "part_1",
                  messageID: path.messageID,
                  sessionID: path.id,
                  type: "text",
                  text: "hi",
                  metadata: { openai: { itemId: "x".repeat(408), keep: true }, custom: { keep: "value" } },
                },
              ],
            },
          }),
        },
        _client: {
          patch: async (request) => {
            patchCalls.push(request)
            throw new Error("Unable to connect. Is the computer able to access the url?")
          },
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(sessionReads, [{ id: "sess-123" }])
  assert.equal(patchCalls.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
})

test("does not patch session when matching part is ambiguous", async () => {
  const patchCalls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1].id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } },
                  { id: "part_2", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "b", metadata: { openai: { itemId: "x".repeat(408) } } },
                ],
              },
            ],
          }),
          message: async () => ({ data: { parts: [] } }),
        },
      },
      patchPart: async (request) => {
        patchCalls.push(request)
        return { ok: true }
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.equal(response.status, 200)
  assert.equal(patchCalls.length, 0)
})

test("does not patch session when no matching part exists", async () => {
  const patchCalls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1].id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "not-it" } } },
                ],
              },
            ],
          }),
          message: async () => ({ data: { parts: [] } }),
        },
      },
      patchPart: async (request) => {
        patchCalls.push(request)
        return { ok: true }
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.equal(response.status, 200)
  assert.equal(patchCalls.length, 0)
})

test("falls back to targeted payload retry when session header is missing", async () => {
  const patchCalls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1].id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      patchPart: async (request) => {
        patchCalls.push(request)
        return { ok: true }
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.equal(response.status, 200)
  assert.equal(patchCalls.length, 0)
})

test("falls back to targeted payload retry when session patch route returns 404", async () => {
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1].id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({ data: [{ info: { id: "msg_1", role: "assistant" }, parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] }] }),
          message: async () => ({ data: { parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] } }),
        },
      },
      patchPart: async () => {
        throw new Error("404")
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.equal(response.status, 200)
})

test("falls back to targeted payload retry when session patch route returns 405", async () => {
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1].id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({ data: [{ info: { id: "msg_1", role: "assistant" }, parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] }] }),
          message: async () => ({ data: { parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] } }),
        },
      },
      patchPart: async () => {
        const error = new Error("405")
        throw error
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.equal(response.status, 200)
})

test("falls back to targeted payload retry when session patch request fails before reaching route", async () => {
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1].id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({ data: [{ info: { id: "msg_1", role: "assistant" }, parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] }] }),
          message: async () => ({ data: { parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] } }),
        },
      },
      patchPart: async () => {
        throw new TypeError("network failed")
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.equal(response.status, 200)
})

test("falls back to existing targeted cleanup when bulk cleanup cannot patch session state", async () => {
  const calls = []
  const { cleanupLongIdsForAccountSwitch } = await import("../dist/copilot-network-retry.js")

  const payload = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "x".repeat(300) },
      { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "y".repeat(280) },
    ],
  }

  const result = await cleanupLongIdsForAccountSwitch({
    payload,
    bulkCleanup: async () => {
      calls.push("bulk")
      return {
        payload,
        patchedSessionState: false,
        changed: false,
      }
    },
    targetedCleanup: async (input) => {
      calls.push("targeted")
      return {
        payload: {
          ...input.payload,
          input: [
            input.payload.input[0],
            { ...input.payload.input[1], id: undefined },
            input.payload.input[2],
          ],
        },
        changed: true,
      }
    },
  })

  assert.deepEqual(calls, ["bulk", "targeted"])
  assert.equal(result.strategy, "targeted-fallback")
  assert.equal(result.payload.input[1].id, undefined)
  assert.equal(result.payload.input[2].id.length, 280)
})

test("repairs multiple too-long input ids one at a time", async () => {
  const calls = []
  const patchedIds = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      calls.push(body)
      const ids = body.input.map((item) => item.id).filter(Boolean)
      if (ids.includes("z".repeat(300))) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      if (ids.includes("x".repeat(408))) {
        return new Response(
          "Invalid 'input[5].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } },
                  { id: "part_2", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "b", metadata: { openai: { itemId: "z".repeat(300) } } },
                ],
              },
            ],
          }),
          message: async () => ({
            data: {
              parts: [
                { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } },
                { id: "part_2", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "b", metadata: { openai: { itemId: "z".repeat(300) } } },
              ],
            },
          }),
        },
      },
      patchPart: async ({ init }) => {
        const part = JSON.parse(String(init.body))
        patchedIds.push(part.id)
        return { ok: true }
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "x".repeat(408) },
        { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "z".repeat(300) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 3)
  const firstRetryIds = calls[1].input.map((item) => item.id)
  const secondRetryIds = calls[2].input.map((item) => item.id)
  assert.equal(firstRetryIds.filter((id) => typeof id === "string").length, 1)
  assert.equal(secondRetryIds.filter((id) => typeof id === "string").length, 0)
  assert.equal(patchedIds.length, 2)
})

test("keeps repairing while remaining long-id candidates still justify more retries", async () => {
  const counts = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    const remainingLongIds = body.input.filter((item) => typeof item.id === "string" && item.id.length > 64)
    counts.push(remainingLongIds.length)

    if (remainingLongIds.length === 0) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(
      `Invalid 'input[${remainingLongIds[0].inputIndex}].id': string too long. Expected a string with maximum length 64, but got a string with length ${remainingLongIds[0].id.length} instead.`,
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    )
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        ...Array.from({ length: 6 }, (_value, index) => ({
          inputIndex: index + 2,
          role: "assistant",
          content: [{ type: "output_text", text: `item-${index}` }],
          id: "x".repeat(200 + index),
        })),
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(counts, [6, 5, 4, 3, 2, 1, 0])
})

test("continues repairing past 64 attempts while long-id candidates keep decreasing", async () => {
  const counts = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    const remainingLongIds = body.input.filter((item) => typeof item.id === "string" && item.id.length > 64)
    counts.push(remainingLongIds.length)

    if (remainingLongIds.length === 0) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(
      `Invalid 'input[${remainingLongIds[0].inputIndex}].id': string too long. Expected a string with maximum length 64, but got a string with length ${remainingLongIds[0].id.length} instead.`,
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    )
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        ...Array.from({ length: 66 }, (_value, index) => ({
          inputIndex: index + 2,
          role: "assistant",
          content: [{ type: "output_text", text: `item-${index}` }],
          id: "x".repeat(200 + index),
        })),
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(counts.length, 67)
  assert.deepEqual(counts.slice(-4), [3, 2, 1, 0])
})

test("stops retrying when the same failing id repeats without effective session change", async () => {
  let attempts = 0
  const patchCalls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async () => {
      attempts += 1
      return new Response(
        "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } },
                ],
              },
            ],
          }),
          message: async () => ({
            data: {
              parts: [
                { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } },
              ],
            },
          }),
        },
      },
      patchPart: async ({ init }) => {
        patchCalls.push(JSON.parse(String(init.body)))
        return { ok: true }
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "x".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 400)
  assert.equal(attempts, 2)
  assert.equal(patchCalls.length, 1)
})

test("stops with evidence-insufficient when server index hint still leaves multiple candidates", async () => {
  const logFile = join(tmpdir(), `copilot-retry-stop-candidates-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    let attempts = 0
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?stop-candidates-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(async () => {
      attempts += 1
      if (attempts > 1) {
        return new Response("unexpected extra retry", { status: 599 })
      }

      return new Response(
        "Invalid 'input[9].id': string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    })

    const response = await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "x".repeat(408) },
          { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "y".repeat(300) },
          { role: "assistant", content: [{ type: "output_text", text: "third" }], id: "z".repeat(300) },
        ],
      }),
    })

    assert.equal(response.status, 400)
    assert.equal(attempts, 1)

    const log = await readFile(logFile, "utf8")
    assert.match(log, /input-id retry cleanup-stopped/)
    assert.match(log, /"reason":"evidence-insufficient"/)
    assert.doesNotMatch(log, /input-id retry progress/)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("keeps retrying when the same server index repeats but candidate count keeps decreasing", async () => {
  const logFile = join(tmpdir(), `copilot-retry-stop-error-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    let attempts = 0
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?stop-error-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(async (_request, init) => {
      attempts += 1
      if (attempts > 3) {
        return new Response("unexpected extra retry", { status: 599 })
      }

      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1]?.id) {
        return new Response(
          "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      if (body.input[2]?.id) {
        return new Response(
          "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 200 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const response = await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "x".repeat(408) },
          { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "y".repeat(200) },
        ],
      }),
    })

    assert.equal(response.status, 200)
    assert.equal(attempts, 3)

    const log = await readFile(logFile, "utf8")
    const progressEntries = log
      .split("\n")
      .filter((line) => line.includes("input-id retry progress"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))))

    assert.equal(progressEntries.length, 1)
    assert.equal(progressEntries[0].stopReason, undefined)
    assert.equal(progressEntries[0].previousServerReportedIndex, 2)
    assert.equal(progressEntries[0].currentServerReportedIndex, 2)
    assert.equal(progressEntries[0].serverIndexChanged, false)
    assert.equal(progressEntries[0].remainingLongIdCandidatesBefore, 2)
    assert.equal(progressEntries[0].remainingLongIdCandidatesAfter, 1)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("stops when the same unresolved server item repeats while other long ids remain", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    const longIds = body.input.filter((item) => typeof item.id === "string" && item.id.length > 64)
    if (longIds.length === 2) {
      return new Response(
        "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    }

    if (longIds.length === 1) {
      return new Response(
        "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "x".repeat(408) },
        { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "y".repeat(300) },
      ],
    }),
  })

  assert.equal(response.status, 400)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
  assert.equal(calls[1].input[2].id.length, 300)
})

test("stops when the same server error repeats after partial progress and another same-length id remains", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    const longIds = body.input.filter((item) => typeof item.id === "string" && item.id.length > 64)
    if (longIds.length >= 1) {
      return new Response(
        "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "x".repeat(408) },
        { role: "assistant", content: [{ type: "output_text", text: "pad" }], id: "short-id" },
        { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "y".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 400)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id, undefined)
  assert.equal(calls[1].input[2].id, "short-id")
  assert.equal(calls[1].input[3].id.length, 408)
})

test("strips internal session header when it arrives via init.headers on the first provider request", async () => {
  const seen = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    seen.push(new Headers(init?.headers))
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  })

  await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [] }),
  })

  assert.equal(seen[0].get("x-opencode-session-id"), null)
})

test("strips internal session header when it arrives via Request.headers on the first provider request", async () => {
  const seen = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (request, init) => {
    seen.push(request instanceof Request ? request.headers.get("x-opencode-session-id") : null)
    seen.push(new Headers(init?.headers).get("x-opencode-session-id"))
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  })

  const request = new Request("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [] }),
  })

  await wrapped(request)

  assert.deepEqual(seen, [null, null])
})

test("strips internal session header from retried provider requests", async () => {
  const seen = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    seen.push(new Headers(init?.headers).get("x-opencode-session-id"))
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (body.input[1]?.id) {
      return new Response(
        "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  })

  await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.deepEqual(seen, [null, null])
})

test("strips internal session header even when session repair falls back after a failed patch", async () => {
  const seen = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      seen.push(new Headers(init?.headers).get("x-opencode-session-id"))
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1]?.id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({ data: [{ info: { id: "msg_1", role: "assistant" }, parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] }] }),
          message: async () => ({ data: { parts: [{ id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } }] } }),
        },
      },
      patchPart: async () => {
        throw new Error("patch failed")
      },
    },
  )

  await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) }] }),
  })

  assert.deepEqual(seen, [null, null])
})

test("keeps session repair failure logs alongside later retry progress logs", async () => {
  const logFile = join(tmpdir(), `copilot-retry-repair-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?repair-failure-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(
      async (_request, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))

        if (body.input[2]?.id) {
          return new Response(
            "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
            { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
          )
        }

        if (body.input[4]?.id) {
          return new Response(
            "Invalid 'input[5].id': string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
            { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
          )
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
      {
        directory: "C:/repo",
        serverUrl: new URL("http://localhost:4096"),
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: { id: "msg_1", role: "assistant" },
                  parts: [
                    { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "a".repeat(408) } } },
                  ],
                },
              ],
            }),
            message: async () => ({
              data: {
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "a".repeat(408) } } },
                ],
              },
            }),
          },
        },
        patchPart: async () => {
          throw new Error("patch failed")
        },
      },
    )

    const response = await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
      body: JSON.stringify({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "pad-1" }], id: "short-1" },
          { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "a".repeat(408) },
          { role: "assistant", content: [{ type: "output_text", text: "pad-2" }], id: "short-2" },
          { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "b".repeat(300) },
        ],
      }),
    })

    assert.equal(response.status, 200)

    const log = await readFile(logFile, "utf8")
    assert.match(log, /input-id retry session repair failed/)
    assert.match(log, /patch failed/)
    assert.match(log, /input-id retry progress/)
    assert.match(log, /"previousServerReportedIndex":3/)
    assert.match(log, /"currentServerReportedIndex":5/)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("writes detailed input-id repair diagnostics when debug logging is enabled", async () => {
  const logFile = join(tmpdir(), `copilot-retry-diagnostics-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?diagnostics-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(
      async (_request, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        if (body.input[1]?.id) {
          return new Response(
            "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
            { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
          )
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
      {
        directory: "C:/repo",
        serverUrl: new URL("http://localhost:4096"),
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: { id: "msg_1", role: "assistant" },
                  parts: [
                    { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408) } } },
                  ],
                },
              ],
            }),
            message: async () => ({
              data: {
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "x".repeat(408), keep: true } } },
                ],
              },
            }),
          },
        },
        patchPart: async () => ({ ok: true }),
      },
    )

    await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
      body: JSON.stringify({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
        ],
      }),
    })

    const log = await readFile(logFile, "utf8")
    assert.match(log, /input-id retry parsed/)
    assert.match(log, /input-id retry payload candidates/)
    assert.match(log, /input-id retry payload target/)
    assert.match(log, /input-id retry session candidates/)
    assert.match(log, /input-id retry session match/)
    assert.match(log, /input-id retry session repair/)
    assert.match(log, /input-id retry response/)
    assert.match(log, /"serverReportedIndex":3/)
    assert.match(log, /"targetedPayloadIndex":1/)
    assert.match(log, /"partID":"part_1"/)
    assert.match(log, /"partType":"text"/)
    assert.match(log, /"idLength":408/)
    assert.match(log, /"idPreview":"x{12}\.\.\."/)
    assert.ok(!log.includes("x".repeat(80)))
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("writes retry progress logs that show server error index changes across attempts", async () => {
  const logFile = join(tmpdir(), `copilot-retry-progress-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?progress-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))

      if (body.input[2]?.id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 200 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      if (body.input[4]?.id) {
        return new Response(
          "Invalid 'input[5].id': string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      if (body.input[6]?.id) {
        return new Response(
          "Invalid 'input[7].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const response = await wrapped("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "assistant", content: [{ type: "output_text", text: "pad-1" }], id: "short-1" },
          { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "a".repeat(200) },
          { role: "assistant", content: [{ type: "output_text", text: "pad-2" }], id: "short-2" },
          { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "b".repeat(300) },
          { role: "assistant", content: [{ type: "output_text", text: "pad-3" }], id: "short-3" },
          { role: "assistant", content: [{ type: "output_text", text: "third" }], id: "c".repeat(408) },
        ],
      }),
    })

    assert.equal(response.status, 200)

    const log = await readFile(logFile, "utf8")
    const progressEntries = log
      .split("\n")
      .filter((line) => line.includes("input-id retry progress"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))))

    assert.equal(progressEntries.length, 2)
    assert.deepEqual(
      progressEntries.map((entry) => ({
        attempt: entry.attempt,
        previousServerReportedIndex: entry.previousServerReportedIndex,
        currentServerReportedIndex: entry.currentServerReportedIndex,
        serverIndexChanged: entry.serverIndexChanged,
        remainingLongIdCandidatesBefore: entry.remainingLongIdCandidatesBefore,
        remainingLongIdCandidatesAfter: entry.remainingLongIdCandidatesAfter,
      })),
      [
        {
          attempt: 1,
          previousServerReportedIndex: 3,
          currentServerReportedIndex: 5,
          serverIndexChanged: true,
          remainingLongIdCandidatesBefore: 3,
          remainingLongIdCandidatesAfter: 2,
        },
        {
          attempt: 2,
          previousServerReportedIndex: 5,
          currentServerReportedIndex: 7,
          serverIndexChanged: true,
          remainingLongIdCandidatesBefore: 2,
          remainingLongIdCandidatesAfter: 1,
        },
      ],
    )
    assert.match(progressEntries[0].previousErrorMessagePreview, /input\[3\]\.id/i)
    assert.match(progressEntries[0].currentErrorMessagePreview, /input\[5\]\.id/i)
    assert.match(progressEntries[1].previousErrorMessagePreview, /input\[5\]\.id/i)
    assert.match(progressEntries[1].currentErrorMessagePreview, /input\[7\]\.id/i)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})

test("retries once when too-long input id error is returned as text/plain", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)

    if (calls.length === 1) {
      return new Response(
        "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const originalBody = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hello" }], id: "short-id" },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "long" }],
        id: "x".repeat(408),
      },
    ],
    previous_response_id: "resp_123",
  }

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalBody),
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input[2].id.length, 408)
  assert.equal(calls[1].input[2].id, undefined)
  assert.equal(calls[1].input[1].id, "short-id")
  assert.equal(calls[1].previous_response_id, "resp_123")
})

test("does not pre-clean long ids before the first provider request when using a Request body", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (request, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : request instanceof Request ? await request.clone().text() : ""
    calls.push(JSON.parse(bodyText))

    return new Response(
      JSON.stringify({
        error: {
          message:
            "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
        },
      }),
      {
        status: calls.length === 1 ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })

  const request = new Request("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "keep" }], id: "a".repeat(200) },
        { role: "assistant", content: [{ type: "output_text", text: "drop" }], id: "b".repeat(408) },
      ],
    }),
  })

  const response = await wrapped(request)

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input[1].id.length, 200)
  assert.equal(calls[0].input[2].id.length, 408)
})

test("single retry with a Request body only clears the targeted long id", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (request, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : request instanceof Request ? await request.clone().text() : ""
    const body = JSON.parse(bodyText)
    calls.push(body)

    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const request = new Request("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "keep" }], id: "a".repeat(200) },
        { role: "assistant", content: [{ type: "output_text", text: "drop" }], id: "b".repeat(408) },
      ],
      previous_response_id: "resp_123",
    }),
  })

  const response = await wrapped(request)

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input[1].id.length, 200)
  assert.equal(calls[1].input[2].id, undefined)
  assert.equal(calls[1].previous_response_id, "resp_123")
})

test("retries Request-body cleanup after the first provider call consumes the original request body", async () => {
  const calls = []
  const { createCopilotRetryingFetch } = await import("../dist/copilot-network-retry.js")
  const wrapped = createCopilotRetryingFetch(async (request, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : request instanceof Request ? await request.text() : ""
    calls.push(JSON.parse(bodyText))

    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  const request = new Request("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "keep" }], id: "a".repeat(200) },
        { role: "assistant", content: [{ type: "output_text", text: "drop" }], id: "b".repeat(408) },
      ],
    }),
  })

  const response = await wrapped(request)

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input[1].id.length, 200)
  assert.equal(calls[0].input[2].id.length, 408)
  assert.equal(calls[1].input[1].id.length, 200)
  assert.equal(calls[1].input[2].id, undefined)
})

test("fails open for connection mismatch when the original Request body was already consumed before wrapper entry", async () => {
  let attempts = 0
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?connection-mismatch-consumed-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(async (request, init) => {
    attempts += 1
    if (attempts > 1) {
      assert.fail("should not retry consumed request bodies before wrapper entry")
    }

    return new Response(JSON.stringify({
      error: {
        message: "Input item ID does not belong to this connection.",
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  })

  const request = new Request("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "item_a" },
        { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "item_b" },
      ],
      previous_response_id: "resp_123",
    }),
  })
  await request.text()

  const response = await wrapped(request)

  assert.equal(response.status, 400)
  assert.equal(attempts, 1)
})

test("retry notifier sends toast through client.tui.showToast", async () => {
  const calls = []
  const { ACCOUNT_SWITCH_TTL_MS, createCopilotRetryNotifier } = await import("../dist/copilot-retry-notifier.js")
  const notifier = createCopilotRetryNotifier({
    client: {
      tui: {
        showToast: async (options) => {
          calls.push(options)
          return { data: true }
        },
      },
    },
    lastAccountSwitchAt: 1_000,
    now: () => 1_000 + ACCOUNT_SWITCH_TTL_MS - 1,
  })
  const fallbackNotifier = createCopilotRetryNotifier({
    client: {
      tui: {
        showToast: async (options) => {
          calls.push(options)
          return { data: true }
        },
      },
    },
    lastAccountSwitchAt: 1_000,
    now: () => 1_000 + ACCOUNT_SWITCH_TTL_MS,
  })

  assert.equal(typeof notifier.started, "function")
  assert.equal(typeof notifier.progress, "function")
  assert.equal(typeof notifier.repairWarning, "function")
  assert.equal(typeof notifier.completed, "function")
  assert.equal(typeof notifier.stopped, "function")

  await notifier.started({ remaining: 3 })
  await notifier.progress({ remaining: 2 })
  await notifier.repairWarning({ remaining: 1 })
  await notifier.completed({ remaining: 0 })
  await notifier.stopped({ remaining: 4 })
  await fallbackNotifier.started({ remaining: 5 })

  assert.equal(calls.length, 6)
  assert.deepEqual(
    calls.map((call) => call.query),
    [undefined, undefined, undefined, undefined, undefined, undefined],
  )
  assert.deepEqual(
    calls.map((call) => call.body.variant),
    ["info", "info", "warning", "success", "warning", "info"],
  )
  assert.match(calls[0].body.message, /可能因账号切换遗留的非法输入 ID/)
  assert.match(calls[0].body.message, /剩余 3 项/)
  assert.match(calls[1].body.message, /剩余 2 项/)
  assert.match(calls[2].body.message, /剩余 1 项/)
  assert.match(calls[3].body.message, /剩余 0 项/)
  assert.match(calls[4].body.message, /剩余 4 项/)
  assert.match(calls[5].body.message, /可能因账号切换遗留的非法输入 ID/)
  assert.match(calls[5].body.message, /剩余 5 项/)
})

test("retry notifier completed clears the dynamically resolved account switch context", async () => {
  const clearCalls = []
  const { createCopilotRetryNotifier } = await import(`../dist/copilot-retry-notifier.js?completed-clear-${Date.now()}`)
  const notifier = createCopilotRetryNotifier({
    getLastAccountSwitchAt: () => 1_717_171_717_171,
    clearAccountSwitchContext: async (lastAccountSwitchAt) => {
      clearCalls.push(lastAccountSwitchAt)
    },
  })

  await notifier.completed({ remaining: 0 })

  assert.deepEqual(clearCalls, [1_717_171_717_171])
})

test("retry notifier stopped clears the dynamically resolved account switch context", async () => {
  const clearCalls = []
  const { createCopilotRetryNotifier } = await import(`../dist/copilot-retry-notifier.js?stopped-clear-${Date.now()}`)
  const notifier = createCopilotRetryNotifier({
    getLastAccountSwitchAt: () => 1_717_171_727_272,
    clearAccountSwitchContext: async (lastAccountSwitchAt) => {
      clearCalls.push(lastAccountSwitchAt)
    },
  })

  await notifier.stopped({ remaining: 1 })

  assert.deepEqual(clearCalls, [1_717_171_727_272])
})

test("retry notifier swallows toast delivery failures", async () => {
  const { createCopilotRetryNotifier } = await import(`../dist/copilot-retry-notifier.js?swallow-${Date.now()}`)
  const notifier = createCopilotRetryNotifier({
    client: {
      tui: {
        showToast: async () => {
          throw new Error("toast failed")
        },
      },
    },
  })

  await notifier.started({ remaining: 2 })
  await notifier.progress({ remaining: 1 })
  await notifier.repairWarning({ remaining: 1 })
  await notifier.completed({ remaining: 0 })
  await notifier.stopped({ remaining: 1 })
})

test("retry wrapper only consumes notifier interface instead of raw toast sdk details", async () => {
  const events = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?notifier-shape-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1]?.id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      notifier: {
        started: async (state) => {
          events.push(["started", state.remaining])
        },
        progress: async (state) => {
          events.push(["progress", state.remaining])
        },
        repairWarning: async (state) => {
          events.push(["repairWarning", state.remaining])
        },
        completed: async (state) => {
          events.push(["completed", state.remaining])
        },
        stopped: async (state) => {
          events.push(["stopped", state.remaining])
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(events, [["started", 1], ["completed", 0]])
})

test("retry wrapper keeps cleanup running when notifier delivery fails", async () => {
  const events = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?notifier-failures-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      const remainingLongIds = body.input.filter((item) => typeof item.id === "string" && item.id.length > 64)
      if (remainingLongIds.length === 0) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(
        `Invalid 'input[${remainingLongIds[0].inputIndex}].id': string too long. Expected a string with maximum length 64, but got a string with length ${remainingLongIds[0].id.length} instead.`,
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    },
    {
      notifier: {
        started: async (state) => {
          events.push(["started", state.remaining])
          throw new Error("toast failed")
        },
        progress: async (state) => {
          events.push(["progress", state.remaining])
          throw new Error("toast failed")
        },
        repairWarning: async (state) => {
          events.push(["repairWarning", state.remaining])
          throw new Error("toast failed")
        },
        completed: async (state) => {
          events.push(["completed", state.remaining])
          throw new Error("toast failed")
        },
        stopped: async (state) => {
          events.push(["stopped", state.remaining])
          throw new Error("toast failed")
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { inputIndex: 2, role: "assistant", content: [{ type: "output_text", text: "first" }], id: "x".repeat(408) },
        { inputIndex: 3, role: "assistant", content: [{ type: "output_text", text: "second" }], id: "y".repeat(200) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(events, [["started", 2], ["progress", 1], ["completed", 0]])
})

test("retry wrapper emits warning when session repair fails but cleanup continues", async () => {
  const events = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?repair-warning-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[2]?.id) {
        return new Response(
          "Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      if (body.input[4]?.id) {
        return new Response(
          "Invalid 'input[5].id': string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    },
    {
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "a".repeat(408) } } },
                ],
              },
            ],
          }),
          message: async () => ({
            data: {
              parts: [
                { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "a", metadata: { openai: { itemId: "a".repeat(408) } } },
              ],
            },
          }),
        },
      },
      patchPart: async () => {
        throw new Error("patch failed")
      },
      notifier: {
        started: async (state) => {
          events.push(["started", state.remaining])
        },
        progress: async (state) => {
          events.push(["progress", state.remaining])
        },
        repairWarning: async (state) => {
          events.push(["repairWarning", state.remaining])
        },
        completed: async (state) => {
          events.push(["completed", state.remaining])
        },
        stopped: async (state) => {
          events.push(["stopped", state.remaining])
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "pad-1" }], id: "short-1" },
        { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "a".repeat(408) },
        { role: "assistant", content: [{ type: "output_text", text: "pad-2" }], id: "short-2" },
        { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "b".repeat(300) },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(events, [["started", 2], ["repairWarning", 2], ["progress", 1], ["completed", 0]])
})

test("retry wrapper emits stopped instead of completed when cleanup cannot continue", async () => {
  const events = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?stopped-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async () =>
      new Response(
        "Invalid input id: string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
        { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
      ),
    {
      notifier: {
        started: async (state) => {
          events.push(["started", state.remaining])
        },
        progress: async (state) => {
          events.push(["progress", state.remaining])
        },
        repairWarning: async (state) => {
          events.push(["repairWarning", state.remaining])
        },
        completed: async (state) => {
          events.push(["completed", state.remaining])
        },
        stopped: async (state) => {
          events.push(["stopped", state.remaining])
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "first" }], id: "x".repeat(300) },
        { role: "assistant", content: [{ type: "output_text", text: "second" }], id: "y".repeat(300) },
      ],
    }),
  })

  assert.equal(response.status, 400)
  assert.deepEqual(events, [["started", 2], ["stopped", 2]])
})

test("retry wrapper emits stopped instead of completed when cleanup removes the last long id but response still fails", async () => {
  const events = []
  const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?stop-after-cleanup-${Date.now()}`)
  const wrapped = createCopilotRetryingFetch(
    async (_request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.input[1]?.id) {
        return new Response(
          "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 300 instead.",
          { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }

      return new Response(JSON.stringify({ error: { message: "bad credentials" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    },
    {
      notifier: {
        started: async (state) => {
          events.push(["started", state.remaining])
        },
        progress: async (state) => {
          events.push(["progress", state.remaining])
        },
        repairWarning: async (state) => {
          events.push(["repairWarning", state.remaining])
        },
        completed: async (state) => {
          events.push(["completed", state.remaining])
        },
        stopped: async (state) => {
          events.push(["stopped", state.remaining])
        },
      },
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "only" }], id: "x".repeat(300) },
      ],
    }),
  })

  assert.equal(response.status, 401)
  assert.deepEqual(events, [["started", 1], ["stopped", 0]])
})

test("writes debug logs into temp file when enabled", async () => {
  const logFile = join(tmpdir(), `copilot-retry-debug-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = logFile

  try {
    const { createCopilotRetryingFetch } = await import(`../dist/copilot-network-retry.js?debug-log-${Date.now()}`)
    const wrapped = createCopilotRetryingFetch(async () => {
      throw new Error("failed to fetch")
    })

    await assert.rejects(
      wrapped("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      () => true,
    )

    const log = await readFile(logFile, "utf8")
    assert.match(log, /copilot-network-retry debug/)
    assert.match(log, /fetch start/)
    assert.match(log, /fetch threw/)
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    await rm(logFile, { force: true })
  }
})
