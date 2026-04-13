import test from "node:test"
import assert from "node:assert/strict"

import { buildPluginHooks as buildPluginHooksRaw } from "../dist/plugin-hooks.js"
import { buildAccountActionItems, buildMenuItems } from "../dist/ui/menu.js"

function buildPluginHooks(input = {}) {
  return buildPluginHooksRaw({
    ...input,
  })
}

test("experimental slash commands enabled registers codex-status", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
  })

  const config = { command: {} }
  await plugin.config?.(config)

  assert.equal(typeof config.command["codex-status"], "object")
  assert.match(config.command["codex-status"].description, /Codex|status/i)
})

test("experimental slash commands disabled leaves codex-status unregistered", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: false,
    }),
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: false,
    }),
  })

  const config = {
    command: {
      "codex-status": {
        description: "preloaded command from base config",
        template: "preloaded",
      },
    },
  }
  await plugin.config?.(config)

  assert.equal(Object.hasOwn(config.command, "codex-status"), true)
  assert.equal(config.command["codex-status"].description, "preloaded command from base config")
})

test("codex-status command hook delegates only when experiment switch enabled", async () => {
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
    handleCodexStatusCommandImpl: async () => {
      delegated.push("called")
      throw new Error("codex delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "codex-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /codex delegated/,
  )
  assert.deepEqual(delegated, ["called"])
})

test("codex-status command hook does not delegate when experiment switch disabled", async () => {
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: false,
    }),
    handleCodexStatusCommandImpl: async () => {
      delegated.push("called")
      throw new Error("should not delegate")
    },
  })

  await assert.doesNotReject(() => plugin["command.execute.before"]?.(
    { command: "codex-status", sessionID: "s1", arguments: "" },
    { parts: [] },
  ))
  assert.deepEqual(delegated, [])
})

test("codex-status hook does not use copilot quota refresh path", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
    refreshQuota: async () => {
      throw new Error("copilot refresh should not run")
    },
    handleCodexStatusCommandImpl: async () => {
      throw new Error("codex delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "codex-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /codex delegated/,
  )
})

test("codex menu path keeps common settings and hides provider-specific Copilot actions", async () => {
  const items = buildMenuItems({
    provider: "codex",
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("Import from auth.json"), false)
  assert.equal(labels.includes("Sync identity information"), false)
  assert.equal(labels.includes("Sync available models"), false)
  assert.equal(labels.includes("Configure default account group"), false)
  assert.equal(labels.includes("Assign models to account groups"), false)
  assert.equal(labels.includes("Guided Loop Safety: Off"), true)
  assert.equal(labels.includes("Policy default scope: Current provider only"), true)
  assert.equal(labels.includes("Experimental slash commands: On"), true)
  assert.equal(labels.includes("Network Retry: Off"), true)
  assert.equal(labels.includes("Synthetic messages as agent: On"), false)
  assert.equal(labels.includes("Add account"), true)
  assert.equal(labels.includes("Refresh snapshots"), true)
})

test("showAccountActions keeps Codex account submenu free of Copilot-only wording", () => {
  const account = {
    name: "codex@example.com",
    index: 0,
    plan: "team",
    quota: {
      premium: { remaining: 42, entitlement: 100 },
      chat: { remaining: 6, entitlement: 100 },
    },
  }

  const items = buildAccountActionItems(account, { provider: "codex" })
  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("View models"), false)
  assert.equal(labels.includes("Switch to this account"), true)
  assert.equal(labels.includes("Remove this account"), true)
})

test("codex set-interval empty input should not coerce to one minute", async () => {
  const { createCodexMenuAdapter } = await import("../dist/providers/codex-menu-adapter.js")
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: {
      auth: {
        set: async () => {},
      },
    },
    promptText: async () => "",
  })

  const changed = await adapter.applyAction(store, { type: "provider", name: "set-interval" })
  assert.equal(changed, false)
  assert.equal(store.refreshMinutes, 15)
})

test("codex official adapter can be referenced by provider assembly hook input", async () => {
  const { loadOfficialCodexConfig } = await import("../dist/upstream/codex-loader-adapter.js")
  const plugin = buildPluginHooks({
    auth: { provider: "openai", methods: [] },
    loadOfficialConfig: loadOfficialCodexConfig,
  })

  assert.equal(typeof loadOfficialCodexConfig, "function")
  assert.equal(plugin.auth.provider, "openai")
})
