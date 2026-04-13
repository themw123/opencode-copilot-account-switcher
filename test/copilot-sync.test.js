import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { createServer } from "node:http"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { join } from "node:path"
import test from "node:test"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const fakeCommit = "0123456789abcdef0123456789abcdef01234567"
const repoRoot = new URL("..", import.meta.url)
const repoRootPath = fileURLToPath(repoRoot)
const syncScriptPath = fileURLToPath(new URL("../scripts/sync-copilot-upstream.mjs", import.meta.url))
const repositorySnapshotPath = fileURLToPath(new URL("../src/upstream/copilot-plugin.snapshot.ts", import.meta.url))
const npmCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm"

function createUpstreamFixtureSource(options = {}) {
  const clientId = options.clientId ?? "client"
  const chatHeadersBody = options.chatHeadersBody ?? `if (!incoming.model.providerID.includes("github-copilot")) return
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
      output.headers["x-initiator"] = "agent"`

  return `import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { iife } from "@/util/iife"

const CLIENT_ID = "${clientId}"
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
      ${chatHeadersBody}
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

async function makeDefaultSourceFixture() {
  const dir = await mkdtemp(join(tmpdir(), "copilot-sync-default-"))
  const projectDir = join(dir, "project")
  const siblingSource = join(dir, "opencode", "packages", "opencode", "src", "plugin", "copilot.ts")
  const output = join(projectDir, "copilot-plugin.snapshot.ts")

  await mkdir(join(projectDir), { recursive: true })
  await mkdir(join(dir, "opencode", "packages", "opencode", "src", "plugin"), { recursive: true })
  await writeFile(siblingSource, createUpstreamFixtureSource({ clientId: "local-sibling-client" }), "utf8")
  return { dir, projectDir, siblingSource, output }
}

async function runSyncScript(args, options = {}) {
  return execFile(process.execPath, [syncScriptPath, ...args], {
    cwd: options.cwd ?? repoRootPath,
    env: {
      ...process.env,
      ...options.env,
    },
  })
}

async function runNpmScript(scriptName, options = {}) {
  const args = process.platform === "win32" ? ["/d", "/s", "/c", `npm run ${scriptName}`] : ["run", scriptName]

  return execFile(npmCommand, args, {
    cwd: options.cwd ?? repoRootPath,
    env: {
      ...process.env,
      ...options.env,
    },
  })
}

async function runScriptWithGhFallback(projectDir, extraEnv = {}, options = {}) {
  const args = [syncScriptPath, "--output", "src/upstream/copilot-plugin.snapshot.ts", "--check"]
  if (options.syncDate) {
    args.push("--sync-date", options.syncDate)
  }

  return execFile(process.execPath, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      ...extraEnv,
    },
  })
}

async function createFakeGhCommand(prefix, contents, options = {}) {
  const platform = options.platform ?? process.platform
  const chmodImpl = options.chmodImpl ?? chmod
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const commandPath = join(dir, platform === "win32" ? "gh.cmd" : "gh")
  await writeFile(commandPath, contents, "utf8")
  if (process.platform !== "win32") {
    await chmodImpl(commandPath, 0o755)
  }
  return { dir, commandPath }
}

async function startMockCanonicalUpstream(options = {}) {
  const repo = options.repo ?? "anomalyco/opencode"
  const branch = options.branch ?? "dev"
  const sourceText = options.sourceText ?? createUpstreamFixtureSource({ clientId: "canonical-upstream-client" })
  const sha = options.sha ?? "fedcba9876543210fedcba9876543210fedcba98"
  const requests = []

  const server = createServer((request, response) => {
    requests.push(request.url ?? "")

    if (request.url === `/${repo}/${branch}/packages/opencode/src/plugin/copilot.ts`) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      response.end(sourceText)
      return
    }

    if (request.url === `/repos/${repo}/branches/${branch}`) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ commit: { sha } }))
      return
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    response.end("not found")
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine mock upstream server address")
  }

  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    repo,
    branch,
    sha,
    requests,
    env: {
      OPENCODE_SYNC_UPSTREAM_REPO: repo,
      OPENCODE_SYNC_UPSTREAM_BRANCH: branch,
      OPENCODE_SYNC_RAW_BASE_URL: baseUrl,
      OPENCODE_SYNC_GITHUB_API_BASE_URL: baseUrl,
    },
    async close() {
      server.close()
      await once(server, "close")
    },
  }
}

function readSnapshotMetadata(snapshot) {
  const upstreamCommit = snapshot.match(/Upstream commit: ([0-9a-f]{40})/i)?.[1]
  const syncDate = snapshot.match(/Sync date: (\d{4}-\d{2}-\d{2})/)?.[1]

  if (!upstreamCommit || !syncDate) {
    throw new Error("Unable to read repository snapshot metadata")
  }

  return {
    upstreamCommit,
    syncDate,
  }
}

function rebuildUpstreamSourceFromSnapshot(snapshot) {
  const normalizedSnapshot = normalize(snapshot)
  const bodyMatch = normalizedSnapshot.match(/\/\* LOCAL_SHIMS_END \*\/\n\n([\s\S]*?)\n\n\/\* GENERATED_EXPORT_BRIDGE_START \*\//)
  if (!bodyMatch) {
    throw new Error("Unable to rebuild upstream source from repository snapshot")
  }

  return [
    'import type { Hooks, PluginInput } from "@opencode-ai/plugin"',
    'import { Installation } from "@/installation"',
    'import { iife } from "@/util/iife"',
    "",
    `${bodyMatch[1].trimEnd()}\n`,
  ].join("\n")
}

function summarizeByteDifference(expected, actual) {
  const expectedLines = expected.split("\n")
  const actualLines = actual.split("\n")
  const limit = Math.max(expectedLines.length, actualLines.length)

  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] === actualLines[index]) continue
    return [
      `first difference at line ${index + 1}`,
      `expected: ${expectedLines[index] ?? "<eof>"}`,
      `actual:   ${actualLines[index] ?? "<eof>"}`,
    ].join("\n")
  }

  return "files differ"
}

function replaceClientId(sourceText, clientId) {
  return sourceText.replace(/const CLIENT_ID = "[^"]+"/, `const CLIENT_ID = "${clientId}"`)
}

function toCrlf(text) {
  return text.replace(/\n/g, "\r\n")
}

function stripImports(sourceText) {
  const match = sourceText.match(/^(?:import[^\n]*\n)+\n?/)
  if (!match) {
    throw new Error("Unable to locate import block in upstream source")
  }
  return sourceText.slice(match[0].length).trimStart()
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n")
}

function stripUpstreamForMechanicalComparison(sourceText) {
  return `${stripImports(normalize(sourceText)).trimEnd()}\n`
}

function stripSnapshotMechanicalAllowlist(snapshotText) {
  return (
    normalize(snapshotText)
    .replace(/^\/\/ @ts-nocheck\nimport \{ AsyncLocalStorage \} from "node:async_hooks"\n\n\/\*[\s\S]*?\*\/\n\n/, "")
    .replace(/\/\* LOCAL_SHIMS_START \*\/[\s\S]*?\/\* LOCAL_SHIMS_END \*\//, "")
    .replace(/\/\* GENERATED_EXPORT_BRIDGE_START \*\/[\s\S]*?\/\* GENERATED_EXPORT_BRIDGE_END \*\//, "")
    .trimStart()
    .trimEnd() + "\n"
  )
}

async function readRepositorySnapshotFixture() {
  const snapshot = await readFile(repositorySnapshotPath, "utf8")
  return {
    snapshot,
    sourceText: rebuildUpstreamSourceFromSnapshot(snapshot),
    ...readSnapshotMetadata(snapshot),
  }
}

async function makeCheckModeProjectFixture(snapshotText) {
  const dir = await mkdtemp(join(tmpdir(), "copilot-sync-check-mode-"))
  const packageJsonPath = join(dir, "package.json")
  const snapshotPath = join(dir, "src", "upstream", "copilot-plugin.snapshot.ts")

  await mkdir(join(dir, "src", "upstream"), { recursive: true })
  await writeFile(
    packageJsonPath,
    JSON.stringify(
      {
        name: "copilot-sync-check-mode-fixture",
        private: true,
        scripts: {
          "check:copilot-sync": `node ${JSON.stringify(syncScriptPath)} --output src/upstream/copilot-plugin.snapshot.ts --check`,
        },
      },
      null,
      2,
    ),
    "utf8",
  )
  await writeFile(snapshotPath, snapshotText, "utf8")

  return {
    dir,
    snapshotPath,
  }
}

async function assertRepositorySnapshotMatchesUpstreamByteForByte(options = {}) {
  const snapshotFixture = await readRepositorySnapshotFixture()
  const upstream = await startMockCanonicalUpstream({
    sourceText: options.sourceText ?? snapshotFixture.sourceText,
    sha: options.sha ?? snapshotFixture.upstreamCommit,
  })
  const tempDir = await mkdtemp(join(tmpdir(), "copilot-sync-drift-"))
  const tempOutput = join(tempDir, "copilot-plugin.snapshot.ts")

  try {
    await runSyncScript(["--output", tempOutput, "--sync-date", snapshotFixture.syncDate], {
      env: {
        ...upstream.env,
        ...options.env,
      },
    }).catch((error) => {
      const detail = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() || error.message
      throw new Error(`upstream fetch failed\n${detail}`)
    })

    const expected = await readFile(repositorySnapshotPath)
    const actual = await readFile(tempOutput)
    assert.deepEqual(
      actual,
      expected,
      `snapshot drift detected\n${summarizeByteDifference(expected.toString("utf8"), actual.toString("utf8"))}`,
    )
  } finally {
    await upstream.close()
    await rm(tempDir, { recursive: true, force: true })
  }
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
    assert.match(snapshot, /\/\* GENERATED_EXPORT_BRIDGE_START \*\//)
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("逐字节漂移: 临时 snapshot 与仓库 snapshot 保持逐字节一致", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()

  await assert.doesNotReject(assertRepositorySnapshotMatchesUpstreamByteForByte())
  await assert.rejects(
    assertRepositorySnapshotMatchesUpstreamByteForByte({
      sourceText: replaceClientId(repositorySnapshot.sourceText, "drifted-client-id"),
    }),
    /snapshot drift detected/,
  )
  await assert.rejects(
    assertRepositorySnapshotMatchesUpstreamByteForByte({
      env: {
        OPENCODE_SYNC_RAW_BASE_URL: "http://127.0.0.1:1",
        OPENCODE_SYNC_GITHUB_API_BASE_URL: "http://127.0.0.1:1",
      },
    }),
    /upstream fetch failed/,
  )
})

test("逐字节漂移: --check 对网络失败和 drift 失败使用不同消息", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()
  const driftUpstream = await startMockCanonicalUpstream({
    sourceText: replaceClientId(repositorySnapshot.sourceText, "drifted-client-id"),
    sha: repositorySnapshot.upstreamCommit,
  })

  try {
    await assert.rejects(
      runSyncScript(["--output", repositorySnapshotPath, "--check"], {
        env: driftUpstream.env,
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(`${error.stdout}\n${error.stderr}`, /snapshot drift detected/)
        return true
      },
    )
  } finally {
    await driftUpstream.close()
  }

  await assert.rejects(
    runSyncScript(["--output", repositorySnapshotPath, "--check"], {
      env: {
        OPENCODE_SYNC_RAW_BASE_URL: "http://127.0.0.1:1",
        OPENCODE_SYNC_GITHUB_API_BASE_URL: "http://127.0.0.1:1",
      },
    }),
    (error) => {
      assert.equal(error.code, 1)
      assert.match(`${error.stdout}\n${error.stderr}`, /upstream fetch failed/)
      return true
    },
  )
})

test("check mode: npm run check:copilot-sync 与全量测试使用相同判定标准", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()
  const driftUpstream = await startMockCanonicalUpstream({
    sourceText: replaceClientId(repositorySnapshot.sourceText, "drifted-client-id"),
    sha: repositorySnapshot.upstreamCommit,
  })

  try {
    await assert.rejects(
      runNpmScript("check:copilot-sync", {
        env: driftUpstream.env,
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(`${error.stdout}\n${error.stderr}`, /snapshot drift detected/)
        return true
      },
    )
  } finally {
    await driftUpstream.close()
  }

  await assert.rejects(
    runNpmScript("check:copilot-sync", {
      env: {
        OPENCODE_SYNC_RAW_BASE_URL: "http://127.0.0.1:1",
        OPENCODE_SYNC_GITHUB_API_BASE_URL: "http://127.0.0.1:1",
      },
    }),
    (error) => {
      assert.equal(error.code, 1)
      assert.match(`${error.stdout}\n${error.stderr}`, /upstream fetch failed/)
      return true
    },
  )
})

test("check mode: 仅换行符不同也视为 snapshot drift", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()
  const fixture = await makeCheckModeProjectFixture(toCrlf(repositorySnapshot.snapshot))
  const upstream = await startMockCanonicalUpstream({
    sourceText: repositorySnapshot.sourceText,
    sha: repositorySnapshot.upstreamCommit,
  })

  try {
    await assert.rejects(
      runNpmScript("check:copilot-sync", {
        cwd: fixture.dir,
        env: upstream.env,
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(`${error.stdout}\n${error.stderr}`, /snapshot drift detected/)
        return true
      },
    )
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("check mode: GitHub API 失败时回退 gh api 解析真实 SHA", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()
  const fixture = await makeCheckModeProjectFixture(repositorySnapshot.snapshot)
  const upstream = await startMockCanonicalUpstream({
    sourceText: repositorySnapshot.sourceText,
    sha: repositorySnapshot.upstreamCommit,
  })
  const fakeGh = await createFakeGhCommand(
    "copilot-sync-gh-",
    process.platform === "win32"
      ? `@echo off\r\nif "%1"=="api" if "%2"=="repos/anomalyco/opencode/branches/dev" (\r\n  echo {"commit":{"sha":"${repositorySnapshot.upstreamCommit}"}}\r\n  exit /b 0\r\n)\r\necho unexpected gh args 1>&2\r\nexit /b 1\r\n`
      : `#!/bin/sh\nif [ "$1" = "api" ] && [ "$2" = "repos/anomalyco/opencode/branches/dev" ]; then\n  printf '{"commit":{"sha":"${repositorySnapshot.upstreamCommit}"}}\\n'\n  exit 0\nfi\nprintf 'unexpected gh args\\n' >&2\nexit 1\n`,
  )

  try {
    await assert.doesNotReject(
      runScriptWithGhFallback(fixture.dir, {
        OPENCODE_SYNC_GITHUB_API_BASE_URL: "http://127.0.0.1:1",
        OPENCODE_SYNC_RAW_BASE_URL: upstream.env.OPENCODE_SYNC_RAW_BASE_URL,
        OPENCODE_SYNC_UPSTREAM_REPO: upstream.env.OPENCODE_SYNC_UPSTREAM_REPO,
        OPENCODE_SYNC_UPSTREAM_BRANCH: upstream.env.OPENCODE_SYNC_UPSTREAM_BRANCH,
        OPENCODE_SYNC_GH_COMMAND: fakeGh.commandPath,
      }, {
        syncDate: repositorySnapshot.syncDate,
      }),
    )
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
    await rm(fakeGh.dir, { recursive: true, force: true })
  }
})

test("check mode: Windows 平台回退 gh 自定义命令路径也能解析真实 SHA", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()
  const fixture = await makeCheckModeProjectFixture(repositorySnapshot.snapshot)
  const upstream = await startMockCanonicalUpstream({
    sourceText: repositorySnapshot.sourceText,
    sha: repositorySnapshot.upstreamCommit,
  })
  const fakeGh = await createFakeGhCommand(
    "copilot-sync-gh-win-",
    process.platform === "win32"
      ? `@echo off\r\nif "%1"=="api" if "%2"=="repos/anomalyco/opencode/branches/dev" (\r\n  echo {"commit":{"sha":"${repositorySnapshot.upstreamCommit}"}}\r\n  exit /b 0\r\n)\r\necho unexpected gh args 1>&2\r\nexit /b 1\r\n`
      : `#!/bin/sh\nif [ "$1" = "api" ] && [ "$2" = "repos/anomalyco/opencode/branches/dev" ]; then\n  printf '{"commit":{"sha":"${repositorySnapshot.upstreamCommit}"}}\\n'\n  exit 0\nfi\nprintf 'unexpected gh args\\n' >&2\nexit 1\n`,
    { platform: "win32" },
  )

  try {
    await assert.doesNotReject(
      runScriptWithGhFallback(fixture.dir, {
        OPENCODE_SYNC_GITHUB_API_BASE_URL: "http://127.0.0.1:1",
        OPENCODE_SYNC_RAW_BASE_URL: upstream.env.OPENCODE_SYNC_RAW_BASE_URL,
        OPENCODE_SYNC_UPSTREAM_REPO: upstream.env.OPENCODE_SYNC_UPSTREAM_REPO,
        OPENCODE_SYNC_UPSTREAM_BRANCH: upstream.env.OPENCODE_SYNC_UPSTREAM_BRANCH,
        OPENCODE_SYNC_GH_COMMAND: fakeGh.commandPath,
      }, {
        syncDate: repositorySnapshot.syncDate,
      }),
    )
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
    await rm(fakeGh.dir, { recursive: true, force: true })
  }
})

test("机械变换约束: snapshot 核心主体只允许白名单区块与 upstream 不同", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()
  const comparableUpstream = stripUpstreamForMechanicalComparison(repositorySnapshot.sourceText)

  assert.equal(stripSnapshotMechanicalAllowlist(repositorySnapshot.snapshot), comparableUpstream)

  const metadataOnly = repositorySnapshot.snapshot.replace(/Sync date: \d{4}-\d{2}-\d{2}/, "Sync date: 2099-01-01")
  assert.equal(stripSnapshotMechanicalAllowlist(metadataOnly), comparableUpstream)

  const driftedCore = repositorySnapshot.snapshot.replace(/const CLIENT_ID = "[^"]+"/, 'const CLIENT_ID = "drifted-client-id"')
  assert.notEqual(stripSnapshotMechanicalAllowlist(driftedCore), comparableUpstream)
})

test("createFakeGhCommand: 非 Windows 平台会给 fake gh 脚本添加可执行权限", async () => {
  let chmodCall
  const fixture = await createFakeGhCommand("copilot-sync-gh-mode-", "#!/bin/sh\nexit 0\n", {
    platform: "linux",
    chmodImpl: async (commandPath, mode) => {
      chmodCall = { commandPath, mode }
    },
  })

  try {
    assert.equal(path.basename(fixture.commandPath), "gh")
    assert.deepEqual(chmodCall, {
      commandPath: fixture.commandPath,
      mode: 0o755,
    })
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("check mode: gh 回退失败时输出 fetch 与 gh 两段错误", async () => {
  const repositorySnapshot = await readRepositorySnapshotFixture()
  const fixture = await makeCheckModeProjectFixture(repositorySnapshot.snapshot)
  const upstream = await startMockCanonicalUpstream({
    sourceText: repositorySnapshot.sourceText,
    sha: repositorySnapshot.upstreamCommit,
  })
  const fakeGh = await createFakeGhCommand(
    "copilot-sync-gh-fail-",
    process.platform === "win32"
      ? "@echo off\r\necho gh fallback failed 1>&2\r\nexit /b 1\r\n"
      : "#!/bin/sh\nprintf 'gh fallback failed\\n' >&2\nexit 1\n",
  )

  try {
    await assert.rejects(
      runScriptWithGhFallback(fixture.dir, {
        OPENCODE_SYNC_GITHUB_API_BASE_URL: "http://127.0.0.1:1",
        OPENCODE_SYNC_RAW_BASE_URL: upstream.env.OPENCODE_SYNC_RAW_BASE_URL,
        OPENCODE_SYNC_UPSTREAM_REPO: upstream.env.OPENCODE_SYNC_UPSTREAM_REPO,
        OPENCODE_SYNC_UPSTREAM_BRANCH: upstream.env.OPENCODE_SYNC_UPSTREAM_BRANCH,
        OPENCODE_SYNC_GH_COMMAND: fakeGh.commandPath,
      }, {
        syncDate: repositorySnapshot.syncDate,
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(`${error.stdout}\n${error.stderr}`, /upstream fetch failed/)
        assert.match(`${error.stdout}\n${error.stderr}`, /Failed to fetch metadata: fetch failed|Failed to fetch metadata: 403/)
        assert.match(`${error.stdout}\n${error.stderr}`, /gh api failed:[\s\S]*gh fallback failed/)
        return true
      },
    )
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
    await rm(fakeGh.dir, { recursive: true, force: true })
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
        assert.match(error.stdout, /snapshot drift detected/)
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
        assert.match(`${error.stdout}\n${error.stderr}`, /LOCAL_SHIMS|snapshot drift detected/i)
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

test("sync script defaults to canonical anomalyco upstream source", async () => {
  const fixture = await makeDefaultSourceFixture()
  const upstream = await startMockCanonicalUpstream()

  try {
    await runSyncScript(["--output", fixture.output], {
      cwd: fixture.projectDir,
      env: upstream.env,
    })

    const snapshot = await readFile(fixture.output, "utf8")
    assert.match(snapshot, /Repository: https:\/\/github\.com\/anomalyco\/opencode/)
    assert.match(snapshot, /const CLIENT_ID = "canonical-upstream-client"/)
    assert.ok(upstream.requests.includes(`/${upstream.repo}/${upstream.branch}/packages/opencode/src/plugin/copilot.ts`))
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script does not prefer local sibling repo path as the default source", async () => {
  const fixture = await makeDefaultSourceFixture()
  const upstream = await startMockCanonicalUpstream()

  try {
    await runSyncScript(["--output", fixture.output], {
      cwd: fixture.projectDir,
      env: upstream.env,
    })

    const snapshot = await readFile(fixture.output, "utf8")
    assert.doesNotMatch(snapshot, /const CLIENT_ID = "local-sibling-client"/)
    assert.match(snapshot, /const CLIENT_ID = "canonical-upstream-client"/)
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script records real upstream sha metadata for default dev sync", async () => {
  const fixture = await makeDefaultSourceFixture()
  const upstream = await startMockCanonicalUpstream({
    sha: "1234567890abcdef1234567890abcdef12345678",
  })

  try {
    await runSyncScript(["--output", fixture.output], {
      cwd: fixture.projectDir,
      env: upstream.env,
    })

    const snapshot = await readFile(fixture.output, "utf8")
    assert.match(snapshot, /Upstream commit: 1234567890abcdef1234567890abcdef12345678/)
    assert.ok(upstream.requests.includes(`/repos/${upstream.repo}/branches/${upstream.branch}`))
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script fails fast when canonical upstream metadata returns an invalid sha", async () => {
  const fixture = await makeDefaultSourceFixture()
  const upstream = await startMockCanonicalUpstream({
    sha: "not-a-real-sha",
  })

  try {
    await assert.rejects(
      runSyncScript(["--output", fixture.output], {
        cwd: fixture.projectDir,
        env: upstream.env,
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /Unable to resolve canonical upstream commit SHA/)
        return true
      },
    )
  } finally {
    await upstream.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script extracts chat.headers body when upstream contains braces inside strings comments and templates", async () => {
  const fixture = await makeSyncFixture()

  try {
    await writeFile(
      fixture.source,
      createUpstreamFixtureSource({
        chatHeadersBody: `if (!incoming.model.providerID.includes("github-copilot")) return
      const note = "brace } in string"
      const template = \`template \${incoming.sessionID} also keeps } braces\`
      // } line comment should be ignored
      /* } block comment should be ignored */
      if (note && template) {
        output.headers["x-initiator"] = "agent"
      }`,
      }),
      "utf8",
    )

    await runSyncScript([
      "--source",
      fixture.source,
      "--output",
      fixture.output,
      "--upstream-commit",
      fakeCommit,
      "--sync-date",
      "2026-03-15",
    ])

    const snapshot = await readFile(fixture.output, "utf8")
    assert.match(snapshot, /const note = "brace } in string"/)
    assert.match(snapshot, /const template = `template \$\{incoming\.sessionID\} also keeps } braces`/)
    assert.match(snapshot, /output\.headers\["x-initiator"\] = "agent"/)
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

test("sync script requires upstream commit for repository snapshot generation even with explicit source path", async () => {
  const fixture = await makeSyncFixture()
  const repositorySnapshot = fileURLToPath(new URL("../src/upstream/copilot-plugin.snapshot.ts", import.meta.url))

  try {
    await assert.rejects(
      runSyncScript([
        "--source",
        fixture.source,
        "--output",
        repositorySnapshot,
        "--sync-date",
        "2026-03-15",
        "--check",
      ]),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /upstream-commit/i)
        return true
      },
    )
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
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

test("helper factory snapshot source emits only the generated export bridge markers", async () => {
  const source = await readFile(new URL("../src/upstream/copilot-plugin.snapshot.ts", import.meta.url), "utf8")

  assert.match(source, /\/\* GENERATED_EXPORT_BRIDGE_START \*\//)
  assert.match(source, /\/\* GENERATED_EXPORT_BRIDGE_END \*\//)
  assert.doesNotMatch(source, /createOfficialCopilotLoader/)
  assert.doesNotMatch(source, /createOfficialCopilotChatHeaders/)
})

test("helper factory snapshot module exports bridge instead of semantic helper factories", async () => {
  const mod = await import("../dist/upstream/copilot-plugin.snapshot.js")

  assert.equal(typeof mod.CopilotAuthPlugin, "function")
  assert.equal(typeof mod.officialCopilotExportBridge, "object")
  assert.equal("createOfficialCopilotLoader" in mod, false)
  assert.equal("createOfficialCopilotChatHeaders" in mod, false)
})

test("snapshot plugin auth loader returns empty config for non oauth auth", async () => {
  const { CopilotAuthPlugin } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  const hooks = await CopilotAuthPlugin({})
  const loader = hooks.auth.loader

  const result = await loader(async () => ({ type: "token" }))

  assert.deepEqual(result, {})
})

test("snapshot plugin auth loader builds baseURL from oauth enterpriseUrl", async () => {
  const { CopilotAuthPlugin } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  const hooks = await CopilotAuthPlugin({})
  const loader = hooks.auth.loader

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
  const { CopilotAuthPlugin, officialCopilotExportBridge } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  let reads = 0
  const bridgeOptions = {
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
  }

  const auth = async () => {
    reads += 1
    return {
      type: "oauth",
      refresh: reads === 1 ? "stale-refresh" : "fresh-refresh",
      access: "access-token",
      expires: 0,
    }
  }

  const hooks = await officialCopilotExportBridge.run(bridgeOptions, async () => CopilotAuthPlugin({}))
  const result = await officialCopilotExportBridge.run(bridgeOptions, async () => hooks.auth.loader(auth))
  assert.equal(typeof result.fetch, "function")

  await officialCopilotExportBridge.run(bridgeOptions, async () => result.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: new Headers({
      authorization: "bad-auth",
      "x-api-key": "bad-key",
      "x-trace-id": "keep-me",
    }),
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  }))

  assert.equal(reads, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Authorization, "Bearer fresh-refresh")
  assert.equal(calls[0].headers["Openai-Intent"], "conversation-edits")
  assert.equal(calls[0].headers["x-api-key"], undefined)
  assert.equal(calls[0].headers.authorization, undefined)
})

test("snapshot loader keeps fetch injection isolated across concurrent calls", async () => {
  const calls = []
  const { CopilotAuthPlugin, officialCopilotExportBridge } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  let releaseAuth
  const authGate = new Promise((resolve) => {
    releaseAuth = resolve
  })
  let delayedReads = 0

  const delayedOptions = {
    version: "first",
    fetchImpl: async (_input, init) => {
      calls.push({ loader: "first", userAgent: init?.headers?.["User-Agent"] })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  }
  const immediateOptions = {
    version: "second",
    fetchImpl: async (_input, init) => {
      calls.push({ loader: "second", userAgent: init?.headers?.["User-Agent"] })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  }
  const delayedHooks = await officialCopilotExportBridge.run(delayedOptions, async () => CopilotAuthPlugin({}))
  const immediateHooks = await officialCopilotExportBridge.run(immediateOptions, async () => CopilotAuthPlugin({}))

  const delayed = await officialCopilotExportBridge.run(delayedOptions, async () => delayedHooks.auth.loader(async () => {
    delayedReads += 1
    if (delayedReads === 2) {
      await authGate
    }
    return { type: "oauth", refresh: "first-refresh", access: "first-access", expires: 0 }
  }))
  const immediate = await officialCopilotExportBridge.run(immediateOptions, async () => immediateHooks.auth.loader(async () => ({
    type: "oauth",
    refresh: "second-refresh",
    access: "second-access",
    expires: 0,
  })))

  const pending = officialCopilotExportBridge.run(delayedOptions, async () => delayed.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  }))

  await officialCopilotExportBridge.run(immediateOptions, async () => immediate.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  }))

  releaseAuth()
  await pending

  assert.deepEqual(calls, [
    { loader: "second", userAgent: "opencode/second" },
    { loader: "first", userAgent: "opencode/first" },
  ])
})

test("snapshot loader does not leak fetch injection to unrelated global fetch calls", async () => {
  const calls = []
  const { CopilotAuthPlugin, officialCopilotExportBridge } = await import("../dist/upstream/copilot-plugin.snapshot.js")
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
    const bridgeOptions = {
      version: "isolated",
      fetchImpl: async (_input, init) => {
        calls.push({ loader: "wrapped", userAgent: init?.headers?.["User-Agent"] })
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    }
    const hooks = await officialCopilotExportBridge.run(bridgeOptions, async () => CopilotAuthPlugin({}))

    const result = await officialCopilotExportBridge.run(bridgeOptions, async () => hooks.auth.loader(async () => {
      reads += 1
      if (reads === 2) {
        await authGate
      }
      return { type: "oauth", refresh: "refresh", access: "access", expires: 0 }
    }))

    const pending = officialCopilotExportBridge.run(bridgeOptions, async () => result.fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    }))

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

test("snapshot source preserves the canonical upstream copilot plugin structure", async () => {
  const source = await readFile(new URL("../src/upstream/copilot-plugin.snapshot.ts", import.meta.url), "utf8")

  assert.match(source, /Repository: https:\/\/github\.com\/anomalyco\/opencode/)
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

test("CopilotAuthPlugin adapter source consumes official plugin hooks directly", async () => {
  const source = await readFile(new URL("../src/upstream/copilot-loader-adapter.ts", import.meta.url), "utf8")

  assert.match(source, /CopilotAuthPlugin/)
  assert.match(source, /hooks\.auth\?\.loader/)
  assert.match(source, /hooks\["chat\.headers"\]/)
  assert.doesNotMatch(source, /createOfficialCopilotLoader/)
  assert.doesNotMatch(source, /createOfficialCopilotChatHeaders/)
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

test("adapter keeps baseFetch and version isolated across concurrent calls", async () => {
  const calls = []
  const { loadOfficialCopilotConfig } = await import("../dist/upstream/copilot-loader-adapter.js")
  let releaseFirstAuth
  const firstAuthGate = new Promise((resolve) => {
    releaseFirstAuth = resolve
  })
  let firstReads = 0

  const firstConfig = await loadOfficialCopilotConfig({
    getAuth: async () => {
      firstReads += 1
      if (firstReads === 2) {
        await firstAuthGate
      }
      return { type: "oauth", refresh: "first-refresh", access: "first-access", expires: 0 }
    },
    version: "first",
    baseFetch: async (_input, init) => {
      calls.push({ loader: "first", userAgent: init?.headers?.["User-Agent"] })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  const secondConfig = await loadOfficialCopilotConfig({
    getAuth: async () => ({ type: "oauth", refresh: "second-refresh", access: "second-access", expires: 0 }),
    version: "second",
    baseFetch: async (_input, init) => {
      calls.push({ loader: "second", userAgent: init?.headers?.["User-Agent"] })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  assert.ok(firstConfig)
  assert.ok(secondConfig)

  const pending = firstConfig.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  await secondConfig.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  releaseFirstAuth()
  await pending

  assert.deepEqual(calls, [
    { loader: "second", userAgent: "opencode/second" },
    { loader: "first", userAgent: "opencode/first" },
  ])
})

test("loadOfficialCopilotChatHeaders returns the official plugin chat headers hook behavior", async () => {
  const { CopilotAuthPlugin } = await import("../dist/upstream/copilot-plugin.snapshot.js")
  const { loadOfficialCopilotChatHeaders } = await import("../dist/upstream/copilot-loader-adapter.js")

  function createClientRecorder() {
    const calls = []
    return {
      calls,
      client: {
        session: {
          message: async (input) => {
            calls.push({ type: "message", input })
            return {
              data: {
                parts: [],
              },
            }
          },
          get: async (input) => {
            calls.push({ type: "get", input })
            return {
              data: {
                parentID: "parent-session",
              },
            }
          },
        },
      },
    }
  }

  const directClient = createClientRecorder()
  const adapterClient = createClientRecorder()
  const directHooks = await CopilotAuthPlugin({
    client: directClient.client,
    directory: "/tmp/project",
  })
  const directHook = directHooks["chat.headers"]
  const adaptedHook = await loadOfficialCopilotChatHeaders({
    client: adapterClient.client,
    directory: "/tmp/project",
  })
  const hookInput = {
    sessionID: "session-123",
    agent: "task",
    model: {
      providerID: "github-copilot",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    },
    provider: {
      source: "custom",
      info: {},
      options: {},
    },
    message: {
      id: "message-456",
      sessionID: "session-123",
    },
  }
  const directOutput = {
    headers: {},
  }
  const adaptedOutput = {
    headers: {},
  }

  await directHook(hookInput, directOutput)
  await adaptedHook(hookInput, adaptedOutput)

  assert.deepEqual(adaptedOutput, directOutput)
  assert.deepEqual(adapterClient.calls, directClient.calls)
  assert.deepEqual(adaptedOutput.headers, {
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-initiator": "agent",
  })
})
