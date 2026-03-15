import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"

import { ACCOUNT_SWITCH_TTL_MS } from "../dist/copilot-retry-notifier.js"
import { applyMenuAction } from "../dist/plugin-actions.js"
import { buildPluginHooks } from "../dist/plugin-hooks.js"
import { LOOP_SAFETY_POLICY } from "../dist/loop-safety-plugin.js"

test("plugin exposes auth and experimental chat system transform hooks", () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
    }),
  })

  assert.equal(plugin.auth?.provider, "github-copilot")
  assert.equal(typeof plugin.auth?.loader, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(typeof plugin["experimental.chat.system.transform"], "function")
})

test("plugin source does not preload upstream hook bundle for untouched hooks", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.doesNotMatch(pluginSource, /loadOfficialCopilotHooks/)
})

test("plugin chat headers only append internal session id locally", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
    }),
    loadOfficialChatHeaders: async () => async (input, output) => {
      output.headers["x-initiator"] = "agent"
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    },
  })

  const chatHeaders = plugin["chat.headers"]
  const copilotOutput = {
    headers: {
      existing: "value",
    },
  }
  const enterpriseOutput = {
    headers: {},
  }
  const googleOutput = {
    headers: {
      existing: "value",
    },
  }

  await chatHeaders?.(
    {
      sessionID: "session-123",
      agent: "build",
      model: {
        providerID: "github-copilot",
        api: {
          npm: "@ai-sdk/anthropic",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m1" },
    },
    copilotOutput,
  )
  await chatHeaders?.(
    {
      sessionID: "session-ent-123",
      agent: "build",
      model: {
        providerID: "github-copilot-enterprise",
        api: {
          npm: "@ai-sdk/github-copilot",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m2" },
    },
    enterpriseOutput,
  )
  await chatHeaders?.(
    {
      sessionID: "session-456",
      agent: "build",
      model: {
        providerID: "google",
        api: {
          npm: "@ai-sdk/google",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m3" },
    },
    googleOutput,
  )

  assert.equal(copilotOutput.headers.existing, "value")
  assert.equal(copilotOutput.headers["x-opencode-session-id"], "session-123")
  assert.equal(enterpriseOutput.headers["x-opencode-session-id"], "session-ent-123")
  assert.equal(googleOutput.headers.existing, "value")
  assert.equal(Object.hasOwn(googleOutput.headers, "x-opencode-session-id"), false)
})

test("plugin auth loader keeps official fetch when network retry is disabled", async () => {
  const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: fetchImpl,
    }),
    createRetryFetch: () => {
      throw new Error("retry wrapper should stay disabled")
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(options?.baseURL, "https://api.githubcopilot.com")
  assert.equal(options?.fetch, fetchImpl)
})

test("plugin auth loader wraps official fetch when network retry is enabled", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const wrappedFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch) => {
      calls.push(fetch)
      return wrappedFetch
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.deepEqual(calls, [officialFetch])
  assert.equal(options?.fetch, wrappedFetch)
})

test("plugin auth loader passes plugin context into retry wrapper factory", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const fakeClient = { session: { messages: async () => ({ data: [] }) } }
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
    client: fakeClient,
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].fetch, officialFetch)
  assert.equal(calls[0].ctx?.client, fakeClient)
  assert.equal(calls[0].ctx?.directory, "C:/repo")
  assert.equal(calls[0].ctx?.serverUrl?.href, "http://localhost:4096/")
})

test("plugin auth loader only wires explicitly provided account switch clear callback", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const clearCalls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
    clearAccountSwitchContext: async (lastAccountSwitchAt) => {
      clearCalls.push(lastAccountSwitchAt)
    },
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].ctx?.lastAccountSwitchAt, 1_717_171_717_171)
  assert.equal(typeof calls[0].ctx?.clearAccountSwitchContext, "function")
  await calls[0].ctx?.clearAccountSwitchContext?.()
  assert.deepEqual(clearCalls, [1_717_171_717_171])
})

test("plugin auth loader provides default account switch clear callback", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0].ctx?.clearAccountSwitchContext, "function")
})

test("plugin auth loader instantiates notifier and injects its interface into retry wrapper", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const retryCalls = []
  const toastCalls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryCalls.push({ fetch, ctx })
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next, meta) => {
      writes.push({
        lastAccountSwitchAt: next.lastAccountSwitchAt,
        loopSafetyEnabled: next.loopSafetyEnabled,
        networkRetryEnabled: next.networkRetryEnabled,
        meta,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(retryCalls.length, 1)
  assert.equal(typeof retryCalls[0].ctx?.notifier?.started, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.progress, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.repairWarning, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.completed, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.stopped, "function")
  assert.equal("tui" in retryCalls[0].ctx.notifier, false)

  await retryCalls[0].ctx.notifier.started({ remaining: 2 })
  assert.equal(toastCalls.length, 1)
  assert.match(toastCalls[0].body.message, /剩余 2 项/)
  assert.deepEqual(writes, [
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
  ])
})

test("plugin auth loader notifier is a no-op when plugin client toast sdk is unavailable", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const retryCalls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryCalls.push({ fetch, ctx })
      return fetch
    },
    writeStore: async (next, meta) => {
      writes.push({
        lastAccountSwitchAt: next.lastAccountSwitchAt,
        loopSafetyEnabled: next.loopSafetyEnabled,
        networkRetryEnabled: next.networkRetryEnabled,
        meta,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(retryCalls.length, 1)
  await assert.doesNotReject(async () => {
    await retryCalls[0].ctx.notifier.started({ remaining: 3 })
    await retryCalls[0].ctx.notifier.progress({ remaining: 2 })
    await retryCalls[0].ctx.notifier.repairWarning({ remaining: 2 })
    await retryCalls[0].ctx.notifier.completed({ remaining: 0 })
    await retryCalls[0].ctx.notifier.stopped({ remaining: 1 })
  })
  assert.deepEqual(writes, [
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
  ])
})

test("plugin auth loader notifier reads latest account switch context from store after loader setup", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const writes = []
  const now = 1_717_171_900_000
  const recentSwitchAt = now - 5_000
  const expiredSwitchAt = now - ACCOUNT_SWITCH_TTL_MS - 1
  const store = {
    active: "account",
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next) => {
      writes.push(next.lastAccountSwitchAt)
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof retryContext?.notifier?.started, "function")

  store.lastAccountSwitchAt = recentSwitchAt
  await retryContext.notifier.started({ remaining: 2 })

  assert.match(toastCalls[0].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)

  store.lastAccountSwitchAt = expiredSwitchAt
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[1].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)
  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [undefined])
})

test("plugin auth loader notifier keeps captured account-switch copy after external context clears", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const now = 1_717_171_900_000
  const initialSwitchAt = now - 5_000
  const store = {
    active: "account",
    lastAccountSwitchAt: initialSwitchAt,
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  store.lastAccountSwitchAt = undefined
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[0].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)
})


test("plugin auth loader returns empty config when official loader has no oauth config", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => undefined,
    createRetryFetch: () => {
      throw new Error("retry wrapper should not be called")
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "token" }), { models: {} })

  assert.deepEqual(options, {})
})

test("plugin menu toggle path persists loopSafetyEnabled", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: false,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-loop-safety" },
    store,
    writeStore: async (next) => {
      writes.push(next.loopSafetyEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.loopSafetyEnabled, true)
  assert.deepEqual(writes, [true])
})

test("plugin menu toggle path persists networkRetryEnabled", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-network-retry" },
    store,
    writeStore: async (next) => {
      writes.push(next.networkRetryEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.networkRetryEnabled, true)
  assert.deepEqual(writes, [true])
})

test("plugin menu toggle path forwards debug reason for loop safety writes", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: true,
    networkRetryEnabled: true,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-loop-safety" },
    store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
  })

  assert.equal(handled, true)
  assert.deepEqual(writes, [
    {
      reason: "toggle-loop-safety",
      source: "applyMenuAction",
      actionType: "toggle-loop-safety",
    },
  ])
})

test("persistAccountSwitch updates active account timestamps and persists store", async () => {
  const { persistAccountSwitch } = await import("../dist/plugin-actions.js")

  assert.equal(typeof persistAccountSwitch, "function")

  const at = 1_717_171_717_171
  const writes = []
  const store = {
    active: "old-account",
    lastAccountSwitchAt: 123,
    accounts: {
      "old-account": { name: "old-account", refresh: "r1", access: "a1", expires: 0, lastUsed: 10 },
      "new-account": { name: "new-account", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  await persistAccountSwitch({
    store,
    name: "new-account",
    at,
    writeStore: async (next) => {
      writes.push({
        active: next.active,
        lastUsed: next.accounts["new-account"].lastUsed,
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
    },
  })

  assert.equal(store.active, "new-account")
  assert.equal(store.accounts["new-account"].lastUsed, at)
  assert.equal(store.lastAccountSwitchAt, at)
  assert.deepEqual(writes, [
    {
      active: "new-account",
      lastUsed: at,
      lastAccountSwitchAt: at,
    },
  ])
})

test("activateAddedAccount records switch metadata only after switch succeeds", async () => {
  const { activateAddedAccount } = await import("../dist/plugin.js")

  assert.equal(typeof activateAddedAccount, "function")

  const writes = []
  const metas = []
  const store = {
    active: "new-account",
    accounts: {
      "new-account": { name: "new-account", refresh: "r", access: "a", expires: 0 },
    },
  }

  await activateAddedAccount({
    store,
    name: "new-account",
    switchAccount: async () => {},
    writeStore: async (next, meta) => {
      writes.push({
        active: next.active,
        lastUsed: next.accounts["new-account"].lastUsed,
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
      metas.push(meta)
    },
    now: () => 1_717_171_717_171,
  })

  assert.equal(store.active, "new-account")
  assert.equal(store.accounts["new-account"].lastUsed, 1_717_171_717_171)
  assert.equal(store.lastAccountSwitchAt, 1_717_171_717_171)
  assert.deepEqual(writes, [
    {
      active: "new-account",
      lastUsed: undefined,
      lastAccountSwitchAt: undefined,
    },
    {
      active: "new-account",
      lastUsed: 1_717_171_717_171,
      lastAccountSwitchAt: 1_717_171_717_171,
    },
  ])
  assert.deepEqual(metas, [
    {
      reason: "activate-added-account",
      source: "activateAddedAccount",
      actionType: "add",
    },
    {
      reason: "persist-account-switch",
      source: "persistAccountSwitch",
      actionType: "switch",
    },
  ])
})

test("plugin auth loader default clearAccountSwitchContext reloads and persists matching switch timestamp", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const staleStore = {
    active: "stale-account",
    lastAccountSwitchAt: 1_717_171_717_171,
    accounts: {
      "stale-account": { name: "stale-account", refresh: "r1", access: "a1", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  const freshStore = {
    active: "fresh-account",
    lastAccountSwitchAt: 1_717_171_717_171,
    accounts: {
      "fresh-account": { name: "fresh-account", refresh: "r2", access: "a2", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  const writes = []
  let loads = 0
  let clearAccountSwitchContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => {
      loads += 1
      return loads === 1 ? staleStore : freshStore
    },
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      clearAccountSwitchContext = ctx?.clearAccountSwitchContext
      return fetch
    },
    writeStore: async (next) => {
      writes.push({
        active: next.active,
        accountNames: Object.keys(next.accounts),
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof clearAccountSwitchContext, "function")
  await clearAccountSwitchContext()

  assert.equal(loads, 2)
  assert.equal(staleStore.lastAccountSwitchAt, 1_717_171_717_171)
  assert.equal(freshStore.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [
    {
      active: "fresh-account",
      accountNames: ["fresh-account"],
      lastAccountSwitchAt: undefined,
    },
  ])
})

test("plugin auth loader default clearAccountSwitchContext logs minimal diagnostics on persist failure", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const warns = []
  let clearAccountSwitchContext
  const originalWarn = console.warn

  console.warn = (...args) => {
    warns.push(args)
  }

  try {
    const plugin = buildPluginHooks({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      loadStore: async () => ({
        active: "account",
        lastAccountSwitchAt: 1_717_171_717_171,
        accounts: {
          account: { name: "account", refresh: "r", access: "a", expires: 0 },
        },
        loopSafetyEnabled: false,
        networkRetryEnabled: true,
      }),
      loadOfficialConfig: async () => ({
        baseURL: "https://api.githubcopilot.com",
        apiKey: "",
        fetch: officialFetch,
      }),
      createRetryFetch: (fetch, ctx) => {
        clearAccountSwitchContext = ctx?.clearAccountSwitchContext
        return fetch
      },
      writeStore: async () => {
        throw new Error("persist failed")
      },
    })

    await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
      models: {},
    })

    assert.equal(typeof clearAccountSwitchContext, "function")
    await clearAccountSwitchContext()
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warns.length, 1)
  assert.match(String(warns[0][0]), /plugin-hooks/i)
  assert.match(String(warns[0][0]), /clear account-switch context/i)
})

test("plugin auth loader notifier clears ttl-expired persisted switch context without changing wording", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const writes = []
  const now = 1_717_171_900_000
  const expiredSwitchAt = now - ACCOUNT_SWITCH_TTL_MS - 1
  const store = {
    active: "account",
    lastAccountSwitchAt: expiredSwitchAt,
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next) => {
      writes.push(next.lastAccountSwitchAt)
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof retryContext?.notifier?.progress, "function")
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[0].body.message, /可能因账号切换遗留的非法输入 ID/)
  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [undefined])
})

test("plugin menu wiring passes networkRetryEnabled into showMenu", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.match(pluginSource, /showMenu\(/)
  assert.match(pluginSource, /store\.loopSafetyEnabled === true/)
  assert.match(pluginSource, /store\.networkRetryEnabled === true/)
})

test("plugin switch flow prints retry hint after account switch", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.match(pluginSource, /input\[\*\]\.id too long/)
  assert.match(pluginSource, /enable Copilot Network Retry from the menu/i)
})

test("plugin transform wiring appends for Copilot and skips non-Copilot", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
  })
  const transform = plugin["experimental.chat.system.transform"]
  const copilotOutput = { system: ["base prompt"] }
  const nonCopilotOutput = { system: ["base prompt"] }

  await transform?.(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    copilotOutput,
  )
  await transform?.(
    { sessionID: "s2", model: { providerID: "google" } },
    nonCopilotOutput,
  )

  assert.equal(copilotOutput.system.at(-1), LOOP_SAFETY_POLICY)
  assert.equal(copilotOutput.system.filter((item) => item === LOOP_SAFETY_POLICY).length, 1)
  assert.equal(nonCopilotOutput.system.includes(LOOP_SAFETY_POLICY), false)
})

test("package root only exposes plugin entry and internal subpath exposes helpers", async () => {
  const root = await import("../dist/index.js")
  const internal = await import("../dist/internal.js")

  assert.equal(typeof root.CopilotAccountSwitcher, "function")
  assert.equal("buildPluginHooks" in root, false)
  assert.equal("loadOfficialCopilotConfig" in root, false)
  assert.equal(typeof internal.buildPluginHooks, "function")
  assert.equal(typeof internal.loadOfficialCopilotConfig, "function")
})
