import { AsyncLocalStorage } from "node:async_hooks"
import type { Hooks } from "@opencode-ai/plugin"
import { readStoreSafe, type StoreFile } from "./store.js"

export const LOOP_SAFETY_POLICY = `Guided Loop Safety Policy
- Continue working on any remaining non-blocked task before stopping to report or wait for more instructions.
- If you are not fully blocked, do not stop just because you feel ready to pause; finish the work that can still be done safely.
- MANDATORY: When the question tool is available and permitted in the current session, ALL user-facing reports MUST be delivered through the question tool.
- MANDATORY: Treat progress updates, status reports, summaries, explanations, completion notes, and next-step choices as user-facing reports.
- MANDATORY: In this workflow, the question tool is both the question channel and the report channel for user-visible communication.
- MANDATORY: Do not reinterpret "keep working unless blocked" as permission to send direct assistant text. If you need to report, report through the question tool.
- MANDATORY: Do not reinterpret "don't ask unnecessary questions" as permission to skip the question tool. Use fewer question batches, not a different reporting channel.
- MANDATORY: If the user says a report was sent the wrong way, first check whether you used the wrong channel before analyzing verbosity, timing, or wording.
- MANDATORY: When reflecting on report-delivery or tool-usage mistakes, first check report-channel violations before any secondary critique.
- MANDATORY: Do not reinterpret those report-channel violations as a problem with the report policy itself.
- MANDATORY: Do not turn a pure report into a preference question, permission question, or route-selection question just to satisfy the question tool requirement.
- MANDATORY: When no user decision is needed, use the question tool as a report container with the smallest sensible option set.
- NO EXCEPTIONS: Do not switch to direct assistant text just because the report is long, detailed, complex, or contains multiple related items.
- The question tool is considered available and permitted when it appears in the active tool list and the current session has not denied its use.
- Direct assistant text is allowed only when the question tool is unavailable, denied, or absent from the current session.
- If a report would otherwise be sent as direct text, convert it into one question batch or a short sequence of question batches instead.
- IMPORTANT: A report-mode violation usually means the wrong tool was used, not that the report was too long.
- IMPORTANT: Do not reinterpret a tool-usage violation as a verbosity problem.
- Long reports are allowed. Use pagination or sequential question batches when needed; do not fall back to direct assistant text.
- A single question tool call may contain multiple well-grouped questions. Prefer that over multiple small interruptions when it keeps the report clear.
- Group related items into explicit batches such as current progress, key findings, decisions, and next-step choices.
- Present the highest-priority information first and defer secondary details to later question batches when needed.
- Even when no explicit decision is required, use brief question-tool status updates instead of direct assistant text whenever the tool is available.
- Avoid unnecessary question frequency; combine small related updates when a single question call can cover them clearly.
- MANDATORY: After any successful question-tool report, immediately choose between (a) continue unfinished non-blocked work, or (b) issue a question-tool wait-for-instruction message when no such work remains.
- MANDATORY: Never send assistant text as a post-report fallback in either branch.
- MANDATORY: If a post-report branch has no content, suppress assistant output and re-enter question-tool flow.
- MANDATORY: When idle or waiting for the next task, continue using the question tool to maintain user control of the session.
- MANDATORY: Repeated waiting for the next task is not a reason to stop using the question tool.
- When no further action can be taken safely and no non-blocked work remains, use the question tool to ask for the next task or clarification instead of ending with direct assistant text.
- When the user says "stop", do not send assistant text to acknowledge the stop. Use the question tool only if more user-visible communication is still required by policy.
`

export type ExperimentalChatSystemTransformHook = (
  input: {
    sessionID?: string
    model: {
      providerID: string
    }
  },
  output: {
    system: string[]
  },
) => Promise<void>

export type ExperimentalSessionCompactingHook = (
  input: {
    sessionID: string
  },
  output: {
    context: string[]
    prompt?: string
  },
) => Promise<void>

export type CopilotPluginHooks = Hooks & {
  "experimental.chat.system.transform"?: ExperimentalChatSystemTransformHook
  "experimental.session.compacting"?: ExperimentalSessionCompactingHook
}

export type CompactionLoopSafetyBypass = {
  hook: ExperimentalSessionCompactingHook
  consume(sessionID?: string): boolean
}

export function isCopilotProvider(providerID: string): boolean {
  return providerID === "github-copilot" || providerID === "github-copilot-enterprise"
}

export function applyLoopSafetyPolicy(input: {
  providerID: string
  enabled: boolean
  skip?: boolean
  system: string[]
}): string[] {
  if (!input.enabled) return input.system
  if (input.skip) return input.system
  if (!isCopilotProvider(input.providerID)) return input.system
  if (input.system.includes(LOOP_SAFETY_POLICY)) return input.system
  return [...input.system, LOOP_SAFETY_POLICY]
}

export function createLoopSafetySystemTransform(
  loadStore: () => Promise<StoreFile | undefined> = readStoreSafe,
  consumeCompactionBypass: (sessionID?: string) => boolean = () => false,
): ExperimentalChatSystemTransformHook {
  return async (input, output) => {
    const store = await loadStore().catch(() => undefined)
    const enabled = store?.loopSafetyEnabled === true
    const skip = enabled && isCopilotProvider(input.model.providerID)
      ? consumeCompactionBypass(input.sessionID)
      : false
    const next = applyLoopSafetyPolicy({
      providerID: input.model.providerID,
      enabled,
      skip,
      system: output.system,
    })

    if (next.length === output.system.length) return
    output.system.push(LOOP_SAFETY_POLICY)
  }
}

export function createCompactionLoopSafetyBypass(): CompactionLoopSafetyBypass {
  const storage = new AsyncLocalStorage<{
    sessionID: string
    pending: boolean
  }>()

  return {
    hook: async (input, _output) => {
      storage.enterWith({ sessionID: input.sessionID, pending: true })
    },
    consume(sessionID?: string) {
      if (!sessionID) return false
      const state = storage.getStore()
      if (!state) return false
      if (state.pending !== true) return false
      if (state.sessionID !== sessionID) return false
      state.pending = false
      return true
    },
  }
}
