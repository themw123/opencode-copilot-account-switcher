import test from "node:test"
import assert from "node:assert/strict"

const DIST_SYNC_BUF_MODULE = "../dist/wechat/compat/openclaw-sync-buf.js"

test("sync-buf wrapper persists updates buf via provided source helpers", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  const calls = []
  const helper = mod.createOpenClawSyncBufHelper({
    getSyncBufFilePath: (accountId) => `state/${accountId}.buf`,
    saveGetUpdatesBuf: (filePath, getUpdatesBuf) => {
      calls.push({ filePath, getUpdatesBuf })
    },
  })

  await helper.persistGetUpdatesBuf({ accountId: "acc-2x", getUpdatesBuf: "buf-2x" })

  assert.deepEqual(calls, [{ filePath: "state/acc-2x.buf", getUpdatesBuf: "buf-2x" }])
})

test("sync-buf module exports latest account state loader for assembly usage", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  assert.equal(typeof mod.loadLatestWeixinAccountState, "function")
})

test("loadOpenClawSyncBufHelper throws when source helper missing", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  await assert.rejects(
    () => mod.loadOpenClawSyncBufHelper({ syncBufModulePath: "node:path" }),
    /sync-buf source helper unavailable/,
  )
})

test("createOpenClawSyncBufHelper rejects empty file path", async () => {
  const mod = await import(DIST_SYNC_BUF_MODULE)

  const helper = mod.createOpenClawSyncBufHelper({
    getSyncBufFilePath: () => "",
    saveGetUpdatesBuf: () => {
      throw new Error("should not be called")
    },
  })

  await assert.rejects(
    () => helper.persistGetUpdatesBuf({ accountId: "acc-2x", getUpdatesBuf: "buf-2x" }),
    /sync-buf helper returned invalid file path/,
  )
})
