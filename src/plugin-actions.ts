import type { StoreFile } from "./store.js"
import type { MenuAction } from "./ui/menu.js"

export async function applyMenuAction(input: {
  action: MenuAction
  store: StoreFile
  writeStore: (store: StoreFile) => Promise<void>
}): Promise<boolean> {
  if (input.action.type !== "toggle-loop-safety") return false

  input.store.loopSafetyEnabled = input.store.loopSafetyEnabled !== true
  await input.writeStore(input.store)
  return true
}
