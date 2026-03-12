import test from "node:test"
import assert from "node:assert/strict"

import {
  LOOP_SAFETY_POLICY,
  applyLoopSafetyPolicy,
  createLoopSafetySystemTransform,
  isCopilotProvider,
} from "../dist/loop-safety-plugin.js"

const EXPECTED_POLICY = `Guided Loop Safety Policy
- When the question tool is available and permitted in the current session, all user-facing reports must be delivered through the question tool.
- The question tool is considered available and permitted when it appears in the active tool list and the current session has not denied its use.
- Direct assistant text is allowed only when the question tool is unavailable, denied, or absent from the current session.
- When reporting multiple related items, prefer a single question tool call with multiple well-grouped questions instead of multiple separate interruptions.
- Group related items into clear question batches such as current progress, key findings, and next-step choices.
- For long or complex reports, split the report into paginated or sequential question batches instead of overloading one large message.
- Present the highest-priority information first and defer secondary details to later question batches when needed.
- Even when no explicit decision is required, prefer brief question-tool status updates over direct assistant text whenever the tool is available.
- Avoid unnecessary question frequency; combine small related updates when a single question call can cover them clearly.
- Dispatching task or subagent work is expensive and should be avoided unless it materially improves the result.
- Materially improves the result means clearly beneficial cases such as parallel analysis of independent areas; it does not include routine local searches, small file reads, or straightforward edits.
- If task or subagent delegation is used, keep the number minimal and explain the reason briefly through the question tool when available.`

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
