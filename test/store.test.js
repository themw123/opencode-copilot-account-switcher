import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { parseStore, readStore, readStoreSafe } from "../dist/store.js"

test("parseStore defaults loopSafetyEnabled to false when missing", () => {
  const store = parseStore('{"accounts":{}}')

  assert.equal(store.loopSafetyEnabled, false)
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

test("parseStore throws on malformed JSON for strict readers", () => {
  assert.throws(() => parseStore("{"))
})

test("readStore rejects malformed JSON from an existing store file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-bad-json-"))
  const file = path.join(dir, "copilot-accounts.json")
  await writeFile(file, "{", "utf8")

  await assert.rejects(() => readStore(file))
})

test("readStore defaults a missing store file to an empty store with loop safety off", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-missing-"))
  const file = path.join(dir, "missing-store.json")

  const store = await readStore(file)

  assert.deepEqual(store.accounts, {})
  assert.equal(store.loopSafetyEnabled, false)
})

test("readStoreSafe also defaults a missing store file to loop safety off", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loop-safety-safe-missing-"))
  const file = path.join(dir, "missing-store.json")

  const store = await readStoreSafe(file)

  assert.deepEqual(store?.accounts, {})
  assert.equal(store?.loopSafetyEnabled, false)
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
