import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { parseStore, readStore, readStoreSafe, writeStore } from "../dist/store.js"

async function withStoreDebugEnv(logFile, enabled, action) {
  const previousFile = process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE
  const previousEnabled = process.env.OPENCODE_COPILOT_STORE_DEBUG

  process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE = logFile
  if (enabled === undefined) delete process.env.OPENCODE_COPILOT_STORE_DEBUG
  else process.env.OPENCODE_COPILOT_STORE_DEBUG = enabled

  try {
    return await action()
  } finally {
    if (previousFile === undefined) delete process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE
    else process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE = previousFile

    if (previousEnabled === undefined) delete process.env.OPENCODE_COPILOT_STORE_DEBUG
    else process.env.OPENCODE_COPILOT_STORE_DEBUG = previousEnabled
  }
}

async function readDebugLogEvent(logFile) {
  const log = await readFile(logFile, "utf8")
  const lines = log.trim().split("\n")

  assert.equal(lines.length, 1)
  return JSON.parse(lines[0])
}

test("parseStore defaults loopSafetyEnabled to true when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.loopSafetyEnabled, true)
  assert.deepEqual(store.accounts, {})
})

test("parseStore defaults networkRetryEnabled to false when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.networkRetryEnabled, false)
})

test("parseStore defaults syntheticAgentInitiatorEnabled to false when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.syntheticAgentInitiatorEnabled, false)
})

test("parseStore coerces invalid syntheticAgentInitiatorEnabled values to false", () => {
  const store = parseStore('{"accounts":{},"syntheticAgentInitiatorEnabled":"yes"}')

  assert.equal(store.syntheticAgentInitiatorEnabled, false)
})

test("parseStore preserves networkRetryEnabled when explicitly true", () => {
  const store = parseStore('{"accounts":{},"networkRetryEnabled":true}')

  assert.equal(store.networkRetryEnabled, true)
})

test("experimental slash commands default to enabled", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.experimentalSlashCommandsEnabled, true)
})

test("experimental slash commands preserve explicit false", () => {
  const store = parseStore('{"accounts":{},"experimentalSlashCommandsEnabled":false}')

  assert.equal(store.experimentalSlashCommandsEnabled, false)
})

test("experimental slash commands inherit legacy status slash false when new flag is missing", () => {
  const store = parseStore('{"accounts":{},"experimentalStatusSlashCommandEnabled":false}')

  assert.equal(store.experimentalSlashCommandsEnabled, false)
})

test("experimental slash commands explicit true overrides legacy false", () => {
  const store = parseStore('{"accounts":{},"experimentalSlashCommandsEnabled":true,"experimentalStatusSlashCommandEnabled":false}')

  assert.equal(store.experimentalSlashCommandsEnabled, true)
})

test("loop safety provider scope defaults to copilot-only", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.loopSafetyProviderScope, "copilot-only")
})

test("loop safety provider scope preserves explicit all-models", () => {
  const store = parseStore('{"accounts":{},"loopSafetyProviderScope":"all-models"}')

  assert.equal(store.loopSafetyProviderScope, "all-models")
})

test("parseStore keeps lastAccountSwitchAt when present", () => {
  const store = parseStore(
    '{"accounts":{"primary":{"refresh":"r","access":"a","expires":1}},"lastAccountSwitchAt":1735689600000}'
  )

  assert.equal(store.lastAccountSwitchAt, 1735689600000)
  assert.equal(store.accounts.primary.name, "primary")
})

test("parseStore clears lastAccountSwitchAt when it is not numeric", () => {
  const store = parseStore(
    '{"accounts":{"primary":{"refresh":"r","access":"a","expires":1}},"lastAccountSwitchAt":"1735689600000"}'
  )

  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.equal(store.accounts.primary.name, "primary")
})

test("parseStore leaves lastAccountSwitchAt undefined by default", () => {
  const store = parseStore('{"accounts":{"secondary":{"refresh":"r","access":"a","expires":1}}}')

  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.equal(store.loopSafetyEnabled, true)
  assert.equal(store.networkRetryEnabled, false)
  assert.equal(store.accounts.secondary.name, "secondary")
})

test("parseStore throws on malformed JSON for strict readers", () => {
  assert.throws(() => parseStore("{"))
})

test("readStore rejects malformed JSON from an existing store file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-bad-json-"))
  const file = path.join(dir, "copilot-accounts.json")
  await writeFile(file, "{", "utf8")

  await assert.rejects(() => readStore(file))
})

test("readStore defaults a missing store file to an empty store with loop safety on", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-missing-"))
  const file = path.join(dir, "missing-store.json")

  const store = await readStore(file)

  assert.deepEqual(store.accounts, {})
  assert.equal(store.loopSafetyEnabled, true)
})

test("readStoreSafe also defaults a missing store file to loop safety on", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-safe-missing-"))
  const file = path.join(dir, "missing-store.json")

  const store = await readStoreSafe(file)

  assert.deepEqual(store?.accounts, {})
  assert.equal(store?.loopSafetyEnabled, true)
})

test("readStore throws when the path is unreadable as a file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-dir-"))

  await assert.rejects(() => readStore(dir))
})

test("readStoreSafe returns undefined for malformed JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-"))
  const file = path.join(dir, "copilot-accounts.json")
  await writeFile(file, "{", "utf8")

  const store = await readStoreSafe(file)

  assert.equal(store, undefined)
})

test("readStoreSafe returns undefined for unreadable files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-unreadable-"))

  const store = await readStoreSafe(dir)

  assert.equal(store, undefined)
})

test("writeStore does not emit debug log by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-store-debug-default-off-"))
  const file = path.join(dir, "copilot-accounts.json")
  const logFile = path.join(dir, "opencode-copilot-store-debug.log")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          primary: { name: "primary", refresh: "r", access: "a", expires: 0 },
        },
        loopSafetyEnabled: true,
        networkRetryEnabled: true,
      },
      null,
      2,
    ),
    "utf8",
  )

  await withStoreDebugEnv(logFile, undefined, async () => {
    await writeStore(
      {
        accounts: {},
        loopSafetyEnabled: false,
        networkRetryEnabled: true,
      },
      {
        filePath: file,
        debug: {
          reason: "toggle-loop-safety",
          source: "applyMenuAction",
          actionType: "toggle-loop-safety",
        },
      },
    )
  })

  await assert.rejects(readFile(logFile, "utf8"), /ENOENT/)
})

test("writeStore emits enabled debug log with reason and before-after snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-store-debug-"))
  const file = path.join(dir, "copilot-accounts.json")
  const logFile = path.join(dir, "opencode-copilot-store-debug.log")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          primary: { name: "primary", refresh: "r", access: "a", expires: 0 },
        },
        loopSafetyEnabled: true,
        networkRetryEnabled: true,
        lastAccountSwitchAt: 123,
      },
      null,
      2,
    ),
    "utf8",
  )

  await withStoreDebugEnv(logFile, "1", async () => {
    await writeStore(
      {
        accounts: {},
        loopSafetyEnabled: false,
        networkRetryEnabled: true,
      },
      {
        filePath: file,
        debug: {
          reason: "toggle-loop-safety",
          source: "applyMenuAction",
          actionType: "toggle-loop-safety",
        },
      },
    )
  })

  const event = await readDebugLogEvent(logFile)

  assert.equal(event.kind, "store-write")
  assert.equal(event.reason, "toggle-loop-safety")
  assert.equal(event.source, "applyMenuAction")
  assert.equal(event.actionType, "toggle-loop-safety")
  assert.equal(event.cwd, process.cwd())
  assert.ok(Array.isArray(event.argv))
  assert.ok(Array.isArray(event.stack))
  assert.match(event.stack.join("\n"), /store\.test\.js/)
  assert.deepEqual(event.before, {
    active: null,
    accountCount: 1,
    modelAccountAssignmentCount: 0,
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "copilot-only",
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: true,
    lastAccountSwitchAt: 123,
    syntheticAgentInitiatorEnabled: false,
  })
  assert.deepEqual(event.after, {
    active: null,
    accountCount: 0,
    modelAccountAssignmentCount: 0,
    loopSafetyEnabled: false,
    loopSafetyProviderScope: null,
    networkRetryEnabled: true,
    experimentalSlashCommandsEnabled: null,
    lastAccountSwitchAt: null,
    syntheticAgentInitiatorEnabled: false,
  })
})

test("writeStore enabled debug snapshot includes syntheticAgentInitiatorEnabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-initiator-store-debug-"))
  const file = path.join(dir, "copilot-accounts.json")
  const logFile = path.join(dir, "opencode-copilot-store-debug.log")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          primary: { name: "primary", refresh: "r", access: "a", expires: 0 },
        },
        syntheticAgentInitiatorEnabled: true,
      },
      null,
      2,
    ),
    "utf8",
  )

  await withStoreDebugEnv(logFile, "1", async () => {
    await writeStore(
      {
        accounts: {},
        syntheticAgentInitiatorEnabled: false,
      },
      {
        filePath: file,
        debug: {
          reason: "toggle-synthetic-agent-initiator",
        },
      },
    )
  })

  const event = await readDebugLogEvent(logFile)

  assert.equal(event.before.syntheticAgentInitiatorEnabled, true)
  assert.equal(event.after.syntheticAgentInitiatorEnabled, false)
})
