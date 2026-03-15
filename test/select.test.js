import test from "node:test"
import assert from "node:assert/strict"

import { buildSelectDebugEvent } from "../dist/ui/select.js"

test("buildSelectDebugEvent captures suspicious toggle selection key events", () => {
  const event = buildSelectDebugEvent({
    stage: "key",
    parsedKey: "enter",
    currentValue: { type: "toggle-loop-safety" },
  })

  assert.deepEqual(event, {
    stage: "key",
    parsedKey: "enter",
    currentActionType: "toggle-loop-safety",
    nextActionType: null,
    actionType: "toggle-loop-safety",
  })
})

test("buildSelectDebugEvent ignores non-suspicious actions", () => {
  const event = buildSelectDebugEvent({
    stage: "result",
    parsedKey: null,
    currentValue: { type: "add" },
  })

  assert.equal(event, undefined)
})
