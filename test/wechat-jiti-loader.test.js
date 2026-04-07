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

test("resolveCreateJiti supports nested default function under default object", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const createJiti = mod.resolveCreateJiti({
    default: {
      default() {
        return "nested-default-function"
      },
    },
  })

  assert.equal(createJiti(), "nested-default-function")
})

test("resolveCreateJiti supports nested module.exports function under default object", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const createJiti = mod.resolveCreateJiti({
    default: {
      "module.exports"() {
        return "nested-module-exports-function"
      },
    },
  })

  assert.equal(createJiti(), "nested-module-exports-function")
})

test("resolveCreateJiti rejects unsupported export shape", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  assert.throws(
    () => mod.resolveCreateJiti({ default: {} }),
    /createJiti export unavailable/i,
  )
})

test("resolveJitiEsmEntry resolves package.json to lib/jiti.cjs file URL", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const entry = mod.resolveJitiEsmEntry(() => "C:\\virtual\\node_modules\\jiti\\package.json")

  assert.equal(entry, "file:///C:/virtual/node_modules/jiti/lib/jiti.cjs")
})

test("resolveJitiCjsEntry resolves package.json to lib/jiti.cjs file path", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)

  const entry = mod.resolveJitiCjsEntry(() => "C:\\virtual\\node_modules\\jiti\\package.json")

  assert.equal(entry, "C:\\virtual\\node_modules\\jiti\\lib\\jiti.cjs")
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

test("loadJiti falls back to package import when require is unavailable", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  const imported = []

  const loaded = await mod.loadJiti((specifier) => {
    imported.push(specifier)
    return {
      createJiti() {
        return "esm-entry"
      },
    }
  }, () => "C:\\virtual\\node_modules\\jiti\\package.json", () => {
    throw new Error("require unavailable")
  })

  assert.deepEqual(imported, ["jiti"])
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
  }, undefined, () => {
    throw new Error("require unavailable")
  })

  assert.equal(imported, 1)
  assert.equal(typeof loaded.createJiti, "function")
  assert.equal(loaded.createJiti(), "async-import")
})

test("loadJiti prefers require-based loading when available", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  let imported = 0
  let requiredSpecifier = ""

  const loaded = await mod.loadJiti(async () => {
    imported += 1
    return {
      createJiti() {
        return "imported"
      },
    }
  }, () => "C:\\virtual\\node_modules\\jiti\\package.json", (specifier) => {
    requiredSpecifier = String(specifier)
    return {
    createJiti() {
      return "required"
    },
    }
  })

  assert.equal(imported, 0)
  assert.equal(requiredSpecifier, "jiti")
  assert.equal(typeof loaded.createJiti, "function")
  assert.equal(loaded.createJiti(), "required")
})

test("loadModuleWithTsFallback uses jiti for ts modules even when bun runtime is available", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  const imported = []
  let loadJitiCalls = 0

  const loaded = await mod.loadModuleWithTsFallback("C:\\virtual\\module.ts", {
    bunVersion: "1.3.7",
    importImpl: async (specifier) => {
      imported.push(specifier)
      return { default: "native" }
    },
    loadJitiImpl: async () => {
      loadJitiCalls += 1
      return {
        createJiti() {
          return () => ({ default: "jiti" })
        },
      }
    },
  })

  assert.deepEqual(imported, [])
  assert.equal(loadJitiCalls, 1)
  assert.deepEqual(loaded, { default: "jiti" })
})

test("loadModuleWithTsFallback still prefers native import for js modules when bun runtime is available", async () => {
  const mod = await import(DIST_JITI_LOADER_MODULE)
  const imported = []

  const loaded = await mod.loadModuleWithTsFallback("C:\\virtual\\module.js", {
    bunVersion: "1.3.7",
    importImpl: async (specifier) => {
      imported.push(specifier)
      return { default: "native-js" }
    },
    loadJitiImpl: async () => {
      throw new Error("loadJiti should not be used for js modules")
    },
  })

  assert.deepEqual(imported, ["file:///C:/virtual/module.js"])
  assert.deepEqual(loaded, { default: "native-js" })
})
