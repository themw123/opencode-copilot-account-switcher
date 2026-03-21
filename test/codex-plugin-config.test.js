import test from "node:test"
import assert from "node:assert/strict"

import { buildPluginHooks as buildPluginHooksRaw } from "../dist/plugin-hooks.js"

function buildPluginHooks(input = {}) {
  return buildPluginHooksRaw({
    ...input,
  })
}

test("experimental slash commands enabled registers codex-status", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
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
    auth: { provider: "github-copilot", methods: [] },
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
    auth: { provider: "github-copilot", methods: [] },
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
    auth: { provider: "github-copilot", methods: [] },
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
    auth: { provider: "github-copilot", methods: [] },
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
