import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFile = promisify(execFileCallback)

const DIST_SMOKE_MODULE = "../dist/wechat/compat/openclaw-smoke.js"
const DOCS_ROOT = new URL("../docs/superpowers/wechat-stage-a/", import.meta.url)
const SANITIZED_DOC = new URL("../docs/superpowers/wechat-stage-a/api-samples-sanitized.md", import.meta.url)
const GO_NO_GO_DOC = new URL("../docs/superpowers/wechat-stage-a/go-no-go.md", import.meta.url)
const EVIDENCE_README = new URL("../docs/superpowers/wechat-stage-a/evidence/README.md", import.meta.url)

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

async function runRealAccountDryRunScript() {
  const cwd = fileURLToPath(new URL("..", import.meta.url))
  if (process.platform === "win32") {
    return execFile("cmd.exe", ["/d", "/s", "/c", "npm run wechat:smoke:real-account -- --dry-run"], {
      cwd,
      env: { ...process.env },
      windowsHide: true,
    })
  }

  const npm = getNpmCommand()
  return execFile(npm, ["run", "wechat:smoke:real-account", "--", "--dry-run"], {
    cwd,
    env: { ...process.env },
    windowsHide: true,
  })
}

function parseLastJsonArray(stdout) {
  const match = stdout.match(/(\[\s*[\s\S]*\])\s*$/)
  assert.ok(match, "stdout must end with JSON array")
  return JSON.parse(match[1])
}

test("real-account dry-run outputs env vars, manual steps, artifact paths and skips binding", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  process.env.WECHAT_REAL_ACCOUNT_ID = "account-ready"
  delete process.env.WECHAT_DEVICE_ID
  delete process.env.WECHAT_CONTEXT_TOKEN
  delete process.env.WECHAT_BOT_TOKEN
  const results = await smoke.runOpenClawSmoke("real-account", {
    dryRun: true,
    inputs: ["/status"],
  })

  const dryRun = results.find((item) => item.route === "real-account-dry-run")
  assert.ok(dryRun)
  assert.equal(dryRun.binding, "skipped")
  assert.ok(Array.isArray(dryRun.requiredEnvVars))
  assert.ok(dryRun.requiredEnvVars.includes("WECHAT_REAL_ACCOUNT_ID"))
  assert.ok(Array.isArray(dryRun.missingEnvVars))
  assert.ok(dryRun.missingEnvVars.includes("WECHAT_DEVICE_ID"))
  assert.ok(Array.isArray(dryRun.manualSteps))
  assert.ok(dryRun.manualSteps.length > 0)
  assert.ok(Array.isArray(dryRun.artifactPaths))
  assert.ok(dryRun.artifactPaths.includes("docs/superpowers/wechat-stage-a/evidence/README.md"))
  delete process.env.WECHAT_REAL_ACCOUNT_ID
})

test("npm real-account dry-run command prints preparation entry and does not perform real binding", async () => {
  const { stdout } = await runRealAccountDryRunScript()
  const output = parseLastJsonArray(stdout)
  const dryRun = output.find((item) => item.route === "real-account-dry-run")

  assert.ok(dryRun)
  assert.equal(dryRun.binding, "skipped")
  assert.ok(dryRun.requiredEnvVars.includes("WECHAT_REAL_ACCOUNT_ID"))
  assert.ok(Array.isArray(dryRun.missingEnvVars))
  assert.ok(dryRun.manualSteps.includes("执行 npm run wechat:smoke:real-account -- --dry-run，确认仅输出准备信息"))
  assert.ok(dryRun.artifactPaths.includes("docs/superpowers/wechat-stage-a/go-no-go.md"))
})

test("legacy real-account entry stays in preparation mode even without dry-run flag", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  process.env.WECHAT_REAL_ACCOUNT_ID = "account-ready"
  process.env.WECHAT_DEVICE_ID = "device-ready"
  process.env.WECHAT_CONTEXT_TOKEN = "ctx-live-secret"
  process.env.WECHAT_BOT_TOKEN = "bot-live-secret"

  const results = await smoke.runOpenClawSmoke("real-account", {
    dryRun: false,
    inputs: ["/status"],
  })

  const prep = results.find((item) => item.route === "real-account-dry-run")
  assert.ok(prep)
  assert.equal(results.length, 1)
  assert.equal(prep.binding, "skipped")
  assert.equal(prep.missingEnvVars.length, 0)
  assert.ok(prep.manualSteps.some((item) => item.includes("wechat:smoke:guided")))

  delete process.env.WECHAT_REAL_ACCOUNT_ID
  delete process.env.WECHAT_DEVICE_ID
  delete process.env.WECHAT_CONTEXT_TOKEN
  delete process.env.WECHAT_BOT_TOKEN
})

test("legacy real-account entry with missing env still stays in preparation mode", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  delete process.env.WECHAT_REAL_ACCOUNT_ID
  delete process.env.WECHAT_DEVICE_ID
  delete process.env.WECHAT_CONTEXT_TOKEN
  delete process.env.WECHAT_BOT_TOKEN

  const results = await smoke.runOpenClawSmoke("real-account", {
    dryRun: false,
    inputs: ["/status"],
  })

  const prep = results.find((item) => item.route === "real-account-dry-run")
  assert.ok(prep)
  assert.equal(results.length, 1)
  assert.ok(Array.isArray(prep.missingEnvVars))
  assert.ok(prep.missingEnvVars.includes("WECHAT_REAL_ACCOUNT_ID"))
})

test("evidence docs skeleton files exist with minimum required sections", async () => {
  assert.equal(existsSync(DOCS_ROOT), true)
  assert.equal(existsSync(EVIDENCE_README), true)
  assert.equal(existsSync(SANITIZED_DOC), true)
  assert.equal(existsSync(GO_NO_GO_DOC), true)

  const evidenceReadme = await readFile(EVIDENCE_README, "utf8")
  assert.match(evidenceReadme, /^# /m)
  assert.match(evidenceReadme, /## 手测步骤/m)
  assert.match(evidenceReadme, /## 产物路径/m)
  assert.match(evidenceReadme, /## dry-run\/blocked\/known-unknown 记录/m)
})

test("sanitization rules must cover context_token bot token authorization and id/qr/device identifiers", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const sample = [
    "context_token=ctx_live_abc123",
    "bot_token=bot_live_xyz789",
    "Authorization: Bearer secret-value",
    "userId=wx_user_001",
    "botId=wx_bot_001",
    "qrCode=https://example.com/qrcode/abc",
    "deviceId=ios-udid-001",
    "messageId=msg-001",
    "requestId=req-001",
  ].join("\n")

  const sanitized = smoke.sanitizeOpenClawEvidenceSample(sample)
  assert.doesNotMatch(sanitized, /ctx_live_abc123/)
  assert.doesNotMatch(sanitized, /bot_live_xyz789/)
  assert.doesNotMatch(sanitized, /secret-value/)
  assert.doesNotMatch(sanitized, /wx_user_001/)
  assert.doesNotMatch(sanitized, /wx_bot_001/)
  assert.doesNotMatch(sanitized, /qrcode\/abc/)
  assert.doesNotMatch(sanitized, /ios-udid-001/)
  assert.doesNotMatch(sanitized, /msg-001/)
  assert.doesNotMatch(sanitized, /req-001/)
  assert.match(sanitized, /\[REDACTED_CONTEXT_TOKEN\]/)
  assert.match(sanitized, /\[REDACTED_BOT_TOKEN\]/)
  assert.match(sanitized, /\[REDACTED_AUTHORIZATION\]/)
  assert.match(sanitized, /\[REDACTED_USER_ID\]/)
  assert.match(sanitized, /\[REDACTED_BOT_ID\]/)
  assert.match(sanitized, /\[REDACTED_QR_CODE\]/)
  assert.match(sanitized, /\[REDACTED_DEVICE_ID\]/)
  assert.match(sanitized, /\[REDACTED_MESSAGE_ID\]/)
  assert.match(sanitized, /\[REDACTED_REQUEST_ID\]/)
})

test("sanitization rules also cover json style samples", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const sample = JSON.stringify({
    context_token: "ctx_json_123",
    bot_token: "bot_json_456",
    Authorization: "Bearer bearer-json",
    userId: "wx_json_user",
    botId: "wx_json_bot",
    qrCode: "https://example.com/qr/json",
    deviceId: "device-json-1",
    messageId: "json-message-id",
    requestId: "json-request-id",
  })

  const sanitized = smoke.sanitizeOpenClawEvidenceSample(sample)
  assert.doesNotMatch(sanitized, /ctx_json_123|bot_json_456|bearer-json|wx_json_user|wx_json_bot|device-json-1|qr\/json|json-message-id|json-request-id/)
})

test("go-no-go skeleton includes three hard gates", async () => {
  const content = await readFile(GO_NO_GO_DOC, "utf8")
  assert.match(content, /^# /m)
  assert.match(content, /## Go\/No-Go 硬门槛/m)
  assert.match(content, /compat host \+ 自检 3\/3 连续成功/m)
  assert.match(content, /非 slash 拒绝 \+ 告警回发 10\/10 连续成功/m)
  assert.match(content, /阶段 B 关键字段清单完整/m)
  assert.match(content, /## 测试时间与环境/m)
  assert.match(content, /## 输入与观察结果/m)
  assert.match(content, /## 证据引用/m)
  assert.match(content, /## 最终结论/m)
  assert.match(content, /known-unknown/m)
})

test("sanitized samples doc includes required sample sections and field annotations", async () => {
  const content = await readFile(SANITIZED_DOC, "utf8")
  assert.match(content, /## 登录相关真实响应结构/m)
  assert.match(content, /## getupdates 真实响应结构/m)
  assert.match(content, /## 命令消息入站结构/m)
  assert.match(content, /## 非 slash 告警回发成功响应/m)
  assert.match(content, /稳定字段/m)
  assert.match(content, /可变字段/m)
  assert.match(content, /脱敏方式/m)
})

test("evidence readme includes naming rules metadata requirements and citation rules", async () => {
  const content = await readFile(EVIDENCE_README, "utf8")
  assert.match(content, /001-bind-success\.md/m)
  assert.match(content, /时间/m)
  assert.match(content, /环境/m)
  assert.match(content, /输入/m)
  assert.match(content, /输出摘要/m)
  assert.match(content, /go-no-go\.md/m)
})
