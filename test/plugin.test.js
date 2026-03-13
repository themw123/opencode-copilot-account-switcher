import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"

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
  assert.equal(typeof plugin["experimental.chat.system.transform"], "function")
  assert.equal(typeof plugin.auth?.loader, "function")
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

test("plugin menu wiring passes networkRetryEnabled into showMenu", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.match(pluginSource, /showMenu\(/)
  assert.match(pluginSource, /store\.loopSafetyEnabled === true/)
  assert.match(pluginSource, /store\.networkRetryEnabled === true/)
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
