import test from "node:test"
import assert from "node:assert/strict"

import { buildMenuItems } from "../dist/ui/menu.js"

test("buildMenuItems shows Enable guided loop safety when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
  })

  const toggle = items.find((item) => item.label === "Enable guided loop safety")
  assert.ok(toggle)
  assert.equal(toggle?.hint, "Prompt-guided: fewer report interruptions, fewer unnecessary subagents")
})

test("buildMenuItems shows Disable guided loop safety when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: true, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: true,
  })

  const toggle = items.find((item) => item.label === "Disable guided loop safety")
  assert.ok(toggle)
})

test("guided loop safety toggle is placed after Set refresh interval", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
  })

  const labels = items.map((item) => item.label)
  const intervalIndex = labels.indexOf("Set refresh interval")
  const toggleIndex = labels.indexOf("Enable guided loop safety")

  assert.equal(toggleIndex, intervalIndex + 1)
})

test("guided loop safety toggle stays inside the Actions section before the separator", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
  })

  const toggleIndex = items.findIndex((item) => item.label === "Enable guided loop safety")
  const separatorIndex = items.findIndex((item) => item.separator === true)

  assert.notEqual(toggleIndex, -1)
  assert.notEqual(separatorIndex, -1)
  assert.equal(toggleIndex < separatorIndex, true)
})

test("buildMenuItems shows Enable Copilot network retry when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  })

  const toggle = items.find((item) => item.label === "Enable Copilot network retry")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /Overrides official fetch/)
})

test("buildMenuItems shows Disable Copilot network retry when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  })

  const toggle = items.find((item) => item.label === "Disable Copilot network retry")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /Overrides official fetch/)
})

test("Copilot network retry toggle is placed after guided loop safety and before the separator", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  })

  const labels = items.map((item) => item.label)
  const loopSafetyIndex = labels.indexOf("Enable guided loop safety")
  const retryIndex = labels.indexOf("Enable Copilot network retry")
  const separatorIndex = items.findIndex((item) => item.separator === true)

  assert.notEqual(loopSafetyIndex, -1)
  assert.notEqual(retryIndex, -1)
  assert.notEqual(separatorIndex, -1)
  assert.equal(retryIndex, loopSafetyIndex + 1)
  assert.equal(retryIndex < separatorIndex, true)
})
