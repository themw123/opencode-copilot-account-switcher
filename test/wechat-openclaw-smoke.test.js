import test from "node:test"
import assert from "node:assert/strict"

const DIST_GUARD_MODULE = "../dist/wechat/compat/slash-guard.js"
const DIST_SMOKE_MODULE = "../dist/wechat/compat/openclaw-smoke.js"

const NON_SLASH_TEXT = "hello wechat"
const NON_SLASH_REJECT_TEXT = "当前阶段仅支持命令型交互，请发送 /status、/reply 或 /allow。"

test("slash guard rejects non-slash content with fixed chinese message", async () => {
  const guard = await import(DIST_GUARD_MODULE)
  const result = guard.guardSlashOnlyInput(NON_SLASH_TEXT)

  assert.deepEqual(result, {
    accepted: false,
    message: NON_SLASH_REJECT_TEXT,
  })
})

test("slash guard accepts /status /reply /allow and normalizes command", async () => {
  const guard = await import(DIST_GUARD_MODULE)

  assert.deepEqual(guard.guardSlashOnlyInput("/status"), {
    accepted: true,
    command: "status",
    argument: "",
  })
  assert.deepEqual(guard.guardSlashOnlyInput("/reply ok"), {
    accepted: true,
    command: "reply",
    argument: "ok",
  })
  assert.deepEqual(guard.guardSlashOnlyInput("/allow   once"), {
    accepted: true,
    command: "allow",
    argument: "once",
  })
})

test("smoke harness keeps /status /reply /allow in stub paths", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const harness = smoke.createOpenClawSmokeHarness({ mode: "real-account" })

  const statusResult = await harness.handleIncomingText("/status")
  assert.equal(statusResult.route, "stub")
  assert.equal(statusResult.command, "status")

  const replyResult = await harness.handleIncomingText("/reply ack")
  assert.equal(replyResult.route, "stub")
  assert.equal(replyResult.command, "reply")

  const allowResult = await harness.handleIncomingText("/allow allow-1")
  assert.equal(allowResult.route, "stub")
  assert.equal(allowResult.command, "allow")
})

test("self-test mode validates compat host before slash-only checks", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const hostCalls = []

  const results = await smoke.runOpenClawSmoke("self-test", {
    loadCompatHost: async (api) => {
      hostCalls.push(api)
      return { id: "openclaw-weixin" }
    },
  })

  assert.equal(hostCalls.length, 1)
  assert.equal(typeof hostCalls[0]?.registerChannel, "function")
  assert.deepEqual(results[0], {
    route: "host-self-test",
    status: "loaded",
    pluginId: "openclaw-weixin",
  })
  assert.equal(results[2]?.route, "stub")
  assert.equal(results[2]?.command, "status")
})

test("self-test mode keeps command handling in stub path", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const harness = smoke.createOpenClawSmokeHarness({
    mode: "self-test",
  })

  const result = await harness.handleIncomingText("/reply should-stay-stub")

  assert.equal(result.route, "stub")
  assert.equal(result.command, "reply")
  assert.equal(result.stubReason, "stage-a-command-stub")
  assert.equal(result.mode, "self-test")
})

test("smoke harness returns fixed slash-only message for non-slash text", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const harness = smoke.createOpenClawSmokeHarness({ mode: "self-test" })
  const result = await harness.handleIncomingText(NON_SLASH_TEXT)

  assert.deepEqual(result, {
    route: "guard-reject",
    message: NON_SLASH_REJECT_TEXT,
  })
})
