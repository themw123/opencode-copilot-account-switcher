import test from "node:test"
import assert from "node:assert/strict"

async function loadMenuModuleOrFail() {
  try {
    return await import("../dist/ui/menu.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("menu module is missing: ../dist/ui/menu.js")
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

test("wechat notifications submenu is visible with five minimal items in stable order", async () => {
  const { buildMenuItems } = await loadMenuModuleOrFail()
  const items = buildMenuItems({
    provider: "copilot",
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    loopSafetyEnabled: true,
    networkRetryEnabled: false,
    wechatNotificationsEnabled: true,
    wechatQuestionNotifyEnabled: false,
    wechatPermissionNotifyEnabled: true,
    wechatSessionErrorNotifyEnabled: false,
    language: "zh",
  })

  const labels = items.map((item) => item.label)
  const submenuHeading = labels.indexOf("微信通知")
  assert.notEqual(submenuHeading, -1)

  assert.equal(labels[submenuHeading + 1], "绑定 / 重绑微信")
  assert.equal(labels[submenuHeading + 2], "微信通知总开关：已开启")
  assert.equal(labels[submenuHeading + 3], "问题通知：已关闭")
  assert.equal(labels[submenuHeading + 4], "权限通知：已开启")
  assert.equal(labels[submenuHeading + 5], "会话错误通知：已关闭")
})

test("wechat bind menu action maps to explicit provider action", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const called = []
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
      called.push(action.name)
      return action.name === "wechat-bind"
    },
  }

  const actions = [
    { type: "provider", name: "wechat-bind" },
    { type: "cancel" },
  ]
  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.deepEqual(called, ["wechat-bind"])
})

test("wechat bind action does not trigger provider store persistence", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const writes = []
  const adapter = {
    key: "test",
    loadStore: async () => ({ active: "alpha", autoRefresh: false, refreshMinutes: 15, accounts: { alpha: { name: "alpha" } } }),
    writeStore: async (_store, meta) => {
      writes.push(meta)
    },
    bootstrapAuthImport: async () => false,
    authorizeNewAccount: async () => undefined,
    refreshSnapshots: async () => {},
    toMenuInfo: async () => [{ name: "alpha", index: 0, isCurrent: true }],
    getCurrentEntry: (store) => store.accounts[store.active],
    getRefreshConfig: () => ({ enabled: false, minutes: 15 }),
    getAccountByName: () => undefined,
    switchAccount: async () => {},
    applyAction: async (_store, action) => action.name === "wechat-bind",
  }

  const actions = [
    { type: "provider", name: "wechat-bind" },
    { type: "cancel" },
  ]
  await runProviderMenu({
    adapter,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(writes.some((meta) => meta?.actionType === "wechat-bind"), false)
  assert.equal(writes.some((meta) => String(meta?.reason ?? "").includes("wechat-bind")), false)
})
