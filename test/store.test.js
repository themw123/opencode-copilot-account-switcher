import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { parseStore, readStore, readStoreSafe } from "../dist/store.js"

test("parseStore defaults loopSafetyEnabled to true when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.loopSafetyEnabled, true)
  assert.deepEqual(store.accounts, {})
})

test("parseStore defaults networkRetryEnabled to false when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.networkRetryEnabled, false)
})

test("parseStore preserves networkRetryEnabled when explicitly true", () => {
  const store = parseStore('{"accounts":{},"networkRetryEnabled":true}')

  assert.equal(store.networkRetryEnabled, true)
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
