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

test("resolveCreateJiti supports module.exports function shape", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const createJiti = mod.resolveCreateJiti({
    "module.exports"() {
      return "module-exports-function"
    },
  })

  assert.equal(createJiti(), "module-exports-function")
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

test("resolveJitiEsmEntry resolves package.json to dist/jiti.cjs file URL", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const entry = mod.resolveJitiEsmEntry(() => "C:\\virtual\\node_modules\\jiti\\package.json")

  assert.equal(entry, "file:///C:/virtual/node_modules/jiti/dist/jiti.cjs")
})

test("wrapCreateJiti supplies runtime helpers for low-level dist factory", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  let runtime
  let receivedOptions

  const wrapped = mod.wrapCreateJiti((_id, options, receivedRuntime) => {
    receivedOptions = options
    runtime = receivedRuntime
    return "wrapped-loader"
  })

  const result = wrapped(import.meta.url, { interopDefault: true })

  assert.equal(result, "wrapped-loader")
  assert.equal(typeof receivedOptions.transform, "function")
  assert.equal(typeof runtime.onError, "function")
  assert.equal(typeof runtime.nativeImport, "function")
  assert.equal(typeof runtime.createRequire, "function")
})

test("loadJiti resolves and imports jiti ESM entry path", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  const imported = []

  const loaded = await mod.loadJiti((specifier) => {
    imported.push(specifier)
    return {
      createJiti() {
        return "esm-entry"
      },
    }
  }, () => "C:\\virtual\\node_modules\\jiti\\package.json")

  assert.deepEqual(imported, ["file:///C:/virtual/node_modules/jiti/dist/jiti.cjs"])
  assert.equal(typeof loaded.createJiti, "function")
  assert.equal(loaded.createJiti(), "esm-entry")
})

test("loadJiti supports async import path", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  let imported = 0

  const loaded = await mod.loadJiti(async () => {
    imported += 1
    return {
      createJiti() {
        return "async-import"
      },
    }
  })

  assert.equal(imported, 1)
  assert.equal(typeof loaded.createJiti, "function")
  assert.equal(loaded.createJiti(), "async-import")
})

test("loadModuleWithTsFallback prefers native import when bun runtime is available", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  const imported = []

  const loaded = await mod.loadModuleWithTsFallback("C:\\virtual\\module.ts", {
    bunVersion: "1.3.7",
    importImpl: async (specifier) => {
      imported.push(specifier)
      return { default: "native" }
    },
    loadJitiImpl: async () => {
      throw new Error("loadJiti should not be used")
    },
  })

  assert.deepEqual(imported, ["file:///C:/virtual/module.ts"])
  assert.deepEqual(loaded, { default: "native" })
})
