import test from "node:test"
import assert from "node:assert/strict"

const DIST_QRCODE_LOADER_MODULE = "../dist/wechat/compat/qrcode-terminal-loader.js"

test("resolveQrCodeTerminal supports direct CommonJS object shape", async () => {
  const mod = await import(DIST_QRCODE_LOADER_MODULE)
  const qrcode = mod.resolveQrCodeTerminal({
    generate() {},
  })

  assert.equal(typeof qrcode.generate, "function")
})

test("resolveQrCodeTerminal supports default export object shape", async () => {
  const mod = await import(DIST_QRCODE_LOADER_MODULE)
  const qrcode = mod.resolveQrCodeTerminal({
    default: {
      generate() {},
    },
  })

  assert.equal(typeof qrcode.generate, "function")
})

test("resolveQrCodeTerminal rejects unsupported export shape", async () => {
  const mod = await import(DIST_QRCODE_LOADER_MODULE)

  assert.throws(
    () => mod.resolveQrCodeTerminal({ default: {} }),
    /qrcode-terminal export unavailable/i,
  )
})

test("loadQrCodeTerminal uses CommonJS require path", async () => {
  const mod = await import(DIST_QRCODE_LOADER_MODULE)
  let required = 0

  const qrcode = mod.loadQrCodeTerminal(() => {
    required += 1
    return {
      generate() {},
    }
  })

  assert.equal(required, 1)
  assert.equal(typeof qrcode.generate, "function")
})
