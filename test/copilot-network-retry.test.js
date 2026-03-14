import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const fakeCommit = "0123456789abcdef0123456789abcdef01234567"

function createUpstreamFixtureSource() {
  return `import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { iife } from "@/util/iife"

const CLIENT_ID = "client"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: ` + "`https://${domain}/login/device/code`" + `,
    ACCESS_TOKEN_URL: ` + "`https://${domain}/login/oauth/access_token`" + `,
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    auth: {
      provider: "github-copilot",
      async loader(getAuth, provider) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        const enterpriseUrl = info.enterpriseUrl
        const baseURL = enterpriseUrl ? ` + "`https://copilot-api.${normalizeDomain(enterpriseUrl)}`" + ` : undefined

        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }

            model.api.npm = "@ai-sdk/github-copilot"
          }
        }

        return {
          baseURL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)

            const url = request instanceof URL ? request.href : request.toString()
            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "User-Agent": ` + "`opencode/${Installation.VERSION}`" + `,
              Authorization: ` + "`Bearer ${info.refresh}`" + `,
              "Openai-Intent": "conversation-edits",
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [],
          async authorize(inputs = {}) {
            return {
              url: "",
              instructions: "",
              method: "auto" as const,
              async callback() {
                return { type: "failed" as const }
              },
            }
          },
        },
      ],
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return
      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      output.headers["x-initiator"] = "agent"
    },
  }
}
`
}

async function makeSyncFixture() {
  const dir = await mkdtemp(join(tmpdir(), "copilot-sync-"))
  const source = join(dir, "copilot.ts")
  const output = join(dir, "copilot-plugin.snapshot.ts")
  await writeFile(source, createUpstreamFixtureSource(), "utf8")
  return { dir, source, output }
}

async function runSyncScript(args) {
  return execFile(process.execPath, ["scripts/sync-copilot-upstream.mjs", ...args], {
    cwd: new URL("..", import.meta.url),
  })
}

test("sync script generates snapshot from upstream source", async () => {
  const fixture = await makeSyncFixture()

  try {
    await runSyncScript([
      "--source",
      fixture.source,
      "--output",
      fixture.output,
      "--upstream-commit",
      fakeCommit,
      "--sync-date",
      "2026-03-13",
    ])

    const snapshot = await readFile(fixture.output, "utf8")
    assert.match(snapshot, /Generated by scripts\/sync-copilot-upstream\.mjs/)
    assert.match(snapshot, new RegExp(`Upstream commit: ${fakeCommit}`))
    assert.match(snapshot, /\/\* LOCAL_SHIMS_START \*\//)
    assert.match(snapshot, /export function createOfficialCopilotLoader/)
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script check mode reports mismatch for hand-edited snapshot", async () => {
  const fixture = await makeSyncFixture()

  try {
    await runSyncScript([
      "--source",
      fixture.source,
      "--output",
      fixture.output,
      "--upstream-commit",
      fakeCommit,
      "--sync-date",
      "2026-03-13",
    ])
    await writeFile(fixture.output, `${await readFile(fixture.output, "utf8")}\n// hand edit\n`, "utf8")

    await assert.rejects(
      runSyncScript([
        "--source",
        fixture.source,
        "--output",
        fixture.output,
        "--upstream-commit",
        fakeCommit,
        "--check",
      ]),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stdout, /mismatch/)
        return true
      },
    )
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script fails fast when loader anchor is missing", async () => {
  const fixture = await makeSyncFixture()

  try {
    await writeFile(fixture.source, "export async function CopilotAuthPlugin() { return { auth: { methods: [] } } }\n", "utf8")

    await assert.rejects(
      runSyncScript([
        "--source",
        fixture.source,
        "--output",
        fixture.output,
        "--upstream-commit",
        fakeCommit,
        "--sync-date",
        "2026-03-13",
      ]),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /Unable to extract auth\.loader body|anchor/i)
        return true
      },
    )
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script fails fast when snapshot has multiple local shim blocks", async () => {
  const fixture = await makeSyncFixture()

  try {
    await runSyncScript([
      "--source",
      fixture.source,
      "--output",
      fixture.output,
      "--upstream-commit",
      fakeCommit,
      "--sync-date",
      "2026-03-13",
    ])
    const snapshot = await readFile(fixture.output, "utf8")
    await writeFile(
      fixture.output,
      `${snapshot}\n/* LOCAL_SHIMS_START */\nconst extra = true\n/* LOCAL_SHIMS_END */\n`,
      "utf8",
    )

    await assert.rejects(
      runSyncScript([
        "--source",
        fixture.source,
        "--output",
        fixture.output,
        "--upstream-commit",
        fakeCommit,
        "--sync-date",
        "2026-03-13",
        "--check",
      ]),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(`${error.stdout}\n${error.stderr}`, /LOCAL_SHIMS|mismatch/i)
        return true
      },
    )
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script refuses to overwrite snapshot with invalid local shim markers", async () => {
  const fixture = await makeSyncFixture()

  try {
    await writeFile(
      fixture.output,
      `/* LOCAL_SHIMS_START */\nconst a = 1\n/* LOCAL_SHIMS_END */\n/* LOCAL_SHIMS_START */\nconst b = 2\n/* LOCAL_SHIMS_END */\n`,
      "utf8",
    )

    await assert.rejects(
      runSyncScript([
        "--source",
        fixture.source,
        "--output",
        fixture.output,
        "--upstream-commit",
        fakeCommit,
        "--sync-date",
        "2026-03-13",
      ]),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /LOCAL_SHIMS/i)
        return true
      },
    )
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script requires upstream metadata for repository snapshot generation", async () => {
  await assert.rejects(
    runSyncScript([
      "--source",
      "C:\\Users\\34404\\Documents\\GitHub\\opencode-copilot-analysis\\opencode\\packages\\opencode\\src\\plugin\\copilot.ts",
      "--check",
    ]),
    (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /upstream-commit|sync-date/i)
      return true
    },
  )
})

test("package scripts expose copilot snapshot sync commands", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

  assert.equal(
    pkg.scripts["sync:copilot-snapshot"],
    "node scripts/sync-copilot-upstream.mjs --output src/upstream/copilot-plugin.snapshot.ts",
  )
  assert.equal(
    pkg.scripts["check:copilot-sync"],
    "node scripts/sync-copilot-upstream.mjs --output src/upstream/copilot-plugin.snapshot.ts --check",
  )
})

test("snapshot exposes official copilot loader factory", async () => {
  const mod = await import("../dist/upstream/copilot-plugin.snapshot.js")

  assert.equal(typeof mod.createOfficialCopilotLoader, "function")
})

test("snapshot loader returns empty config for non oauth auth", async () => {
  const { createOfficialCopilotLoader } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  const loader = createOfficialCopilotLoader()

  const result = await loader(async () => ({ type: "token" }))

  assert.deepEqual(result, {})
})

test("snapshot loader builds baseURL from oauth enterpriseUrl", async () => {
  const { createOfficialCopilotLoader } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  const loader = createOfficialCopilotLoader()

  const result = await loader(async () => ({
    type: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: 0,
    enterpriseUrl: "https://example.ghe.com/",
  }))

  assert.equal(result.baseURL, "https://copilot-api.example.ghe.com")
})

test("snapshot loader fetch rewrites auth headers from refreshed oauth state", async () => {
  const calls = []
  const { createOfficialCopilotLoader } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  let reads = 0
  const loader = createOfficialCopilotLoader({
    fetchImpl: async (input, init) => {
      calls.push({
        input,
        headers: init?.headers,
      })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  const auth = async () => {
    reads += 1
    return {
      type: "oauth",
      refresh: reads === 1 ? "stale-refresh" : "fresh-refresh",
      access: "access-token",
      expires: 0,
    }
  }

  const result = await loader(auth)
  assert.equal(typeof result.fetch, "function")

  await result.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: new Headers({
      authorization: "bad-auth",
      "x-api-key": "bad-key",
      "x-trace-id": "keep-me",
    }),
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  assert.equal(reads, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Authorization, "Bearer fresh-refresh")
  assert.equal(calls[0].headers["Openai-Intent"], "conversation-edits")
  assert.equal(calls[0].headers["x-api-key"], undefined)
  assert.equal(calls[0].headers.authorization, undefined)
})

test("snapshot loader keeps fetch injection isolated across concurrent calls", async () => {
  const calls = []
  const { createOfficialCopilotLoader } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  let releaseAuth
  const authGate = new Promise((resolve) => {
    releaseAuth = resolve
  })
  let delayedReads = 0

  const delayedLoader = createOfficialCopilotLoader({
    version: "first",
    fetchImpl: async (_input, init) => {
      calls.push({ loader: "first", userAgent: init?.headers?.["User-Agent"] })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  const immediateLoader = createOfficialCopilotLoader({
    version: "second",
    fetchImpl: async (_input, init) => {
      calls.push({ loader: "second", userAgent: init?.headers?.["User-Agent"] })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  const delayed = await delayedLoader(async () => {
    delayedReads += 1
    if (delayedReads === 2) {
      await authGate
    }
    return { type: "oauth", refresh: "first-refresh", access: "first-access", expires: 0 }
  })
  const immediate = await immediateLoader(async () => ({
    type: "oauth",
    refresh: "second-refresh",
    access: "second-access",
    expires: 0,
  }))

  const pending = delayed.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  await immediate.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  releaseAuth()
  await pending

  assert.deepEqual(calls, [
    { loader: "second", userAgent: "opencode/second" },
    { loader: "first", userAgent: "opencode/first" },
  ])
})

test("snapshot loader does not leak fetch injection to unrelated global fetch calls", async () => {
  const calls = []
  const { createOfficialCopilotLoader } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  let releaseAuth
  const authGate = new Promise((resolve) => {
    releaseAuth = resolve
  })
  let reads = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () => {
    calls.push({ loader: "global" })
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  try {
    const loader = createOfficialCopilotLoader({
      version: "isolated",
      fetchImpl: async (_input, init) => {
        calls.push({ loader: "wrapped", userAgent: init?.headers?.["User-Agent"] })
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    const result = await loader(async () => {
      reads += 1
      if (reads === 2) {
        await authGate
      }
      return { type: "oauth", refresh: "refresh", access: "access", expires: 0 }
    })

    const pending = result.fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    await globalThis.fetch("https://example.com")
    releaseAuth()
    await pending

    assert.deepEqual(calls, [
      { loader: "global" },
      { loader: "wrapped", userAgent: "opencode/isolated" },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("snapshot source keeps a single concentrated local shim block", async () => {
  const source = await readFile(new URL("../src/upstream/copilot-plugin.snapshot.ts", import.meta.url), "utf8")
  const starts = source.match(/\/\* LOCAL_SHIMS_START \*\//g) ?? []
  const ends = source.match(/\/\* LOCAL_SHIMS_END \*\//g) ?? []

  assert.equal(starts.length, 1)
  assert.equal(ends.length, 1)
  assert.match(source, /\/\* LOCAL_SHIMS_START \*\/[\s\S]*\/\* LOCAL_SHIMS_END \*\//)
  assert.match(source, /\/\* LOCAL_SHIMS_END \*\/[\r\n]+[\s\S]*function normalizeDomain/)
})

test("snapshot source preserves the upstream copilot plugin structure", async () => {
  const source = await readFile(new URL("../src/upstream/copilot-plugin.snapshot.ts", import.meta.url), "utf8")

  assert.match(source, /Repository: https:\/\/github\.com\/sst\/opencode/)
  assert.match(source, /Original path: packages\/opencode\/src\/plugin\/copilot\.ts/)
  assert.match(source, /Sync date: \d{4}-\d{2}-\d{2}/)
  assert.match(source, /Upstream commit: [0-9a-f]{40}/)
  assert.match(source, /const CLIENT_ID = /)
  assert.match(source, /const OAUTH_POLLING_SAFETY_MARGIN_MS = /)
  assert.match(source, /function getUrls\(domain: string\)/)
  assert.match(source, /export async function CopilotAuthPlugin\(input: PluginInput\): Promise<Hooks>/)
  assert.match(source, /methods: \[/)
  assert.match(source, /async authorize\(inputs = \{\}\)/)
  assert.match(source, /"chat\.headers": async \(incoming, output\) => \{/) 
})

test("snapshot source keeps upstream loader body unchanged outside generated blocks", async () => {
  const source = await readFile(new URL("../src/upstream/copilot-plugin.snapshot.ts", import.meta.url), "utf8")

  assert.match(source, /function normalizeDomain\(url: string\)/)
  assert.match(source, /if \(!info \|\| info\.type !== "oauth"\) return \{\}/)
  assert.match(source, /if \(info\.type !== "oauth"\) return fetch\(request, init\)/)
})

test("loadOfficialCopilotConfig returns undefined for non oauth auth", async () => {
  const { loadOfficialCopilotConfig } = await import("../dist/upstream/copilot-loader-adapter.js")

  const result = await loadOfficialCopilotConfig({
    getAuth: async () => ({ type: "token" }),
  })

  assert.equal(result, undefined)
})

test("loadOfficialCopilotConfig returns baseURL apiKey and fetch for oauth auth", async () => {
  const { loadOfficialCopilotConfig } = await import("../dist/upstream/copilot-loader-adapter.js")

  const result = await loadOfficialCopilotConfig({
    getAuth: async () => ({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 0,
      enterpriseUrl: "https://ghe.example.com",
    }),
  })

  assert.equal(result?.baseURL, "https://copilot-api.ghe.example.com")
  assert.equal(result?.apiKey, "")
  assert.equal(typeof result?.fetch, "function")
})

test("loadOfficialCopilotConfig preserves official provider model mutations", async () => {
  const { loadOfficialCopilotConfig } = await import("../dist/upstream/copilot-loader-adapter.js")
  const provider = {
    models: {
      foo: {
        id: "claude-3.7",
        api: {},
      },
    },
  }

  await loadOfficialCopilotConfig({
    getAuth: async () => ({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 0,
    }),
    provider,
  })

  assert.equal(provider.models.foo.api.npm, "@ai-sdk/github-copilot")
  assert.deepEqual(provider.models.foo.cost, {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  })
})

test("adapter preserves official header injection", async () => {
  const calls = []
  const { loadOfficialCopilotConfig } = await import("../dist/upstream/copilot-loader-adapter.js")

  const config = await loadOfficialCopilotConfig({
    getAuth: async () => ({ type: "oauth", refresh: "refresh-token", access: "access-token", expires: 0 }),
    baseFetch: async (_input, init) => {
      calls.push({ headers: init?.headers })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  assert.ok(config)

  await config.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: { authorization: "bad", "x-api-key": "bad", "x-trace-id": "keep-me" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Authorization, "Bearer refresh-token")
  assert.equal(calls[0].headers["Openai-Intent"], "conversation-edits")
  assert.equal(calls[0].headers["x-api-key"], undefined)
  assert.equal(calls[0].headers["x-trace-id"], "keep-me")
})

test("normalizes retryable copilot network errors into ECONNRESET-shaped failures", async () => {
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
      assert.equal(error.code, "ECONNRESET")
      assert.equal(error.syscall, "fetch")
      assert.match(error.message, /copilot-network-retry normalized/i)
      assert.match(error.message, /unknown certificate/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test("normalizes sse read timeout errors for copilot urls", async () => {
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
      assert.equal(error.code, "ECONNRESET")
      assert.equal(error.syscall, "fetch")
      assert.match(error.message, /copilot-network-retry normalized/i)
      assert.match(error.message, /sse read timed out/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
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
      assert.equal(error.code, "ECONNRESET")
      assert.equal(error.syscall, "fetch")
      assert.match(error.message, /copilot-network-retry normalized/i)
      assert.match(error.message, /unable to connect/i)
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
      assert.equal(error.code, "ECONNRESET")
      assert.equal(error.syscall, "fetch")
      assert.match(error.message, /copilot-network-retry normalized/i)
      assert.match(error.message, /unknown certificate verification error/i)
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
    assert.equal(error.code, "ECONNRESET")
    assert.match(error.message, /copilot-network-retry normalized/i)
    assert.match(error.message, /failed to fetch/i)
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
    assert.equal(error.code, "ECONNRESET")
    assert.match(error.message, /copilot-network-retry normalized/i)
    assert.match(error.message, /failed to fetch/i)
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
