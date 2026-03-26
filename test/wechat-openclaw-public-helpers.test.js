import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const DIST_PUBLIC_HELPERS_MODULE = "../dist/wechat/compat/openclaw-public-helpers.js"
const DIST_ACCOUNT_ADAPTER_MODULE = "../dist/wechat/openclaw-account-adapter.js"

test("public helper loader returns guided-smoke required helpers", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)
  const loaded = await helpers.loadOpenClawWeixinPublicHelpers()

  assert.equal(loaded.entry.extensions[0], "./index.ts")
  assert.equal(typeof loaded.qrGateway.loginWithQrStart, "function")
  assert.equal(typeof loaded.qrGateway.loginWithQrWait, "function")
  assert.equal(typeof loaded.latestAccountState, "object")
  assert.equal(typeof loaded.accountHelpers, "object")
  assert.equal(typeof loaded.accountHelpers?.listAccountIds, "function")
  assert.equal(typeof loaded.accountHelpers?.resolveAccount, "function")
  assert.equal(typeof loaded.accountHelpers?.describeAccount, "function")
  assert.equal(typeof loaded.getUpdates, "function")
  assert.equal(typeof loaded.sendMessageWeixin, "function")
})

test("public helper loader bypasses config-surface account helpers and uses account wrapper source", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)

  const loaded = await helpers.loadOpenClawWeixinPublicHelpers({
    loadPublicWeixinAccountHelpers: async () => {
      throw new Error("must not read config surface")
    },
    loadOpenClawAccountHelpers: async () => ({
      listAccountIds: async () => ["acc-helper"],
      resolveAccount: async () => ({ accountId: "acc-helper", enabled: true, configured: true, userId: "u-helper" }),
      describeAccount: async () => ({ accountId: "acc-helper", enabled: true, configured: true, userId: "u-helper" }),
    }),
  })

  assert.deepEqual(await loaded.accountHelpers.listAccountIds(), ["acc-helper"])
  assert.deepEqual(await loaded.accountHelpers.resolveAccount("acc-helper"), {
    accountId: "acc-helper",
    enabled: true,
    configured: true,
    userId: "u-helper",
  })
})

test("account adapter exposes menu-safe display fields only", async () => {
  const adapter = await import(DIST_ACCOUNT_ADAPTER_MODULE)

  const account = await adapter.buildOpenClawMenuAccount({
    latestAccountState: {
      accountId: "acc-a",
      token: "token-a",
      baseUrl: "https://internal.example",
      getUpdatesBuf: "buf-a",
      userId: "u-1",
      savedAt: 1710000000000,
    },
    accountHelpers: {
      listAccountIds: async () => ["acc-a"],
      resolveAccount: async (accountId) => ({
        accountId,
        name: "主账号",
        enabled: true,
      }),
      describeAccount: async (accountId) => ({
        accountId,
        configured: true,
      }),
    },
  })

  assert.deepEqual(account, {
    accountId: "acc-a",
    name: "主账号",
    enabled: true,
    configured: true,
    userId: "u-1",
    boundAt: 1710000000000,
  })
  assert.equal("baseUrl" in account, false)
  assert.equal("getUpdatesBuf" in account, false)
})

test("account adapter absorbs upstream shape differences inside adapter", async () => {
  const adapter = await import(DIST_ACCOUNT_ADAPTER_MODULE)

  const account = await adapter.buildOpenClawMenuAccount({
    latestAccountState: {
      accountId: "acc-b",
      token: "token-b",
      baseUrl: "https://internal.example",
      getUpdatesBuf: "buf-b",
    },
    accountHelpers: {
      listAccountIds: async () => ["acc-b"],
      resolveAccount: async () => ({
        id: "acc-b",
        displayName: "2.0.1 账号",
        isEnabled: 1,
        user_id: "u-2",
      }),
      describeAccount: async (input) => {
        if (typeof input === "object" && input !== null) {
          return {
            configured: true,
            savedAt: 1711111111111,
          }
        }
        return undefined
      },
    },
  })

  assert.deepEqual(account, {
    accountId: "acc-b",
    name: "2.0.1 账号",
    enabled: true,
    configured: true,
    userId: "u-2",
    boundAt: 1711111111111,
  })
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

test("public helper loader assembles wrappers without function-length probing", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)
  const loaded = await helpers.loadOpenClawWeixinPublicHelpers({
    loadPublicWeixinQrGateway: async () => ({
      gateway: {
        loginWithQrStart: async (params) => ({ sessionKey: params?.accountId ?? "s" }),
        loginWithQrWait: async (params) => ({ connected: true, accountId: params?.accountId ?? "acc" }),
      },
      pluginId: "wechat-2x",
    }),
    loadPublicWeixinAccountHelpers: async () => ({
      listAccountIds: async () => ["acc-2x"],
      resolveAccount: async (accountId) => ({ accountId, enabled: true }),
      describeAccount: async (accountIdOrInput) => ({
        accountId: typeof accountIdOrInput === "string" ? accountIdOrInput : accountIdOrInput.accountId,
        configured: true,
      }),
    }),
  })

  assert.equal(loaded.pluginId, "wechat-2x")
  assert.equal(typeof loaded.accountHelpers.resolveAccount, "function")

  const packageJsonRaw = await readFile(new URL("../package.json", import.meta.url), "utf8")
  const packageJson = JSON.parse(packageJsonRaw)
  assert.equal(packageJson.dependencies?.["@tencent-weixin/openclaw-weixin"], "2.0.1")
})

test("public helper loader uses account wrapper loader instead of config-surface helpers", async () => {
  const helpers = await import(DIST_PUBLIC_HELPERS_MODULE)

  const loaded = await helpers.loadOpenClawWeixinPublicHelpers({
    loadPublicWeixinQrGateway: async () => ({
      gateway: {
        loginWithQrStart: async () => ({ sessionKey: "s" }),
        loginWithQrWait: async () => ({ connected: true, accountId: "acc-wrapper" }),
      },
      pluginId: "wechat-2x",
    }),
    loadOpenClawAccountHelpers: async () => ({
      listAccountIds: async () => ["acc-wrapper"],
      resolveAccount: async () => ({ accountId: "acc-wrapper", enabled: true, configured: true, userId: "user-wrapper" }),
      describeAccount: async (accountIdOrInput) => ({
        accountId: typeof accountIdOrInput === "string" ? accountIdOrInput : accountIdOrInput.accountId,
        configured: true,
      }),
    }),
    loadPublicWeixinHelpers: async () => ({
      getUpdates: async () => ({ msgs: [], get_updates_buf: "buf" }),
    }),
    loadPublicWeixinSendHelper: async () => ({
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
    }),
    loadLatestWeixinAccountState: async () => null,
  })

  assert.deepEqual(await loaded.accountHelpers.listAccountIds(), ["acc-wrapper"])
  assert.deepEqual(await loaded.accountHelpers.resolveAccount("acc-wrapper"), {
    accountId: "acc-wrapper",
    enabled: true,
    configured: true,
    userId: "user-wrapper",
  })
})
