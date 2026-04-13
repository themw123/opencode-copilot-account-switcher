import test from "node:test"
import assert from "node:assert/strict"

import { buildAccountActionItems, buildMenuItems, getMenuCopy, showMenuWithDeps } from "../dist/ui/menu.js"

test("getMenuCopy returns English copy", () => {
  const copy = getMenuCopy("copilot")

  assert.equal(copy.menuTitle, "GitHub Copilot accounts")
  assert.equal(copy.actionsHeading, "Actions")
  assert.equal(copy.commonSettingsHeading, "Common settings")
  assert.equal(copy.addAccount, "Add account")
})

test("getMenuCopy returns Codex-specific titles without Copilot-only wording", () => {
  const enCopy = getMenuCopy("codex")

  assert.equal(enCopy.menuTitle, "OpenAI Codex accounts")
  assert.doesNotMatch(enCopy.retryOff, /Copilot/i)
})

test("getMenuCopy keeps network retry copy provider-agnostic for Copilot", () => {
  const enCopy = getMenuCopy("copilot")

  assert.doesNotMatch(enCopy.retryOff, /Copilot/i)
})



test("buildMenuItems shows Guided Loop Safety off state when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
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
  })

  const toggle = items.find((item) => item.label === "Guided Loop Safety: On")
  assert.ok(toggle)
})

test("guided loop safety toggle is placed in common settings section", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
  })

  const labels = items.map((item) => item.label)
  const commonSettingsHeadingIndex = labels.indexOf("Common settings")
  const toggleIndex = labels.indexOf("Guided Loop Safety: Off")

  assert.equal(toggleIndex, commonSettingsHeadingIndex + 1)
})

test("guided loop safety toggle stays inside the Common settings section", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
  })

  const toggleIndex = items.findIndex((item) => item.label === "Guided Loop Safety: Off")
  const commonHeadingIndex = items.findIndex((item) => item.label === "Common settings")
  const separatorIndices = items
    .map((item, index) => (item.separator === true ? index : -1))
    .filter((index) => index >= 0)
  const commonSectionEnd = separatorIndices.find((index) => index > commonHeadingIndex) ?? -1

  assert.notEqual(toggleIndex, -1)
  assert.notEqual(commonSectionEnd, -1)
  assert.equal(toggleIndex > commonHeadingIndex, true)
  assert.equal(toggleIndex < commonSectionEnd, true)
})

test("buildMenuItems shows default policy scope when value is omitted", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
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
  })

  const labels = items.map((item) => item.label)
  const scopeIndex = labels.indexOf("Policy default scope: Copilot only")
  const slashIndex = labels.indexOf("Experimental slash commands: On")
  const retryIndex = labels.indexOf("Network Retry: Off")

  assert.equal(slashIndex, scopeIndex + 1)
  assert.equal(retryIndex, slashIndex + 1)
})

test("buildMenuItems shows Network Retry off state when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
  })

  const toggle = items.find((item) => item.label === "Network Retry: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /recover/i)
})

test("buildMenuItems shows Network Retry on state when enabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: true,
  })

  const toggle = items.find((item) => item.label === "Network Retry: On")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /recover/i)
})

test("Copilot network retry toggle is placed after slash toggle in common settings", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
  })

  const labels = items.map((item) => item.label)
  const slashIndex = labels.indexOf("Experimental slash commands: On")
  const retryIndex = labels.indexOf("Network Retry: Off")
  const commonHeadingIndex = labels.indexOf("Common settings")
  const separatorIndices = items
    .map((item, index) => (item.separator === true ? index : -1))
    .filter((index) => index >= 0)
  const commonSectionEnd = separatorIndices.find((index) => index > commonHeadingIndex) ?? -1

  assert.notEqual(slashIndex, -1)
  assert.notEqual(retryIndex, -1)
  assert.notEqual(commonSectionEnd, -1)
  assert.equal(retryIndex, slashIndex + 1)
  assert.equal(retryIndex < commonSectionEnd, true)
})

test("assign model action is placed after sync available models", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  })

  const labels = items.map((item) => item.label)
  const modelsIndex = labels.indexOf("Sync available models")
  const assignIndex = labels.indexOf("Assign one account per model")

  assert.equal(assignIndex, modelsIndex + 1)
})

test("buildMenuItems uses the updated action copy for sync-oriented items", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  })

  const labels = items.map((item) => item.label)
  assert.ok(labels.includes("Refresh quota info"))
  assert.ok(labels.includes("Sync account identity"))
  assert.ok(labels.includes("Sync available models"))
  assert.ok(labels.includes("Assign one account per model"))
})

test("buildMenuItems keeps model assignment hint coherent for model overrides", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    language: "en",
    modelAccountAssignmentCount: 3,
  })

  const action = items.find((item) => item.label === "Assign one account per model")
  assert.ok(action)
  assert.equal(action?.hint, "3 models")
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
  })

  const labels = items.map((item) => item.label)
  const retryIndex = labels.indexOf("Network Retry: Off")
  const syntheticIndex = labels.indexOf("Send synthetic messages as agent: Off")
  const providerHeadingIndex = labels.indexOf("Provider settings")
  const separatorIndices = items
    .map((item, index) => (item.separator === true ? index : -1))
    .filter((index) => index >= 0)
  const providerSectionEnd = separatorIndices.find((index) => index > providerHeadingIndex) ?? -1

  assert.notEqual(retryIndex, -1)
  assert.notEqual(syntheticIndex, -1)
  assert.notEqual(providerSectionEnd, -1)
  assert.equal(syntheticIndex > retryIndex, true)
  assert.equal(syntheticIndex < providerSectionEnd, true)
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
  })

  const toggle = items.find((item) => item.label === "Experimental slash commands: Off")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /copilot-compact/)
  assert.match(toggle?.hint ?? "", /copilot-stop-tool/)
})

test("buildMenuItems keeps common settings visible for Codex provider", () => {
  const items = buildMenuItems({
    provider: "codex",
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("Guided Loop Safety: Off"), true)
  assert.equal(labels.includes("Policy default scope: Current provider only"), true)
  assert.equal(labels.includes("Experimental slash commands: On"), true)
  assert.equal(labels.includes("Network Retry: Off"), true)
  assert.equal(labels.includes("Send synthetic messages as agent: Off"), false)
  assert.equal(labels.includes("Assign account groups per model"), false)
  assert.equal(labels.includes("Sync available models"), false)
})

test("buildMenuItems ignores provider-only capability overrides for Codex provider", () => {
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
  })

  const labels = items.map((item) => item.label)
  assert.equal(labels.includes("Guided Loop Safety: Off"), true)
  assert.equal(labels.includes("Network Retry: On"), true)
  assert.equal(labels.includes("Assign account groups per model"), false)
  assert.equal(labels.includes("Sync available models"), false)
})

test("buildMenuItems keeps section order stable for Copilot", () => {
  const items = buildMenuItems({
    provider: "copilot",
    accounts: [{ name: "alice", index: 0 }],
    refresh: { enabled: false, minutes: 15 },
    loopSafetyEnabled: false,
    loopSafetyProviderScope: "copilot-only",
    experimentalSlashCommandsEnabled: true,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
  })

  const labels = items.map((item) => item.label)
  const actionsHeadingIndex = labels.indexOf("Actions")
  const commonHeadingIndex = labels.indexOf("Common settings")
  const providerHeadingIndex = labels.indexOf("Provider settings")
  const accountsHeadingIndex = labels.indexOf("Accounts")
  const dangerHeadingIndex = labels.indexOf("Danger zone")

  assert.notEqual(actionsHeadingIndex, -1)
  assert.notEqual(commonHeadingIndex, -1)
  assert.notEqual(providerHeadingIndex, -1)
  assert.notEqual(accountsHeadingIndex, -1)
  assert.notEqual(dangerHeadingIndex, -1)
  assert.equal(actionsHeadingIndex < commonHeadingIndex, true)
  assert.equal(commonHeadingIndex < providerHeadingIndex, true)
  assert.equal(providerHeadingIndex < accountsHeadingIndex, true)
  assert.equal(accountsHeadingIndex < dangerHeadingIndex, true)
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

test("buildMenuItems shows codex workspaceName first in account hint", () => {
  const items = buildMenuItems({
    provider: "codex",
    accounts: [{
      name: "acct_workspace",
      index: 0,
      workspaceName: "workspace-visible",
      plan: "team",
      quota: {
        premium: { remaining: 42, entitlement: 100 },
        chat: { remaining: 6, entitlement: 100 },
      },
    }],
    refresh: { enabled: false, minutes: 15 },
  })

  const accountItem = items.find((item) => item.label.includes("acct_workspace"))
  assert.equal(accountItem?.hint, "workspace-visible • team")
})
