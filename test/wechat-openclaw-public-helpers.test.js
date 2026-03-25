import test from "node:test"
import assert from "node:assert/strict"

const DIST_PUBLIC_HELPERS_MODULE = "../dist/wechat/compat/openclaw-public-helpers.js"

test("public helper loader returns guided-smoke required helpers", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)
  const loaded = await helpers.loadOpenClawWeixinPublicHelpers()

  assert.equal(loaded.entry.extensions[0], "./index.ts")
  assert.equal(typeof loaded.qrGateway.loginWithQrStart, "function")
  assert.equal(typeof loaded.qrGateway.loginWithQrWait, "function")
  assert.equal(typeof loaded.latestAccountState, "object")
  assert.equal(typeof loaded.getUpdates, "function")
  assert.equal(typeof loaded.sendMessageWeixin, "function")
})

test("public helper loader exposes explicit helper-missing errors", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)
  await assert.rejects(
    () =>
      helpers.loadOpenClawWeixinPublicHelpers({
        loadPublicWeixinHelpers: async () => ({ getUpdates: undefined }),
      }),
    /required helper missing: getUpdates/i,
  )

  await assert.rejects(
    () =>
      helpers.loadOpenClawWeixinPublicHelpers({
        loadPublicWeixinSendHelper: async () => ({ sendMessageWeixin: null }),
      }),
    /required helper missing: sendMessageWeixin/i,
  )
})

test("public helper module only keeps unified public loader", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)

  assert.equal(typeof helpers.loadOpenClawWeixinPublicHelpers, "function")
  assert.equal(helpers.assertMinimalWechatHostContract, undefined)
  assert.equal(helpers.createCompatHostApiStub, undefined)
  assert.equal(helpers.loadAndRegisterOpenClawWeixin, undefined)
  assert.equal(helpers.loadPublicWeixinQrGateway, undefined)
  assert.equal(helpers.loadPublicWeixinHelpers, undefined)
  assert.equal(helpers.loadPublicWeixinSendHelper, undefined)
  assert.equal(helpers.resolveOpenClawWeixinPublicEntry, undefined)
})

test("public helper keeps JITI src helper modules as default route", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)

  assert.deepEqual(helpers.OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES, {
    stateDir: "@tencent-weixin/openclaw-weixin/src/storage/state-dir.ts",
    syncBuf: "@tencent-weixin/openclaw-weixin/src/storage/sync-buf.ts",
    getUpdates: "@tencent-weixin/openclaw-weixin/src/api/api.ts",
    sendMessageWeixin: "@tencent-weixin/openclaw-weixin/src/messaging/send.ts",
  })
})
