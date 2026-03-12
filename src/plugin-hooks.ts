import { createLoopSafetySystemTransform, type CopilotPluginHooks } from "./loop-safety-plugin.js"
import { readStoreSafe, type StoreFile } from "./store.js"

export function buildPluginHooks(input: {
  auth: CopilotPluginHooks["auth"]
  loadStore?: () => Promise<StoreFile | undefined>
}): CopilotPluginHooks {
  return {
    auth: input.auth,
    "experimental.chat.system.transform": createLoopSafetySystemTransform(input.loadStore ?? readStoreSafe),
  }
}
