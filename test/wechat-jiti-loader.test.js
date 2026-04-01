import test from "node:test"
import assert from "node:assert/strict"

const DIST_JITI_LOADER_MODULE = "../dist/wechat/compat/jiti-loader.js"

test("resolveCreateJiti supports named export shape", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const createJiti = mod.resolveCreateJiti({
    createJiti() {
      return "named"
    },
  })

  assert.equal(createJiti(), "named")
})

test("resolveCreateJiti supports default function export shape", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const createJiti = mod.resolveCreateJiti({
    default() {
      return "default-function"
    },
  })

  assert.equal(createJiti(), "default-function")
})

test("resolveCreateJiti supports direct CommonJS function export shape", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const createJiti = mod.resolveCreateJiti(Object.assign(
    function () {
      return "cjs-function"
    },
    {},
  ))

  assert.equal(createJiti(), "cjs-function")
})

test("resolveCreateJiti supports default object with createJiti", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const createJiti = mod.resolveCreateJiti({
    default: {
      createJiti() {
        return "default-object"
      },
    },
  })

  assert.equal(createJiti(), "default-object")
})

test("resolveCreateJiti rejects unsupported export shape", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  assert.throws(
    () => mod.resolveCreateJiti({ default: {} }),
    /createJiti export unavailable/i,
  )
})

test("loadJiti uses CommonJS require path", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  let required = 0

  const loaded = mod.loadJiti(() => {
    required += 1
    return {
      createJiti() {
        return "required"
      },
    }
  })

  assert.equal(required, 1)
  assert.equal(typeof loaded.createJiti, "function")
  assert.equal(loaded.createJiti(), "required")
})
