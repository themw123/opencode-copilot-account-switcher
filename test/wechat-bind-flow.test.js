import test from "node:test"
import assert from "node:assert/strict"

async function loadBindFlowOrFail() {
  try {
    return await import("../dist/wechat/bind-flow.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("wechat bind flow module is missing: ../dist/wechat/bind-flow.js")
    }
    throw error
  }
}

async function loadMenuRuntimeOrFail() {
  try {
    return await import("../dist/menu-runtime.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("menu runtime module is missing: ../dist/menu-runtime.js")
    }
    throw error
  }
}

test("wechat-bind action triggers real flow and keeps menu running", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const bindFlow = await loadBindFlowOrFail()

  let showMenuCalls = 0
  let bindCalls = 0

  const adapter = {
    key: "test",
    loadStore: async () => ({ active: "alpha", autoRefresh: false, refreshMinutes: 15, accounts: { alpha: { name: "alpha" } } }),
    writeStore: async () => {},
    bootstrapAuthImport: async () => false,
    authorizeNewAccount: async () => undefined,
    refreshSnapshots: async () => {},
    toMenuInfo: async () => [{ name: "alpha", index: 0, isCurrent: true }],
    getCurrentEntry: (store) => store.accounts[store.active],
    getRefreshConfig: () => ({ enabled: false, minutes: 15 }),
    getAccountByName: () => undefined,
    switchAccount: async () => {},
    applyAction: async (_store, action) => {
      if (action.name !== "wechat-bind") return false
      bindCalls += 1
      await bindFlow.runWechatBindFlow({
        action: "wechat-bind",
        loadPublicHelpers: async () => ({
          latestAccountState: { accountId: "acc-flow", token: "token", baseUrl: "https://internal.example" },
          qrGateway: {
            loginWithQrStart: () => ({ sessionKey: "s1" }),
            loginWithQrWait: () => ({ connected: true, userId: "user-flow" }),
          },
          accountHelpers: {
            listAccountIds: async () => ["acc-flow"],
            resolveAccount: async () => ({ enabled: true, name: "Flow Account" }),
            describeAccount: async () => ({ configured: true }),
          },
        }),
        bindOperator: async () => ({ wechatAccountId: "acc-flow", userId: "user-flow", boundAt: 1710000000000 }),
        readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
        writeCommonSettings: async () => {},
        now: () => 1710000000000,
      })
      return true
    },
  }

  const actions = [{ type: "provider", name: "wechat-bind" }, { type: "cancel" }]
  await runProviderMenu({
    adapter,
    showMenu: async () => {
      showMenuCalls += 1
      return actions.shift() ?? { type: "cancel" }
    },
  })

  assert.equal(bindCalls, 1)
  assert.equal(showMenuCalls, 2)
})

test("wechat bind flow writes binding status to common settings", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const writes = []
  const result = await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: { accountId: "acc-1", token: "token", baseUrl: "https://internal.example" },
      qrGateway: {
        loginWithQrStart: () => ({ sessionKey: "s-1" }),
        loginWithQrWait: () => ({ connected: true, userId: "user-1" }),
      },
      accountHelpers: {
        listAccountIds: async () => ["acc-1"],
        resolveAccount: async () => ({ enabled: true, name: "主账号" }),
        describeAccount: async () => ({ configured: true }),
      },
    }),
    bindOperator: async (binding) => binding,
    readCommonSettings: async () => ({
      wechat: {
        notifications: {
          enabled: true,
          question: false,
          permission: true,
          sessionError: false,
        },
      },
    }),
    writeCommonSettings: async (settings) => {
      writes.push(settings)
    },
    now: () => 1711000000000,
  })

  assert.equal(result.accountId, "acc-1")
  assert.equal(result.userId, "user-1")
  assert.equal(result.name, "主账号")
  assert.equal(result.enabled, true)
  assert.equal(result.configured, true)
  assert.equal(result.boundAt, 1711000000000)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].wechat.primaryBinding, {
    accountId: "acc-1",
    userId: "user-1",
    name: "主账号",
    enabled: true,
    configured: true,
    boundAt: 1711000000000,
  })
})

test("wechat bind flow throws explicit error when binding fails", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-err", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-err" }),
          loginWithQrWait: () => ({ connected: true, userId: "user-err" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-err"],
          resolveAccount: async () => ({ enabled: true, name: "Err Account" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async () => {
        throw new Error("operator already bound to another user")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1712000000000,
    }),
    /wechat bind failed: operator already bound to another user/i,
  )
})

test("wechat rebind flow uses rebindOperator branch and keeps old binding on failure", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let bindCalled = 0
  let rebindCalled = 0
  let writeCalled = 0

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-rebind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-rb", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-rb" }),
          loginWithQrWait: () => ({ connected: true, userId: "user-rb" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-rb"],
          resolveAccount: async () => ({ enabled: true, name: "RB Account" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async () => {
        bindCalled += 1
        throw new Error("bind path should not be used for rebind")
      },
      rebindOperator: async () => {
        rebindCalled += 1
        throw new Error("rebind rejected by upstream")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {
        writeCalled += 1
      },
      now: () => 1713000000000,
    }),
    /wechat rebind failed: rebind rejected by upstream/i,
  )

  assert.equal(bindCalled, 0)
  assert.equal(rebindCalled, 1)
  assert.equal(writeCalled, 0)
})

test("wechat bind and rebind keep consistent explicit error prefix", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-a", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-a" }),
          loginWithQrWait: () => ({ connected: true, userId: "user-a" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-a"],
          resolveAccount: async () => ({ enabled: true, name: "A" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async () => {
        throw new Error("operator write failed")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1714000000000,
    }),
    /wechat bind failed: operator write failed/i,
  )

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-rebind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-b", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-b" }),
          loginWithQrWait: () => ({ connected: true, userId: "user-b" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-b"],
          resolveAccount: async () => ({ enabled: true, name: "B" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      rebindOperator: async () => {
        throw new Error("operator write failed")
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {},
      now: () => 1714000000001,
    }),
    /wechat rebind failed: operator write failed/i,
  )
})

test("writeCommonSettings failure rolls back operator binding for retry safety", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  let bindCalled = 0
  let rollbackCalled = 0

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-bind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-rb2", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-rb2" }),
          loginWithQrWait: () => ({ connected: true, userId: "user-rb2" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-rb2"],
          resolveAccount: async () => ({ enabled: true, name: "Rollback Account" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      bindOperator: async (binding) => {
        bindCalled += 1
        return binding
      },
      resetOperatorBinding: async () => {
        rollbackCalled += 1
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {
        throw new Error("disk full")
      },
      now: () => 1715000000000,
    }),
    /wechat bind failed: disk full/i,
  )

  assert.equal(bindCalled, 1)
  assert.equal(rollbackCalled, 1)
})

test("writeCommonSettings failure in rebind restores previous operator binding", async () => {
  const { runWechatBindFlow } = await loadBindFlowOrFail()

  const rebindCalls = []
  let resetCalled = 0
  const previousBinding = {
    wechatAccountId: "acc-old",
    userId: "user-old",
    boundAt: 1715999999999,
  }

  await assert.rejects(
    () => runWechatBindFlow({
      action: "wechat-rebind",
      loadPublicHelpers: async () => ({
        latestAccountState: { accountId: "acc-new", token: "token", baseUrl: "https://internal.example" },
        qrGateway: {
          loginWithQrStart: () => ({ sessionKey: "s-recover" }),
          loginWithQrWait: () => ({ connected: true, userId: "user-new" }),
        },
        accountHelpers: {
          listAccountIds: async () => ["acc-new"],
          resolveAccount: async () => ({ enabled: true, name: "Recover Account" }),
          describeAccount: async () => ({ configured: true }),
        },
      }),
      rebindOperator: async (binding) => {
        rebindCalls.push(binding)
        return binding
      },
      readOperatorBinding: async () => previousBinding,
      resetOperatorBinding: async () => {
        resetCalled += 1
      },
      readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
      writeCommonSettings: async () => {
        throw new Error("disk full")
      },
      now: () => 1716000000000,
    }),
    /wechat rebind failed: disk full/i,
  )

  assert.equal(rebindCalls.length, 2)
  assert.deepEqual(rebindCalls[0], {
    wechatAccountId: "acc-new",
    userId: "user-new",
    boundAt: 1716000000000,
  })
  assert.deepEqual(rebindCalls[1], previousBinding)
  assert.equal(resetCalled, 0)
})
