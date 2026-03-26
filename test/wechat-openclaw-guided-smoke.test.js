import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const DIST_GUIDED_MODULE = "../dist/wechat/compat/openclaw-guided-smoke.js"

function createUnifiedPublicHelpersLoader(overrides = {}) {
  return async () => ({
    entry: {
      entryRelativePath: "./index.ts",
      entryAbsolutePath: "/tmp/index.ts",
      extensions: ["./index.ts"],
      packageJsonPath: "/tmp/package.json",
      packageRoot: "/tmp",
    },
    pluginId: "openclaw-weixin",
    qrGateway: {
      loginWithQrStart() {
        return null
      },
      loginWithQrWait() {
        return null
      },
    },
    latestAccountState: {
      accountId: "account-1",
      token: "bot-token",
      baseUrl: "https://example.test",
    },
    getUpdates: async () => ({ msgs: [] }),
    sendMessageWeixin: async () => ({ messageId: "mock-mid" }),
    ...overrides,
  })
}

async function runGuidedSmokeSilently(guided, options = {}) {
  return guided.runGuidedSmoke({
    writeLine: async () => {},
    ...options,
  })
}

test("guided smoke preflight writes 001-preflight evidence", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  await runGuidedSmokeSilently(guided, {
    runId: "run-preflight-001",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 0, total: 10, failedChecks: ["preflight-only"] }),
  })

  const preflightFile = path.join(evidenceBaseDir, "run-preflight-001", "001-preflight.md")
  assert.equal(existsSync(preflightFile), true)
})

test("guided smoke preflight records cwd node version dependency versions and run id", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  await runGuidedSmokeSilently(guided, {
    runId: "run-preflight-meta",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 0, total: 10, failedChecks: ["preflight-only"] }),
    getDependencyVersions: () => ({
      "@tencent-weixin/openclaw-weixin": "1.0.2",
      openclaw: "2026.3.13",
    }),
  })

  const preflightFile = path.join(evidenceBaseDir, "run-preflight-meta", "001-preflight.md")
  const content = await readFile(preflightFile, "utf8")

  assert.match(content, /run id: `run-preflight-meta`/)
  assert.ok(content.includes(`cwd: \`${process.cwd()}\``))
  assert.match(content, /node version: `/)
  assert.match(content, /@tencent-weixin\/openclaw-weixin: `1\.0\.2`/)
  assert.match(content, /openclaw: `2026\.3\.13`/)
})

test("guided smoke preflight validates public entry load and evidence directory creation", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  await runGuidedSmokeSilently(guided, {
    runId: "run-preflight-checks",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 0, total: 10, failedChecks: ["preflight-only"] }),
  })

  const preflightFile = path.join(evidenceBaseDir, "run-preflight-checks", "001-preflight.md")
  const content = await readFile(preflightFile, "utf8")
  assert.match(content, /public entry load: `pass`/)
  assert.match(content, /evidence directory creation: `pass`/)
})

test("guided smoke preflight aborts when public helper self-test fails", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  let qrStageCalled = false

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-preflight-selftest-fail",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: false, reason: "self-test failed" }),
    runQrLogin: async () => {
      qrStageCalled = true
    },
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.equal(qrStageCalled, false)
})

test("guided smoke command invokes self-test before qr login", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const order = []

  await runGuidedSmokeSilently(guided, {
    runId: "run-order-check",
    evidenceBaseDir,
    runSelfTest: async () => {
      order.push("self-test")
      return { ok: true }
    },
    runQrLogin: async () => {
      order.push("qr-login")
    },
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
  })

  assert.deepEqual(order, ["self-test", "qr-login"])
})

test("guided smoke evidence names are fixed as 001 002 003", async () => {
  const guided = await import(DIST_GUIDED_MODULE)

  assert.deepEqual(guided.GUIDED_SMOKE_EVIDENCE_FILES, {
    preflight: "001-preflight.md",
    qrStart: "002-qr-start.md",
    loginSuccess: "003-login-success.md",
    statusCommand: "004-status-command.json",
    replyCommand: "005-reply-command.json",
    allowCommand: "006-allow-command.json",
  })
})

test("guided smoke writes 002-qr-start evidence when loginWithQrStart fails", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-start-fail",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => {
      throw new Error("loginWithQrStart failed")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  const qrStartFile = path.join(evidenceBaseDir, "run-qr-start-fail", "002-qr-start.md")
  assert.equal(existsSync(qrStartFile), true)
  const content = await readFile(qrStartFile, "utf8")
  assert.match(content, /loginWithQrStart failed/)
})

test("guided smoke uses 480000ms as default loginWithQrWait timeout", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  let observedTimeoutMs = 0

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-wait-timeout-default",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async ({ waitTimeoutMs }) => {
      observedTimeoutMs = waitTimeoutMs
      return { status: "success", qrUrl: "https://example.test/qr" }
    },
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "completed")
  assert.equal(observedTimeoutMs, 480000)
})

test("guided smoke marks blocked and known-unknown when loginWithQrWait times out", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-wait-timeout",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "timeout" }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
})

test("guided smoke writes fixed slash command evidence files", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-slash-evidence-files",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "completed")
  assert.equal(existsSync(path.join(evidenceBaseDir, "run-slash-evidence-files", "004-status-command.json")), true)
  assert.equal(existsSync(path.join(evidenceBaseDir, "run-slash-evidence-files", "005-reply-command.json")), true)
  assert.equal(existsSync(path.join(evidenceBaseDir, "run-slash-evidence-files", "006-allow-command.json")), true)
})

test("guided smoke stops before non-slash verification when slash sampling is incomplete", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  let nonSlashVerificationCalled = false

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-slash-incomplete",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success" }),
    captureSlashInbound: async (command) => {
      if (command === "reply") {
        return null
      }
      return { command, userId: "u-1", messageId: "m-1" }
    },
    runNonSlashVerification: async () => {
      nonSlashVerificationCalled = true
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.equal(nonSlashVerificationCalled, false)
})

test("guided smoke returns blocked instead of throwing when evidence directory cannot be created", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const filePath = path.join(evidenceRoot, "not-a-directory")
  await writeFile(filePath, "occupied", "utf8")

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-preflight-dir-fail",
    evidenceBaseDir: filePath,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /evidence/i)
})

test("guided smoke returns blocked when self-test throws", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-preflight-selftest-throw",
    evidenceBaseDir,
    runSelfTest: async () => {
      throw new Error("boom")
    },
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
})

test("guided smoke returns blocked when dependency resolution throws", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-preflight-deps-throw",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    getDependencyVersions: () => {
      throw new Error("deps failed")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")

   const preflightFile = path.join(evidenceBaseDir, "run-preflight-deps-throw", "001-preflight.md")
   const content = await readFile(preflightFile, "utf8")
   assert.match(content, /dependency versions: `fail`/)
})

test("guided smoke blocked result maps to non-zero exit code", async () => {
  const guided = await import(DIST_GUIDED_MODULE)

  assert.equal(guided.getGuidedSmokeExitCode({ status: "blocked", conclusion: "known-unknown" }), 1)
  assert.equal(guided.getGuidedSmokeExitCode({ status: "completed", conclusion: "known-unknown" }), 0)
})

test("guided smoke slash evidence sanitizes secrets and records outbound as none", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-slash-sanitize-outbound",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({
      command,
      context_token: "ctx-real-token",
      messageId: "msg-real-id",
      authorization: "Bearer secret-auth-token",
    }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "completed")
  const slashFile = path.join(evidenceBaseDir, "run-slash-sanitize-outbound", "004-status-command.json")
  const content = await readFile(slashFile, "utf8")
  assert.doesNotMatch(content, /ctx-real-token/)
  assert.doesNotMatch(content, /msg-real-id/)
  assert.doesNotMatch(content, /secret-auth-token/)
  assert.match(content, /\[REDACTED_CONTEXT_TOKEN\]/)
  assert.match(content, /\[REDACTED_MESSAGE_ID\]/)
  assert.match(content, /\[REDACTED_AUTHORIZATION\]/)
  assert.match(content, /"outbound"\s*:\s*\{\s*"mode"\s*:\s*"none"/)
})

test("guided smoke updates api-samples-sanitized doc after slash sampling", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const docsDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-docs-"))
  const apiSamplesPath = path.join(docsDir, "api-samples-sanitized.md")
  await writeFile(apiSamplesPath, "# API Samples\n\n", "utf8")

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-update-api-samples",
    evidenceBaseDir,
    apiSamplesDocPath: apiSamplesPath,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "completed")
  const content = await readFile(apiSamplesPath, "utf8")
  assert.match(content, /run-update-api-samples/)
  assert.match(content, /004-status-command\.json/)
  assert.match(content, /005-reply-command\.json/)
  assert.match(content, /006-allow-command\.json/)
  assert.match(content, /\/status/)
  assert.match(content, /\/reply smoke/)
  assert.match(content, /\/allow once/)
})

test("guided smoke writes final evidence before blocked when slash sampling throws", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-slash-throw-final-evidence",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async () => {
      throw new Error("capture slash exploded")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  const finalFile = path.join(evidenceBaseDir, "run-slash-throw-final-evidence", "999-final-status.md")
  assert.equal(existsSync(finalFile), true)
  const content = await readFile(finalFile, "utf8")
  assert.match(content, /stage: `slash-sampling`/)
  assert.match(content, /status: `blocked`/)
  assert.match(content, /conclusion: `known-unknown`/)
  assert.match(content, /capture slash exploded/)
})

test("guided smoke writes final evidence before blocked when non-slash verification throws", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-nonslash-throw-final-evidence",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => {
      throw new Error("nonslash exploded")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  const finalFile = path.join(evidenceBaseDir, "run-nonslash-throw-final-evidence", "999-final-status.md")
  assert.equal(existsSync(finalFile), true)
  const content = await readFile(finalFile, "utf8")
  assert.match(content, /stage: `non-slash-verification`/)
  assert.match(content, /status: `blocked`/)
  assert.match(content, /conclusion: `known-unknown`/)
  assert.match(content, /nonslash exploded/)
})

test("guided smoke treats invalid qr login result as blocked", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-invalid-result",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({}),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /invalid qr login result/i)
})

test("guided smoke surfaces qr start failure message when plugin returns no qr payload", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-start-message-only",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({
      status: "success",
      message: "Failed to start login: fetch failed",
    }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /fetch failed/i)
})

test("guided smoke accepts qrDataUrl and connected success result from public plugin auth flow", async () => {
  const guided = await import(DIST_GUIDED_MODULE)

  const normalized = guided.normalizeQrLoginResultForTest({
    status: "success",
    connected: true,
    qrDataUrl: "https://example.test/qr-data-url",
  })

  assert.deepEqual(normalized, {
    status: "success",
    connected: true,
    qrPrinted: false,
    qrUrl: "https://example.test/qr-data-url",
  })
})

test("guided smoke blocks when non-slash verification is not implemented", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-nonslash-not-implemented",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 0, total: 10, failedChecks: ["non-slash verification not implemented"] }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "no-go")
  assert.match(result.reason ?? "", /missing real inbound|non-slash verification not implemented/i)

  const nonSlashFile = path.join(evidenceBaseDir, "run-nonslash-not-implemented", "007-nonslash-warning-01.json")
  assert.equal(existsSync(nonSlashFile), true)
  const content = await readFile(nonSlashFile, "utf8")
  assert.match(content, /"routeResult"\s*:\s*"guard-reject-warning"/)
})

test("guided smoke uses default non-slash verification when no override is provided", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  let getUpdatesCalls = 0

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-default-nonslash-wired",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr", connected: true }),
    captureSlashInbound: async (command) => ({
      command,
      input: `/${command === "reply" ? "reply smoke" : command === "allow" ? "allow once" : "status"}`,
      messageId: `m-${command}`,
      fromUserId: "u-1@im.wechat",
      contextToken: `ctx-${command}`,
      text: `/${command === "reply" ? "reply smoke" : command === "allow" ? "allow once" : "status"}`,
      normalizedBy: "guided-smoke-public-structure",
    }),
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      getUpdates: async () => {
        getUpdatesCalls += 1
        return {
          msgs: Array.from({ length: 10 }, (_, index) => ({
            message_id: 800 + index,
            from_user_id: "u-1@im.wechat",
            context_token: `ctx-ns-${index + 1}`,
            create_time_ms: 1740000001000 + index,
            item_list: [{ type: 1, text_item: { text: `hello ${index + 1}` } }],
          })),
          get_updates_buf: "buf-nonslash",
        }
      },
      sendMessageWeixin: async ({ to }) => ({ messageId: `reply-${to}` }),
    }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "go")
  assert.equal(getUpdatesCalls, 1)

  const nonSlashFile = path.join(evidenceBaseDir, "run-default-nonslash-wired", "007-nonslash-warning-01.json")
  const content = await readFile(nonSlashFile, "utf8")
  assert.match(content, /hello 1/)
})

test("guided smoke non-slash verification requires 10\/10 and writes count evidence", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-nonslash-count-fail",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 8, total: 10, failedChecks: ["warn-reply"] }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "no-go")
  const nonSlashFile = path.join(evidenceBaseDir, "run-nonslash-count-fail", "007-nonslash-warning-01.json")
  assert.equal(existsSync(nonSlashFile), true)
})

test("guided smoke writes no-go with completed when non-slash is below 10/10", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-nonslash-no-go-completed",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 9, total: 10, failedChecks: ["attempt-10"] }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "no-go")
  const finalFile = path.join(evidenceBaseDir, "run-nonslash-no-go-completed", "999-final-status.md")
  const finalContent = await readFile(finalFile, "utf8")
  assert.match(finalContent, /status: `completed`/)
  assert.match(finalContent, /conclusion: `no-go`/)
})

test("guided smoke writes sequential non-slash evidence from 007-nonslash-warning-01.json", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-nonslash-sequential-files",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({
      passed: 2,
      total: 10,
      failedChecks: ["attempt-3"],
      attempts: [
        {
          inbound: { text: "hello-1", userId: "u-1", messageId: "m-1" },
          warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
          persisted: true,
        },
        {
          inbound: { text: "hello-2", userId: "u-1", messageId: "m-2" },
          warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
          persisted: true,
        },
      ],
    }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "no-go")
  assert.equal(existsSync(path.join(evidenceBaseDir, "run-nonslash-sequential-files", "007-nonslash-warning-01.json")), true)
  assert.equal(existsSync(path.join(evidenceBaseDir, "run-nonslash-sequential-files", "008-nonslash-warning-02.json")), true)
})

test("guided smoke blocks when any non-slash attempt misses required three checks", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-nonslash-missing-checks",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({
      passed: 1,
      total: 10,
      failedChecks: [],
      attempts: [
        {
          inbound: { text: "hello", userId: "u-1", messageId: "m-1" },
          warningReply: { ok: false, text: "not fixed" },
          persisted: true,
        },
      ],
    }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "no-go")
  assert.match(result.reason ?? "", /fixed warning|告警|warning/i)
})

test("guided smoke blocks when sanitized non-slash evidence still contains sensitive fields", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-nonslash-sensitive-residue",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({
      passed: 1,
      total: 10,
      failedChecks: [],
      attempts: [
        {
          inbound: { text: "hello", userId: "u-1", messageId: "m-1", ContextToken: "ctx-raw-123" },
          warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
          persisted: true,
        },
      ],
    }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /sensitive|脱敏|context/i)
})

test("guided smoke updates go-no-go and writes 090-key-fields-check evidence", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const docsDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-docs-"))
  const goNoGoPath = path.join(docsDir, "go-no-go.md")
  await writeFile(goNoGoPath, "# go-no-go\n\n", "utf8")

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-go-no-go-and-key-fields",
    evidenceBaseDir,
    goNoGoDocPath: goNoGoPath,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({
      passed: 10,
      total: 10,
      failedChecks: [],
      attempts: Array.from({ length: 10 }, (_, index) => ({
        inbound: { text: `hello-${index + 1}`, userId: "u-1", messageId: `m-${index + 1}` },
        warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
        persisted: true,
      })),
      keyFieldsCheck: {
        login: { status: "pass" },
        getupdates: { status: "pass" },
        slashInbound: { status: "pass" },
        warningReply: { status: "pass" },
      },
    }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "go")

  const keyFieldsFile = path.join(evidenceBaseDir, "run-go-no-go-and-key-fields", "090-key-fields-check.md")
  assert.equal(existsSync(keyFieldsFile), true)
  const keyFieldsContent = await readFile(keyFieldsFile, "utf8")
  assert.match(keyFieldsContent, /login fields: `pass`/)
  assert.match(keyFieldsContent, /getupdates fields: `pass`/)
  assert.match(keyFieldsContent, /slash inbound fields: `pass`/)
  assert.match(keyFieldsContent, /warning reply fields: `pass`/)

  const goNoGoContent = await readFile(goNoGoPath, "utf8")
  assert.match(goNoGoContent, /run-go-no-go-and-key-fields/)
  assert.match(goNoGoContent, /运行状态：`completed`/)
  assert.match(goNoGoContent, /最终结论：`go`/)
  assert.match(goNoGoContent, /090-key-fields-check\.md/)
})

test("guided smoke updates go-no-go on no-go path when non-slash is below 10/10", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const docsDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-docs-"))
  const goNoGoPath = path.join(docsDir, "go-no-go.md")
  await writeFile(goNoGoPath, "# go-no-go\n\n", "utf8")

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-go-no-go-no-go-path",
    evidenceBaseDir,
    goNoGoDocPath: goNoGoPath,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 9, total: 10, failedChecks: ["attempt-10"] }),
  })

  assert.equal(result.status, "completed")
  assert.equal(result.conclusion, "no-go")
  const goNoGoContent = await readFile(goNoGoPath, "utf8")
  assert.match(goNoGoContent, /run-go-no-go-no-go-path/)
  assert.match(goNoGoContent, /运行状态：`completed`/)
  assert.match(goNoGoContent, /最终结论：`no-go`/)
})

test("guided smoke updates go-no-go on blocked path instead of only final status", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const docsDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-docs-"))
  const goNoGoPath = path.join(docsDir, "go-no-go.md")
  await writeFile(goNoGoPath, "# go-no-go\n\n", "utf8")

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-go-no-go-blocked-path",
    evidenceBaseDir,
    goNoGoDocPath: goNoGoPath,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async () => {
      throw new Error("capture slash exploded")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  const goNoGoContent = await readFile(goNoGoPath, "utf8")
  assert.match(goNoGoContent, /run-go-no-go-blocked-path/)
  assert.match(goNoGoContent, /运行状态：`blocked`/)
  assert.match(goNoGoContent, /最终结论：`known-unknown`/)
})

test("guided smoke slash evidence sanitizes contextToken camelCase field", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-slash-sanitize-context-token-camel",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({
      command,
      contextToken: "ctx-camel-raw-token",
      userId: "u-1",
      messageId: "msg-1",
    }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "completed")
  const slashFile = path.join(evidenceBaseDir, "run-slash-sanitize-context-token-camel", "004-status-command.json")
  const content = await readFile(slashFile, "utf8")
  assert.doesNotMatch(content, /ctx-camel-raw-token/)
  assert.match(content, /"contextToken"\s*:\s*"\[REDACTED_CONTEXT_TOKEN\]"/)
})

test("guided smoke records final status when go-no-go update fails", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const docsRoot = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-docs-"))
  const blockedPath = path.join(docsRoot, "missing", "go-no-go.md")

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-go-no-go-update-fail",
    evidenceBaseDir,
    goNoGoDocPath: blockedPath,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({
      passed: 10,
      total: 10,
      failedChecks: [],
      attempts: Array.from({ length: 10 }, (_, index) => ({
        inbound: { text: `hello-${index + 1}`, userId: "u-1", messageId: `m-${index + 1}` },
        warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
        persisted: true,
      })),
      keyFieldsCheck: {
        login: { status: "pass" },
        getupdates: { status: "pass" },
        slashInbound: { status: "pass" },
        warningReply: { status: "pass" },
      },
    }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  const finalFile = path.join(evidenceBaseDir, "run-go-no-go-update-fail", "999-final-status.md")
  const content = await readFile(finalFile, "utf8")
  assert.match(content, /stage: `documentation-update`/)
  assert.match(content, /status: `blocked`/)
})

test("guided smoke treats qr login result with unknown status as blocked", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-unknown-status",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "qr_expired", qrUrl: "https://example.test/qr" }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
})

test("guided smoke default slash inbound capture must not fake real inbound pass", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-default-slash-no-fake",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    slashCaptureWaitTimeoutMs: 10,
    slashCapturePollIntervalMs: 5,
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      getUpdates: async () => ({ msgs: [], get_updates_buf: "buf-empty" }),
    }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /real inbound|真实入站|slash sampling incomplete/i)

  const slashFile = path.join(evidenceBaseDir, "run-default-slash-no-fake", "004-status-command.json")
  const content = await readFile(slashFile, "utf8")
  assert.match(content, /getUpdatesObservation/)
  assert.match(content, /buf-empty/)
})

test("guided smoke accepts normalized real slash inbound structures without raw protocol dumps", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const slashInputs = {
    status: {
      messageId: "m-status",
      fromUserId: "u-1@im.wechat",
      contextToken: "ctx-status",
      text: "/status",
      normalizedBy: "guided-smoke-public-structure",
    },
    reply: {
      messageId: "m-reply",
      fromUserId: "u-1@im.wechat",
      contextToken: "ctx-reply",
      text: "/reply smoke",
      normalizedBy: "guided-smoke-public-structure",
    },
    allow: {
      messageId: "m-allow",
      fromUserId: "u-1@im.wechat",
      contextToken: "ctx-allow",
      text: "/allow once",
      normalizedBy: "guided-smoke-public-structure",
    },
  }

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-real-normalized-slash-structure",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", connected: true, qrDataUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => slashInputs[command],
    runNonSlashVerification: async () => ({
      passed: 10,
      total: 10,
      attempts: Array.from({ length: 10 }, (_, index) => ({
        inbound: { text: `hello-${index + 1}`, userId: "u-1", messageId: `m-${index + 1}` },
        warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
        persisted: true,
      })),
      keyFieldsCheck: {
        login: { status: "pass" },
        getupdates: { status: "pass" },
        slashInbound: { status: "pass" },
        warningReply: { status: "pass" },
      },
    }),
  })

  assert.equal(result.status, "completed")
  const slashFile = path.join(evidenceBaseDir, "run-real-normalized-slash-structure", "004-status-command.json")
  const content = await readFile(slashFile, "utf8")
  assert.match(content, /guided-smoke-public-structure/)
  assert.doesNotMatch(content, /"rawResponse"\s*:/)
})

test("guided smoke can normalize public getUpdates message shape into slash sample structure", async () => {
  const guided = await import(DIST_GUIDED_MODULE)

  const normalized = guided.normalizeSlashInboundSampleForTest({
    command: "status",
    input: "/status",
    message: {
      message_id: 101,
      from_user_id: "u-1@im.wechat",
      context_token: "ctx-status",
      create_time_ms: 1740000000000,
      item_list: [
        {
          type: 1,
          text_item: {
            text: "/status",
          },
        },
      ],
    },
  })

  assert.deepEqual(normalized, {
    command: "status",
    input: "/status",
    messageId: 101,
    fromUserId: "u-1@im.wechat",
    contextToken: "ctx-status",
    createdAtMs: 1740000000000,
    text: "/status",
    itemTypes: [1],
    normalizedBy: "guided-smoke-public-structure",
  })
})

test("guided smoke waits for matching public getUpdates slash input in default capture path", async () => {
  const guided = await import(DIST_GUIDED_MODULE)

  let pollCount = 0
  const inbound = await guided.captureSlashInboundFromPublicMessagesForTest({
    command: "status",
    input: "/status",
    waitTimeoutMs: 2000,
    pollIntervalMs: 10,
    getMessages: async () => {
      pollCount += 1
      if (pollCount < 2) {
        return []
      }
      return [
        {
          message_id: 101,
          from_user_id: "u-1@im.wechat",
          context_token: "ctx-status",
          create_time_ms: 1740000000000,
          item_list: [
            {
              type: 1,
              text_item: { text: "/status" },
            },
          ],
        },
      ]
    },
  })

  assert.equal(pollCount, 2)
  assert.deepEqual(inbound, {
    command: "status",
    input: "/status",
    messageId: 101,
    fromUserId: "u-1@im.wechat",
    contextToken: "ctx-status",
    createdAtMs: 1740000000000,
    text: "/status",
    itemTypes: [1],
    normalizedBy: "guided-smoke-public-structure",
  })
})

test("guided smoke default slash capture can use injected public loader helpers", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const calls = []

  const inbound = await guided.captureSlashInboundDefaultForTest("status", {
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      getUpdates: async (params) => {
        calls.push(params)
        return {
          msgs: [
            {
              message_id: 201,
              from_user_id: "u-1@im.wechat",
              context_token: "ctx-status",
              create_time_ms: 1740000000001,
              item_list: [{ type: 1, text_item: { text: "/status" } }],
            },
          ],
          get_updates_buf: "buf-2",
        }
      },
    }),
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    baseUrl: "https://example.test",
    token: "bot-token",
    get_updates_buf: "",
    timeoutMs: 35000,
  })
  assert.deepEqual(inbound, {
    command: "status",
    input: "/status",
    messageId: 201,
    fromUserId: "u-1@im.wechat",
    contextToken: "ctx-status",
    createdAtMs: 1740000000001,
    text: "/status",
    itemTypes: [1],
    normalizedBy: "guided-smoke-public-structure",
  })
})

test("guided smoke default slash capture preserves later slash messages from the same getUpdates batch", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const calls = []
  const sharedState = {}

  const loadOpenClawWeixinPublicHelpers = createUnifiedPublicHelpersLoader({
    getUpdates: async (params) => {
      calls.push(params)
      if (calls.length === 1) {
        return {
          msgs: [
            {
              message_id: 301,
              from_user_id: "u-1@im.wechat",
              context_token: "ctx-status",
              create_time_ms: 1740000000100,
              item_list: [{ type: 1, text_item: { text: "/status" } }],
            },
          ],
          get_updates_buf: "buf-1",
        }
      }
      if (calls.length === 2) {
        return {
          msgs: [
            {
              message_id: 302,
              from_user_id: "u-1@im.wechat",
              context_token: "ctx-reply",
              create_time_ms: 1740000000200,
              item_list: [{ type: 1, text_item: { text: "/reply smoke" } }],
            },
            {
              message_id: 303,
              from_user_id: "u-1@im.wechat",
              context_token: "ctx-allow",
              create_time_ms: 1740000000300,
              item_list: [{ type: 1, text_item: { text: "/allow once" } }],
            },
          ],
          get_updates_buf: "buf-2",
        }
      }
      return { msgs: [], get_updates_buf: params.get_updates_buf }
    },
  })

  const statusInbound = await guided.captureSlashInboundDefaultForTest("status", {
    state: sharedState,
    loadOpenClawWeixinPublicHelpers,
    waitTimeoutMs: 100,
    pollIntervalMs: 10,
  })
  const replyInbound = await guided.captureSlashInboundDefaultForTest("reply", {
    state: sharedState,
    loadOpenClawWeixinPublicHelpers,
    waitTimeoutMs: 100,
    pollIntervalMs: 10,
  })
  const allowInbound = await guided.captureSlashInboundDefaultForTest("allow", {
    state: sharedState,
    loadOpenClawWeixinPublicHelpers,
    waitTimeoutMs: 100,
    pollIntervalMs: 10,
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((call) => call.get_updates_buf), ["", "buf-1"])
  assert.equal(statusInbound.input, "/status")
  assert.equal(replyInbound.input, "/reply smoke")
  assert.equal(allowInbound.input, "/allow once")
})

test("guided smoke default slash capture starts from persisted get_updates_buf when available", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const calls = []

  const inbound = await guided.captureSlashInboundDefaultForTest("status", {
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      latestAccountState: {
        accountId: "account-1",
        token: "bot-token",
        baseUrl: "https://example.test",
        getUpdatesBuf: "buf-saved",
      },
      getUpdates: async (params) => {
        calls.push(params)
        return {
          msgs: [
            {
              message_id: 401,
              from_user_id: "u-1@im.wechat",
              context_token: "ctx-status",
              create_time_ms: 1740000000400,
              item_list: [{ type: 1, text_item: { text: "/status" } }],
            },
          ],
          get_updates_buf: "buf-next",
        }
      },
    }),
    waitTimeoutMs: 100,
    pollIntervalMs: 10,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].get_updates_buf, "buf-saved")
  assert.equal(inbound.input, "/status")
})

test("guided smoke default non-slash verification can consume real inbound samples and warning replies", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const slashState = {}
  const publicCalls = []

  const loadOpenClawWeixinPublicHelpers = createUnifiedPublicHelpersLoader({
    getUpdates: async (params) => {
      publicCalls.push(params)
      if (publicCalls.length === 1) {
        return {
          msgs: [
            {
              message_id: 501,
              from_user_id: "u-1@im.wechat",
              context_token: "ctx-status",
              create_time_ms: 1740000000500,
              item_list: [{ type: 1, text_item: { text: "/status" } }],
            },
          ],
          get_updates_buf: "buf-1",
        }
      }
      return {
        msgs: [
          {
            message_id: 601,
            from_user_id: "u-1@im.wechat",
            context_token: "ctx-hello-1",
            create_time_ms: 1740000000600,
            item_list: [{ type: 1, text_item: { text: "hello 1" } }],
          },
          {
            message_id: 602,
            from_user_id: "u-1@im.wechat",
            context_token: "ctx-hello-2",
            create_time_ms: 1740000000700,
            item_list: [{ type: 1, text_item: { text: "hello 2" } }],
          },
        ],
        get_updates_buf: "buf-2",
      }
    },
    sendMessageWeixin: async ({ to }) => ({
      messageId: `reply-${to}`,
    }),
  })

  await guided.captureSlashInboundDefaultForTest("status", {
    state: slashState,
    loadOpenClawWeixinPublicHelpers,
    waitTimeoutMs: 100,
    pollIntervalMs: 10,
  })

  const result = await guided.runDefaultNonSlashVerificationForTest({
    state: slashState,
    loadOpenClawWeixinPublicHelpers,
    inputs: ["hello 1", "hello 2"],
    waitTimeoutMs: 100,
    pollIntervalMs: 10,
  })

  assert.equal(result.passed, 2)
  assert.equal(result.total, 2)
  assert.deepEqual(result.failedChecks, [])
  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].inbound?.text, "hello 1")
  assert.equal(result.attempts[1].inbound?.text, "hello 2")
  assert.equal(result.attempts[0].warningReply?.ok, true)
  assert.equal(result.attempts[1].warningReply?.ok, true)
  assert.equal(publicCalls[1].timeoutMs, 35000)
})

test("guided smoke only uses unified helper loader boundary", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-unified-loader-boundary",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      latestAccountState: {
        accountId: "account-1",
        token: "bot-token",
        baseUrl: "https://example.test",
      },
      getUpdates: async () => ({ msgs: [], get_updates_buf: "buf-empty" }),
      sendMessageWeixin: async () => ({ messageId: "reply-mid" }),
    }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr", connected: true }),
    loadLatestWeixinAccountState: async () => {
      throw new Error("legacy loadLatestWeixinAccountState should not be used")
    },
    loadPublicWeixinHelpers: async () => {
      throw new Error("legacy loadPublicWeixinHelpers should not be used")
    },
    loadPublicWeixinSendHelper: async () => {
      throw new Error("legacy loadPublicWeixinSendHelper should not be used")
    },
    slashCaptureWaitTimeoutMs: 10,
    slashCapturePollIntervalMs: 5,
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "blocked")
  assert.match(result.reason ?? "", /slash sampling incomplete/i)
})

test("guided smoke slash evidence keeps outbound-none and stub semantics", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-slash-stub-outbound-none",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr" }),
    captureSlashInbound: async (command) => ({ command, text: `/${command === "reply" ? "reply smoke" : command === "allow" ? "allow once" : "status"}` }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "completed")
  const statusFile = path.join(evidenceBaseDir, "run-slash-stub-outbound-none", "004-status-command.json")
  const payload = JSON.parse(await readFile(statusFile, "utf8"))
  assert.equal(payload.routeResult, "stub")
  assert.equal(payload.outbound?.mode, "none")
})

test("guided smoke prints step-by-step prompts after each confirmed stage", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))
  const lines = []

  await guided.runGuidedSmoke({
    runId: "run-progress-prompts",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr", connected: true }),
    captureSlashInbound: async (command) => ({ command, text: `/${command === "reply" ? "reply smoke" : command === "allow" ? "allow once" : "status"}` }),
    runNonSlashVerification: async () => ({
      passed: 2,
      total: 2,
      failedChecks: [],
      attempts: [
        {
          input: "hello 1",
          inbound: { text: "hello 1" },
          warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
          persisted: true,
        },
        {
          input: "hello 2",
          inbound: { text: "hello 2" },
          warningReply: { ok: true, text: "请使用 slash 命令（/status、/reply、/allow）" },
          persisted: true,
        },
      ],
      keyFieldsCheck: {
        login: { status: "pass" },
        getupdates: { status: "pass" },
        slashInbound: { status: "pass" },
        warningReply: { status: "pass" },
      },
    }),
    writeLine: async (line) => {
      lines.push(line)
    },
  })

  const output = lines.join("\n")
  assert.match(output, /二维码登录成功.*下一步请发送 `\/status`/)
  assert.match(output, /已收到 `\/status`.*下一步请发送 `\/reply smoke`/)
  assert.match(output, /已收到 `\/reply smoke`.*下一步请发送 `\/allow once`/)
  assert.match(output, /已收到 `\/allow once`.*下一步开始发送 10 条普通文本/)
  assert.match(output, /普通文本验证进度：1\/2/)
  assert.match(output, /普通文本验证进度：2\/2/)
})

test("guided smoke treats qr success without explicit login confirmation as blocked", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-success-without-confirmation",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({ status: "success", qrUrl: "https://example.test/qr", connected: false }),
    captureSlashInbound: async (command) => ({ command, userId: "u-1", messageId: `m-${command}` }),
    runNonSlashVerification: async () => ({ passed: 10, total: 10 }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /timeout/i)
})

test("guided smoke treats qr wait connected false result as timeout-style blocked instead of invalid result", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-connected-false",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadPublicEntry: async () => ({ entryRelativePath: "./index.ts" }),
    runQrLogin: async () => ({
      status: "success",
      connected: false,
      qrDataUrl: "https://example.test/qr",
    }),
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /timeout/i)
})

test("guided smoke qr login no longer accepts legacy terminalQr-only payload", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  let waitCalled = 0
  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-legacy-terminal-only",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      qrGateway: {
        loginWithQrStart: async () => ({
          sessionKey: "s-legacy-terminal",
          terminalQr: "LEGACY-TERMINAL",
        }),
        loginWithQrWait: async () => {
          waitCalled += 1
          return { status: "success", connected: true }
        },
      },
    }),
    captureSlashInbound: async () => {
      throw new Error("should not enter slash stage")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /invalid qr login result: missing qr code or qr url/i)
  assert.equal(waitCalled, 0)
})

test("guided smoke qr login no longer accepts legacy loginUrl payload", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  let waitCalled = 0
  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-legacy-login-url",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      qrGateway: {
        loginWithQrStart: async () => ({
          sessionKey: "s-legacy-url",
          loginUrl: "https://example.test/legacy-login-url",
        }),
        loginWithQrWait: async () => {
          waitCalled += 1
          return { status: "success", connected: true }
        },
      },
    }),
    captureSlashInbound: async () => {
      throw new Error("should not enter slash stage")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /invalid qr login result: missing qr code or qr url/i)
  assert.equal(waitCalled, 0)
})

test("guided smoke qr login requires stable sessionKey and never falls back to accountId", async () => {
  const guided = await import(DIST_GUIDED_MODULE)
  const evidenceBaseDir = await mkdtemp(path.join(os.tmpdir(), "guided-smoke-test-"))

  let waitCalled = 0
  const result = await runGuidedSmokeSilently(guided, {
    runId: "run-qr-no-sessionkey-fallback",
    evidenceBaseDir,
    runSelfTest: async () => ({ ok: true }),
    loadOpenClawWeixinPublicHelpers: createUnifiedPublicHelpersLoader({
      qrGateway: {
        loginWithQrStart: async () => ({
          accountId: "acc-legacy-session",
          qrUrl: "https://example.test/qr",
        }),
        loginWithQrWait: async () => {
          waitCalled += 1
          return { status: "success", connected: true }
        },
      },
    }),
    captureSlashInbound: async () => {
      throw new Error("should not enter slash stage")
    },
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.conclusion, "known-unknown")
  assert.match(result.reason ?? "", /missing sessionKey from qr start/i)
  assert.equal(waitCalled, 0)
})
