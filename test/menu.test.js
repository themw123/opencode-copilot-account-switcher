import test from "node:test"
import assert from "node:assert/strict"

import { buildMenuItems, getMenuCopy } from "../dist/ui/menu.js"

test("getMenuCopy returns Chinese copy by default", () => {
  const copy = getMenuCopy()

  assert.equal(copy.menuTitle, "GitHub Copilot 账号")
  assert.equal(copy.switchLanguageLabel, "Switch to English")
})

test("getMenuCopy returns English copy when requested", () => {
  const copy = getMenuCopy("en")

  assert.equal(copy.menuTitle, "GitHub Copilot accounts")
  assert.equal(copy.switchLanguageLabel, "切换到中文")
})

test("buildMenuItems shows Enable guided loop safety when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Enable guided loop safety")
  assert.ok(toggle)
  assert.equal(toggle?.hint, "Prompt-guided: fewer report interruptions, less unnecessary waiting")
})

test("buildMenuItems shows Disable guided loop safety when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: true, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: true,
    language: "en",
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
    language: "en",
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
    language: "en",
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
    language: "en",
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
    language: "en",
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
    language: "en",
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

test("assign models action is placed after Check models", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const modelsIndex = labels.indexOf("Check models")
  const assignIndex = labels.indexOf("Assign models to accounts")

  assert.equal(assignIndex, modelsIndex + 1)
})

test("buildMenuItems shows synthetic initiator enable copy and risk hint when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Enable agent initiator for synthetic messages")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /upstream/i)
  assert.match(toggle?.hint ?? "", /abuse/i)
  assert.match(toggle?.hint ?? "", /unexpected billing/i)
})

test("buildMenuItems shows synthetic initiator disable copy when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: true,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Disable agent initiator for synthetic messages")
  assert.ok(toggle)
})

test("synthetic initiator toggle is placed after network retry and before the separator", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const retryIndex = labels.indexOf("Enable Copilot network retry")
  const syntheticIndex = labels.indexOf("Enable agent initiator for synthetic messages")
  const separatorIndex = items.findIndex((item) => item.separator === true)

  assert.notEqual(retryIndex, -1)
  assert.notEqual(syntheticIndex, -1)
  assert.notEqual(separatorIndex, -1)
  assert.equal(syntheticIndex, retryIndex + 1)
  assert.equal(syntheticIndex < separatorIndex, true)
})

test("buildMenuItems includes a language switch action", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: true,
    networkRetryEnabled: false,
  })

  const toggle = items.find((item) => item.label === "Switch to English")
  assert.ok(toggle)
})
