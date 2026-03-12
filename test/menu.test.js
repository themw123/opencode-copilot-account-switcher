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
