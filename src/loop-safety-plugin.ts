import type { Hooks } from "@opencode-ai/plugin"
import { readStoreSafe, type StoreFile } from "./store.js"

export const LOOP_SAFETY_POLICY = `Guided Loop Safety Policy
- Continue working on any remaining non-blocked task before stopping to report or wait for more instructions.
- If you are not fully blocked, do not stop just because you feel ready to pause; finish the work that can still be done safely.
- When the question tool is available and permitted in the current session, all user-facing reports must be delivered through the question tool.
- The question tool is considered available and permitted when it appears in the active tool list and the current session has not denied its use.
- Direct assistant text is allowed only when the question tool is unavailable, denied, or absent from the current session.
- When reporting multiple related items, prefer a single question tool call with multiple well-grouped questions instead of multiple separate interruptions.
- Group related items into clear question batches such as current progress, key findings, and next-step choices.
- For long or complex reports, split the report into paginated or sequential question batches instead of overloading one large message.
- Present the highest-priority information first and defer secondary details to later question batches when needed.
- Even when no explicit decision is required, prefer brief question-tool status updates over direct assistant text whenever the tool is available.
- Avoid unnecessary question frequency; combine small related updates when a single question call can cover them clearly.
- When no further action can be taken safely and no non-blocked work remains, use the question tool to ask for the next task or clarification instead of ending with direct assistant text.
- Dispatching task or subagent work is expensive and should be avoided unless it materially improves the result.
- Materially improves the result means clearly beneficial cases such as parallel analysis of independent areas; it does not include routine local searches, small file reads, or straightforward edits.
- If task or subagent delegation is used, keep the number minimal and explain the reason briefly through the question tool when available.`

export type ExperimentalChatSystemTransformHook = (
  input: {
    sessionID: string
    model: {
      providerID: string
    }
  },
  output: {
    system: string[]
  },
) => Promise<void>

export type CopilotPluginHooks = Hooks & {
  "experimental.chat.system.transform"?: ExperimentalChatSystemTransformHook
}

export function isCopilotProvider(providerID: string): boolean {
  return providerID === "github-copilot" || providerID === "github-copilot-enterprise"
}

export function applyLoopSafetyPolicy(input: {
  providerID: string
  enabled: boolean
  system: string[]
}): string[] {
  if (!input.enabled) return input.system
  if (!isCopilotProvider(input.providerID)) return input.system
  if (input.system.includes(LOOP_SAFETY_POLICY)) return input.system
  return [...input.system, LOOP_SAFETY_POLICY]
}

export function createLoopSafetySystemTransform(
  loadStore: () => Promise<StoreFile | undefined> = readStoreSafe,
): ExperimentalChatSystemTransformHook {
  return async (input, output) => {
    const store = await loadStore().catch(() => undefined)
    const next = applyLoopSafetyPolicy({
      providerID: input.model.providerID,
      enabled: store?.loopSafetyEnabled === true,
      system: output.system,
    })

    if (next.length === output.system.length) return
    output.system.push(LOOP_SAFETY_POLICY)
  }
}
