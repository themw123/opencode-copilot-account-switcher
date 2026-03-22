import test from "node:test"
import assert from "node:assert/strict"

import { buildAccountActionItems, buildMenuItems, getMenuCopy, showMenuWithDeps } from "../dist/ui/menu.js"

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

test("getMenuCopy returns Codex-specific titles without Copilot-only wording", () => {
  const enCopy = getMenuCopy("en", "codex")
  const zhCopy = getMenuCopy("zh", "codex")

  assert.equal(enCopy.menuTitle, "OpenAI Codex accounts")
  assert.equal(zhCopy.menuTitle, "OpenAI Codex 账号")
  assert.doesNotMatch(enCopy.retryOff, /Copilot/i)
  assert.doesNotMatch(zhCopy.retryOff, /Copilot/i)
})

test("buildMenuItems shows Guided Loop Safety off state when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Guided Loop Safety: Off")
  assert.ok(toggle)
  assert.equal(toggle?.hint, "Reduce unnecessary handoff replies while work can continue")
})

test("buildMenuItems shows Guided Loop Safety on state when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: true, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: true,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Guided Loop Safety: On")
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
  const toggleIndex = labels.indexOf("Guided Loop Safety: Off")

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

  const toggleIndex = items.findIndex((item) => item.label === "Guided Loop Safety: Off")
  const separatorIndex = items.findIndex((item) => item.separator === true)

  assert.notEqual(toggleIndex, -1)
  assert.notEqual(separatorIndex, -1)
  assert.equal(toggleIndex < separatorIndex, true)
})

test("buildMenuItems shows default policy scope when value is omitted", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Policy default scope: Copilot only")
  assert.ok(toggle)
})

test("buildMenuItems shows all-models policy scope when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "all-models",
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Policy default scope: All models")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /Guided Loop Safety/i)
})

test("policy scope toggle is placed after guided loop safety", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const loopSafetyIndex = labels.indexOf("Guided Loop Safety: Off")
  const scopeIndex = labels.indexOf("Policy default scope: Copilot only")

  assert.equal(scopeIndex, loopSafetyIndex + 1)
})

test("buildMenuItems shows default experimental slash command state when value is omitted", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Experimental slash commands: On")
  assert.ok(toggle)
})

test("buildMenuItems shows experimental slash command off state when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Experimental slash commands: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /copilot-status/)
  assert.match(toggle?.hint ?? "", /copilot-inject/)
  assert.match(toggle?.hint ?? "", /copilot-policy-all-models/)
})

test("experimental slash commands toggle is placed after policy scope and before network retry", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const scopeIndex = labels.indexOf("Policy default scope: Copilot only")
  const slashIndex = labels.indexOf("Experimental slash commands: On")
  const retryIndex = labels.indexOf("Copilot Network Retry: Off")

  assert.equal(slashIndex, scopeIndex + 1)
  assert.equal(retryIndex, slashIndex + 1)
})

test("buildMenuItems shows Copilot Network Retry off state when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Copilot Network Retry: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /account switches/i)
})

test("buildMenuItems shows Copilot Network Retry on state when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: true,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Copilot Network Retry: On")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /account switches/i)
})

test("Copilot network retry toggle is placed after guided loop safety and before the separator", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const slashIndex = labels.indexOf("Experimental slash commands: On")
  const retryIndex = labels.indexOf("Copilot Network Retry: Off")
  const separatorIndex = items.findIndex((item) => item.separator === true)

  assert.notEqual(slashIndex, -1)
  assert.notEqual(retryIndex, -1)
  assert.notEqual(separatorIndex, -1)
  assert.equal(retryIndex, slashIndex + 1)
  assert.equal(retryIndex < separatorIndex, true)
})

test("assign models action is placed after default account group", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const modelsIndex = labels.indexOf("Sync available models")
  const defaultGroupIndex = labels.indexOf("Default account group")
  const assignIndex = labels.indexOf("Assign account groups per model")

  assert.equal(defaultGroupIndex, modelsIndex + 1)
  assert.equal(assignIndex, defaultGroupIndex + 1)
})

test("buildMenuItems uses the updated action copy for sync-oriented items", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  assert.ok(labels.includes("Refresh quota info"))
  assert.ok(labels.includes("Sync account identity"))
  assert.ok(labels.includes("Sync available models"))
  assert.ok(labels.includes("Assign account groups per model"))
})

test("buildMenuItems shows default account group action with coherent hint", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    language: "en",
    defaultAccountGroupCount: 2,
  })

  const action = items.find((item) => item.label === "Default account group")
  assert.ok(action)
  assert.equal(action?.hint, "2 selected")
})

test("buildMenuItems keeps model assignment hint coherent for account groups", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    language: "en",
    modelAccountAssignmentCount: 3,
  })

  const action = items.find((item) => item.label === "Assign account groups per model")
  assert.ok(action)
  assert.equal(action?.hint, "3 groups")
})

test("buildMenuItems shows synthetic initiator off state and risk hint when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Send synthetic messages as agent: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /upstream/i)
  assert.match(toggle?.hint ?? "", /billing risk/i)
  assert.match(toggle?.hint ?? "", /abuse/i)
})

test("buildMenuItems shows synthetic initiator on state when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: true,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Send synthetic messages as agent: On")
  assert.ok(toggle)
})

test("synthetic initiator toggle is placed after network retry and before the separator", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  const retryIndex = labels.indexOf("Copilot Network Retry: Off")
  const syntheticIndex = labels.indexOf("Send synthetic messages as agent: Off")
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

test("experimental slash commands hint includes compact and stop-tool commands", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: false,
    networkRetryEnabled: false,
    language: "en",
  })

  const toggle = items.find((item) => item.label === "Experimental slash commands: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /copilot-compact/)
  assert.match(toggle?.hint ?? "", /copilot-stop-tool/)
})

test("buildMenuItems hides Copilot-only actions for Codex provider", () => {
  const items = buildMenuItems({
    provider: "codex",
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("Guided Loop Safety: Off"), false)
  assert.equal(labels.includes("Policy default scope: Copilot only"), false)
  assert.equal(labels.includes("Experimental slash commands: On"), false)
  assert.equal(labels.includes("Copilot Network Retry: Off"), false)
  assert.equal(labels.includes("Assign account groups per model"), false)
  assert.equal(labels.includes("Sync available models"), false)
})

test("buildMenuItems ignores Copilot-only capability overrides for Codex provider", () => {
  const items = buildMenuItems({
    provider: "codex",
    capabilities: {
      checkModels: true,
      assignModels: true,
      loopSafety: true,
      networkRetry: true,
    },
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
    language: "en",
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("Guided Loop Safety: Off"), false)
  assert.equal(labels.includes("Network Retry: On"), false)
  assert.equal(labels.includes("Assign account groups per model"), false)
  assert.equal(labels.includes("Sync available models"), false)
})

test("buildAccountActionItems keeps Codex account submenu free of Copilot-only model wording", () => {
  const items = buildAccountActionItems({
    name: "codex-main",
    index: 0,
    plan: "team",
    modelList: {
      available: ["gpt-5"],
      disabled: [],
    },
  }, {
    provider: "codex",
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("View models"), false)
  assert.equal(labels.includes("Switch to this account"), true)
  assert.equal(labels.includes("Remove this account"), true)
})

test("showMenu routes account click into account submenu before returning runtime action", async () => {
  const account = { name: "alpha", index: 0 }
  const selected = []
  const submenu = []
  const menuSelections = [
    { type: "switch", account },
    { type: "cancel" },
  ]

  const result = await showMenuWithDeps([account], { provider: "copilot" }, {
    select: async () => {
      const next = menuSelections.shift() ?? { type: "cancel" }
      selected.push(next.type)
      return next
    },
    showAccountActions: async (nextAccount, input) => {
      submenu.push({ name: nextAccount.name, provider: input.provider })
      return "back"
    },
    confirm: async () => true,
  })

  assert.deepEqual(selected, ["switch", "cancel"])
  assert.deepEqual(submenu, [{ name: "alpha", provider: "copilot" }])
  assert.deepEqual(result, { type: "cancel" })
})

test("showMenu maps account submenu remove to remove action", async () => {
  const account = { name: "alpha", index: 0 }

  const result = await showMenuWithDeps([account], { provider: "copilot" }, {
    select: async () => ({ type: "switch", account }),
    showAccountActions: async () => "remove",
    confirm: async () => true,
  })

  assert.deepEqual(result, { type: "remove", account })
})

test("showMenu keeps provider-specific account submenu dispatch for codex and copilot", async () => {
  const account = { name: "alpha", index: 0 }
  const providers = []

  const run = async (provider) => {
    const menuSelections = [
      { type: "switch", account },
      { type: "cancel" },
    ]
    return showMenuWithDeps([account], { provider }, {
      select: async () => menuSelections.shift() ?? { type: "cancel" },
      showAccountActions: async (_account, input) => {
        providers.push(input.provider)
        return "back"
      },
      confirm: async () => true,
    })
  }

  await run("copilot")
  await run("codex")

  assert.deepEqual(providers, ["copilot", "codex"])
})
