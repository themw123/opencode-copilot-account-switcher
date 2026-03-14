import type { StoreFile } from "./store.js"
import type { MenuAction } from "./ui/menu.js"

export async function persistAccountSwitch(input: {
  store: StoreFile
  name: string
  at: number
  writeStore: (store: StoreFile) => Promise<void>
}) {
  input.store.active = input.name
  input.store.accounts[input.name].lastUsed = input.at
  input.store.lastAccountSwitchAt = input.at
  await input.writeStore(input.store)
}

export async function applyMenuAction(input: {
  action: MenuAction
  store: StoreFile
  writeStore: (store: StoreFile) => Promise<void>
}): Promise<boolean> {
  if (input.action.type === "toggle-loop-safety") {
    input.store.loopSafetyEnabled = input.store.loopSafetyEnabled !== true
    await input.writeStore(input.store)
    return true
  }

  if (input.action.type === "toggle-network-retry") {
    input.store.networkRetryEnabled = input.store.networkRetryEnabled !== true
    await input.writeStore(input.store)
    return true
  }

  return false
}
