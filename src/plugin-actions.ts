import type { StoreFile } from "./store.js"
import type { MenuAction } from "./ui/menu.js"

export async function persistAccountSwitch(input: {
  store: StoreFile
  name: string
  at: number
  writeStore: (store: StoreFile, meta?: {
    reason?: string
    source?: string
    actionType?: string
    inputStage?: string
    parsedKey?: string
  }) => Promise<void>
}) {
  input.store.active = input.name
  if (!Array.isArray(input.store.activeAccountNames) || input.store.activeAccountNames.length === 0) {
    input.store.activeAccountNames = [input.name]
  }
  input.store.accounts[input.name].lastUsed = input.at
  input.store.lastAccountSwitchAt = input.at
  await input.writeStore(input.store, {
    reason: "persist-account-switch",
    source: "persistAccountSwitch",
    actionType: "switch",
  })
}

export async function applyMenuAction(input: {
  action: MenuAction
  store: StoreFile
  writeStore: (store: StoreFile, meta?: {
    reason?: string
    source?: string
    actionType?: string
    inputStage?: string
    parsedKey?: string
  }) => Promise<void>
}): Promise<boolean> {
  if (input.action.type === "toggle-loop-safety") {
    input.store.loopSafetyEnabled = input.store.loopSafetyEnabled !== true
    await input.writeStore(input.store, {
      reason: "toggle-loop-safety",
      source: "applyMenuAction",
      actionType: "toggle-loop-safety",
    })
    return true
  }

  if (input.action.type === "toggle-loop-safety-provider-scope") {
    input.store.loopSafetyProviderScope = input.store.loopSafetyProviderScope === "all-models"
      ? "copilot-only"
      : "all-models"
    await input.writeStore(input.store, {
      reason: "toggle-loop-safety-provider-scope",
      source: "applyMenuAction",
      actionType: "toggle-loop-safety-provider-scope",
    })
    return true
  }

  if (input.action.type === "toggle-experimental-slash-commands") {
    input.store.experimentalSlashCommandsEnabled = input.store.experimentalSlashCommandsEnabled !== true
    await input.writeStore(input.store, {
      reason: "toggle-experimental-slash-commands",
      source: "applyMenuAction",
      actionType: "toggle-experimental-slash-commands",
    })
    return true
  }

  if (input.action.type === "toggle-network-retry") {
    input.store.networkRetryEnabled = input.store.networkRetryEnabled !== true
    await input.writeStore(input.store, {
      reason: "toggle-network-retry",
      source: "applyMenuAction",
      actionType: "toggle-network-retry",
    })
    return true
  }

  if (input.action.type === "toggle-synthetic-agent-initiator") {
    input.store.syntheticAgentInitiatorEnabled = input.store.syntheticAgentInitiatorEnabled !== true
    await input.writeStore(input.store, {
      reason: "toggle-synthetic-agent-initiator",
      source: "applyMenuAction",
      actionType: "toggle-synthetic-agent-initiator",
    })
    return true
  }

  return false
}
