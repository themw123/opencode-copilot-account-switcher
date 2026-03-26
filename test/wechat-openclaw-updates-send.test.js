import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

const DIST_UPDATES_SEND_MODULE = "../dist/wechat/compat/openclaw-updates-send.js"
const DIST_SYNC_BUF_MODULE = "../dist/wechat/compat/openclaw-sync-buf.js"

test("updates/send/sync-buf wrappers expose only runtime-safe fields", async () => {
  const mod = await import(DIST_UPDATES_SEND_MODULE)
  const sync = await import(DIST_SYNC_BUF_MODULE)

  assert.equal(typeof mod.createOpenClawUpdatesHelper, "function")
  assert.equal(typeof mod.createOpenClawSendHelper, "function")
  assert.equal(typeof sync.createOpenClawSyncBufHelper, "function")
})

test("loadOpenClawUpdatesAndSendHelpers loads wrappers and normalizes params", async () => {
  const mod = await import(DIST_UPDATES_SEND_MODULE)

  const loaded = await mod.loadOpenClawUpdatesAndSendHelpers({
    getUpdatesModulePath: fileURLToPath(new URL("./fixtures/wechat-openclaw-updates-getupdates-ok.cjs", import.meta.url)),
    sendMessageWeixinModulePath: fileURLToPath(new URL("./fixtures/wechat-openclaw-updates-send-ok.cjs", import.meta.url)),
  })

  const updatesResult = await loaded.getUpdates(undefined)
  const sendResult = await loaded.sendMessageWeixin(undefined)

  assert.equal(updatesResult.get_updates_buf, "buf-from-fixture")
  assert.equal(sendResult.messageId, "msg-from-fixture")
})

test("loadOpenClawUpdatesAndSendHelpers throws when getUpdates helper is unavailable", async () => {
  const mod = await import(DIST_UPDATES_SEND_MODULE)

  await assert.rejects(
    () =>
      mod.loadOpenClawUpdatesAndSendHelpers({
        getUpdatesModulePath: fileURLToPath(new URL("./fixtures/wechat-openclaw-updates-getupdates-missing.cjs", import.meta.url)),
        sendMessageWeixinModulePath: fileURLToPath(new URL("./fixtures/wechat-openclaw-updates-send-ok.cjs", import.meta.url)),
      }),
    /public getUpdates helper unavailable/i,
  )
})
