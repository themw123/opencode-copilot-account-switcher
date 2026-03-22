import test from "node:test"
import assert from "node:assert/strict"

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

function createStore() {
  return {
    active: "alpha",
    autoRefresh: true,
    refreshMinutes: 15,
    accounts: {
      alpha: { name: "alpha" },
      beta: { name: "beta" },
    },
  }
}

function createEmptyStore() {
  return {
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
    accounts: {},
  }
}

function createAdapter(store, calls) {
  return {
    key: "test",
    loadStore: async () => store,
    writeStore: async (_store, meta) => {
      calls.write.push(meta)
    },
    bootstrapAuthImport: async (_store) => {
      calls.bootstrap += 1
      return calls.bootstrap === 1
    },
    authorizeNewAccount: async () => ({ name: "gamma" }),
    refreshSnapshots: async () => {
      calls.refresh += 1
    },
    toMenuInfo: async () => Object.keys(store.accounts).map((name, index) => ({
      name,
      index,
      isCurrent: store.active === name,
    })),
    getCurrentEntry: (nextStore) => nextStore.active ? nextStore.accounts[nextStore.active] : undefined,
    getRefreshConfig: (nextStore) => ({ enabled: nextStore.autoRefresh === true, minutes: nextStore.refreshMinutes ?? 15 }),
    getAccountByName: (nextStore, name) => {
      const item = Object.entries(nextStore.accounts).find(([key]) => key === name)
      if (!item) return undefined
      return { name: item[0], entry: item[1] }
    },
    addAccount: (nextStore, entry) => {
      nextStore.accounts[entry.name] = entry
      return true
    },
    removeAccount: (nextStore, name) => {
      delete nextStore.accounts[name]
      if (nextStore.active === name) nextStore.active = Object.keys(nextStore.accounts)[0]
      return true
    },
    removeAllAccounts: (nextStore) => {
      nextStore.accounts = {}
      nextStore.active = undefined
      return true
    },
    switchAccount: async (nextStore, name) => {
      calls.switches.push(name)
      nextStore.active = name
    },
    applyAction: async (_nextStore, action) => {
      calls.provider.push(action.name)
      return true
    },
  }
}

test("menu runtime bootstraps auth import only once across multiple menu iterations", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const calls = { bootstrap: 0, refresh: 0, switches: [], write: [], provider: [] }
  const store = createEmptyStore()
  const adapter = createAdapter(store, calls)
  let menuCalls = 0

  const result = await runProviderMenu({
    adapter,
    now: () => 1,
    showMenu: async () => {
      menuCalls += 1
      return menuCalls === 1 ? { type: "provider", name: "noop" } : { type: "cancel" }
    },
  })

  assert.equal(menuCalls, 2)
  assert.equal(calls.bootstrap, 1)
  assert.equal(calls.write.filter((item) => item.reason === "bootstrap-auth-import").length, 1)
  assert.equal(result, undefined)
})

test("menu runtime returns current account on cancel after switch", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const calls = { bootstrap: 0, refresh: 0, switches: [], write: [], provider: [] }
  const store = createStore()
  const adapter = createAdapter(store, calls)
  const actions = [
    { type: "switch", account: { name: "beta" } },
    { type: "cancel" },
  ]

  const result = await runProviderMenu({
    adapter,
    now: () => 1,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.deepEqual(calls.switches, ["beta"])
  assert.equal(calls.write.some((item) => item.reason === "persist-account-switch"), true)
  assert.equal(result?.name, "beta")
})

test("menu runtime handles remove and remove-all via shared flow", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const calls = { bootstrap: 0, refresh: 0, switches: [], write: [], provider: [] }
  const store = createStore()
  const adapter = createAdapter(store, calls)
  const actions = [
    { type: "remove", account: { name: "alpha" } },
    { type: "remove-all" },
    { type: "cancel" },
  ]

  const result = await runProviderMenu({
    adapter,
    now: () => 1,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(calls.write.some((item) => item.reason === "remove-account"), true)
  assert.equal(calls.write.some((item) => item.reason === "remove-all"), true)
  assert.equal(result, undefined)
})

test("menu runtime only triggers auto refresh when interval elapses", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const calls = { bootstrap: 0, refresh: 0, switches: [], write: [], provider: [] }
  const store = createStore()
  const adapter = createAdapter(store, calls)
  let now = 0
  const actions = [
    { type: "provider", name: "noop" },
    { type: "provider", name: "noop" },
    { type: "cancel" },
  ]

  const resultPromise = runProviderMenu({
    adapter,
    now: () => now,
    showMenu: async () => {
      const action = actions.shift() ?? { type: "cancel" }
      now += action.type === "cancel" ? 0 : 5 * 60_000
      return action
    },
  })

  const result = await resultPromise

  assert.equal(calls.refresh, 1)
  assert.equal(calls.write.filter((item) => item.reason === "auto-refresh").length, 1)
  assert.equal(result?.name, "alpha")
})

test("menu runtime persists provider action reason and skips writes when no change occurred", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const calls = { bootstrap: 0, refresh: 0, switches: [], write: [], provider: [] }
  const store = createStore()
  const adapter = {
    ...createAdapter(store, calls),
    applyAction: async (_store, action) => action.name === "changed",
  }
  const actions = [
    { type: "provider", name: "unchanged" },
    { type: "provider", name: "changed" },
    { type: "switch", account: { name: "missing" } },
    { type: "cancel" },
  ]

  await runProviderMenu({
    adapter,
    now: () => 1,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(calls.write.some((item) => item.reason === "provider-action:changed"), true)
  assert.equal(calls.write.some((item) => item.reason === "provider-action:unchanged"), false)
  assert.equal(calls.switches.length, 0)
})

test("menu runtime skips writes when add/remove/remove-all report no change", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const calls = { bootstrap: 0, refresh: 0, switches: [], write: [], provider: [] }
  const store = createStore()
  const adapter = {
    ...createAdapter(store, calls),
    authorizeNewAccount: async () => undefined,
    addAccount: () => false,
    removeAccount: () => false,
    removeAllAccounts: () => false,
  }
  const actions = [
    { type: "add" },
    { type: "remove", account: { name: "alpha" } },
    { type: "remove-all" },
    { type: "cancel" },
  ]

  await runProviderMenu({
    adapter,
    now: () => 1,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(calls.write.some((item) => item.reason === "add-account"), false)
  assert.equal(calls.write.some((item) => item.reason === "remove-account"), false)
  assert.equal(calls.write.some((item) => item.reason === "remove-all"), false)
})

test("menu runtime persists successful add action", async () => {
  const { runProviderMenu } = await loadMenuRuntimeOrFail()
  const calls = { bootstrap: 0, refresh: 0, switches: [], write: [], provider: [] }
  const store = createStore()
  const adapter = createAdapter(store, calls)
  const actions = [
    { type: "add" },
    { type: "cancel" },
  ]

  const result = await runProviderMenu({
    adapter,
    now: () => 1,
    showMenu: async () => actions.shift() ?? { type: "cancel" },
  })

  assert.equal(store.accounts.gamma?.name, "gamma")
  assert.equal(calls.write.some((item) => item.reason === "add-account"), true)
  assert.equal(result?.name, "alpha")
})
