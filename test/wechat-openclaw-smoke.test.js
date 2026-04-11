import test from "node:test"
import assert from "node:assert/strict"

const DIST_GUARD_MODULE = "../dist/wechat/compat/slash-guard.js"
const DIST_SMOKE_MODULE = "../dist/wechat/compat/openclaw-smoke.js"

const NON_SLASH_TEXT = "hello wechat"
const { STAGE_A_SLASH_ONLY_MESSAGE: NON_SLASH_REJECT_TEXT } = await import(DIST_GUARD_MODULE)

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

test("self-test mode validates public helper load before slash-only checks", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const publicLoadCalls = []

  const results = await smoke.runOpenClawSmoke("self-test", {
    loadOpenClawWeixinPublicHelpers: async (options) => {
      publicLoadCalls.push(options)
      return {
        entry: { entryRelativePath: "./index.ts", entryAbsolutePath: "/tmp/index.ts", extensions: ["./index.ts"], packageJsonPath: "/tmp/package.json", packageRoot: "/tmp" },
        pluginId: "openclaw-weixin",
        qrGateway: {
          loginWithQrStart() {
            return null
          },
          loginWithQrWait() {
            return null
          },
        },
        latestAccountState: null,
        getUpdates: async () => ({ msgs: [] }),
        sendMessageWeixin: async () => ({ messageId: "mock-mid" }),
      }
    },
  })

  assert.equal(publicLoadCalls.length, 1)
  assert.deepEqual(results[0], {
    route: "public-self-test",
    status: "loaded",
    pluginId: "openclaw-weixin",
  })
  assert.equal(results[2]?.route, "stub")
  assert.equal(results[2]?.command, "status")
})

test("self-test mode stays in stub semantics and never enters real status handling", async () => {
  const smoke = await import(DIST_SMOKE_MODULE)
  const results = await smoke.runOpenClawSmoke("self-test", {
    inputs: ["/status", "/reply smoke", "/allow once"],
    loadOpenClawWeixinPublicHelpers: async () => ({
      entry: { entryRelativePath: "./index.ts", entryAbsolutePath: "/tmp/index.ts", extensions: ["./index.ts"], packageJsonPath: "/tmp/package.json", packageRoot: "/tmp" },
      pluginId: "openclaw-weixin",
      qrGateway: {
        loginWithQrStart() {
          return null
        },
        loginWithQrWait() {
          return null
        },
      },
      latestAccountState: null,
      getUpdates: async () => ({ msgs: [] }),
      sendMessageWeixin: async () => {
        throw new Error("sendMessageWeixin should not be called in smoke self-test")
      },
    }),
  })

  assert.equal(results[0].route, "public-self-test")
  assert.deepEqual(results.slice(1).map((item) => item.route), ["stub", "stub", "stub"])
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
