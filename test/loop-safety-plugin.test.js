import test from "node:test"
import assert from "node:assert/strict"
import { AsyncResource } from "node:async_hooks"

import {
  LOOP_SAFETY_POLICY,
  applyLoopSafetyPolicy,
  createCompactionLoopSafetyBypass,
  createLoopSafetySystemTransform,
  isCopilotProvider,
} from "../dist/loop-safety-plugin.js"

const EXPECTED_POLICY = `Guided Loop Safety Policy
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

test("isCopilotProvider recognizes both Copilot providers", () => {
  assert.equal(isCopilotProvider("github-copilot"), true)
  assert.equal(isCopilotProvider("github-copilot-enterprise"), true)
  assert.equal(isCopilotProvider("google"), false)
})

test("applyLoopSafetyPolicy leaves non-Copilot providers unchanged", () => {
  const system = ["base prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "google",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt"])
})

test("applyLoopSafetyPolicy leaves disabled Copilot sessions unchanged", () => {
  const system = ["base prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: false,
    system,
  })

  assert.deepEqual(next, ["base prompt"])
})

test("applyLoopSafetyPolicy appends the fixed block once for enabled Copilot sessions", () => {
  const system = ["base prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt", LOOP_SAFETY_POLICY])
})

test("applyLoopSafetyPolicy is idempotent when the exact block already exists", () => {
  const system = ["base prompt", LOOP_SAFETY_POLICY]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt", LOOP_SAFETY_POLICY])
})

test("applyLoopSafetyPolicy is idempotent when the exact block already exists in the middle", () => {
  const system = ["base prompt", LOOP_SAFETY_POLICY, "tail prompt"]
  const next = applyLoopSafetyPolicy({
    providerID: "github-copilot",
    enabled: true,
    system,
  })

  assert.deepEqual(next, ["base prompt", LOOP_SAFETY_POLICY, "tail prompt"])
})

test("LOOP_SAFETY_POLICY exactly matches the fixed spec text", () => {
  assert.equal(LOOP_SAFETY_POLICY, EXPECTED_POLICY)
})

test("createLoopSafetySystemTransform appends once for enabled Copilot sessions", async () => {
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }))
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createLoopSafetySystemTransform skips when bypass callback says current session is compaction", async () => {
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), (sessionID) => sessionID === "s1")
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform still appends when bypass callback returns false", async () => {
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), () => false)
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("createCompactionLoopSafetyBypass only skips within the compaction async context", async () => {
  const bypass = createCompactionLoopSafetyBypass()

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  assert.equal(bypass.consume("s1"), true)
  assert.equal(bypass.consume("s1"), false)
  assert.equal(bypass.consume("s2"), false)
  assert.equal(bypass.consume(undefined), false)
  assert.equal(createCompactionLoopSafetyBypass().consume("s1"), false)
})

test("createCompactionLoopSafetyBypass does not leak to unrelated async contexts", async () => {
  const bypass = createCompactionLoopSafetyBypass()
  const foreign = new AsyncResource("foreign-context")

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  const leaked = foreign.runInAsyncScope(() => bypass.consume("s1"))

  assert.equal(leaked, false)
  assert.equal(bypass.consume("s1"), true)
})

test("createLoopSafetySystemTransform does not consume bypass for non-Copilot transforms", async () => {
  const bypass = createCompactionLoopSafetyBypass()
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), bypass.consume)

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  const nonCopilot = { system: ["base prompt"] }
  await transform(
    { sessionID: "s1", model: { providerID: "google" } },
    nonCopilot,
  )

  const copilot = { system: ["base prompt"] }
  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    copilot,
  )

  assert.deepEqual(nonCopilot.system, ["base prompt"])
  assert.deepEqual(copilot.system, ["base prompt"])
})

test("createLoopSafetySystemTransform does not consume bypass when loop safety is disabled", async () => {
  const bypass = createCompactionLoopSafetyBypass()
  const disabledTransform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: false,
  }), bypass.consume)
  const enabledTransform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: true,
  }), bypass.consume)

  await bypass.hook(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )

  const disabled = { system: ["base prompt"] }
  await disabledTransform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    disabled,
  )

  const enabled = { system: ["base prompt"] }
  await enabledTransform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    enabled,
  )

  assert.deepEqual(disabled.system, ["base prompt"])
  assert.deepEqual(enabled.system, ["base prompt"])
})

test("createLoopSafetySystemTransform fails open when store read rejects", async () => {
  const transform = createLoopSafetySystemTransform(async () => {
    throw new Error("boom")
  })
  const output = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt"])
})

test("createLoopSafetySystemTransform reads fresh store state on every call", async () => {
  let enabled = false
  const transform = createLoopSafetySystemTransform(async () => ({
    accounts: {},
    loopSafetyEnabled: enabled,
  }))
  const first = { system: ["base prompt"] }
  const second = { system: ["base prompt"] }

  await transform(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    first,
  )

  enabled = true

  await transform(
    { sessionID: "s2", model: { providerID: "github-copilot" } },
    second,
  )

  assert.deepEqual(first.system, ["base prompt"])
  assert.deepEqual(second.system, ["base prompt", LOOP_SAFETY_POLICY])
})
