import test from "node:test"
import assert from "node:assert/strict"

import {
  applyMenuAction,
  buildPluginHooks,
} from "../dist/index.js"
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
