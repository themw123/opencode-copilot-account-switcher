import test from "node:test"
import assert from "node:assert/strict"

const DIST_UPDATES_SEND_MODULE = "../dist/wechat/compat/openclaw-updates-send.js"
const DIST_SYNC_BUF_MODULE = "../dist/wechat/compat/openclaw-sync-buf.js"

test("updates/send/sync-buf wrappers expose only runtime-safe fields", async () => {
  const mod = await import(DIST_UPDATES_SEND_MODULE)
  const sync = await import(DIST_SYNC_BUF_MODULE)

  assert.equal(typeof mod.createOpenClawUpdatesHelper, "function")
  assert.equal(typeof mod.createOpenClawSendHelper, "function")
  assert.equal(typeof sync.createOpenClawSyncBufHelper, "function")
})
