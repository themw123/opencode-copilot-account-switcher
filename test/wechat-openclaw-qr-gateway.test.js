import test from "node:test"
import assert from "node:assert/strict"

const DIST_QR_GATEWAY_MODULE = "../dist/wechat/compat/openclaw-qr-gateway.js"

test("qr gateway wrapper requires object params and returns stable bind payload", async () => {
  const mod = await import(DIST_QR_GATEWAY_MODULE)
  const gateway = mod.createOpenClawQrGateway({
    loginWithQrStart: async (params) => ({
      sessionKey: params.accountId ?? "s",
      qrDataUrl: "data:image/png;base64,abc",
    }),
    loginWithQrWait: async (params) => ({
      connected: true,
      accountId: params.accountId ?? "acc",
    }),
  })

  const started = await gateway.loginWithQrStart({ accountId: "acc-2x" })
  const waited = await gateway.loginWithQrWait({ accountId: "acc-2x" })

  assert.equal(started.sessionKey, "acc-2x")
  assert.equal(waited.accountId, "acc-2x")
})

test("loadOpenClawQrGateway parses pluginId from payload plugin", async () => {
  const mod = await import(DIST_QR_GATEWAY_MODULE)

  const loaded = await mod.loadOpenClawQrGateway([
    {
      plugin: {
        id: "wechat-plugin-real",
        gateway: {
          loginWithQrStart: async () => ({ sessionKey: "s-1" }),
          loginWithQrWait: async () => ({ connected: true, accountId: "acc-1" }),
        },
      },
    },
  ])

  assert.equal(loaded.pluginId, "wechat-plugin-real")
  assert.equal(typeof loaded.gateway.loginWithQrStart, "function")
  assert.equal(typeof loaded.gateway.loginWithQrWait, "function")
})
