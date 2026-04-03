import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"

import {
  createHostArtifact,
  createOpencodeLikeCacheLayout,
  loadInstalledPluginInBunStyle,
  runWechatBindScenario,
  resolveExecutable,
  toFileHref,
} from "./helpers/opencode-host-harness.js"

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

test("host gate artifact: packs current plugin and installs it into temporary opencode-like cache layout", async () => {
  const artifact = await createHostArtifact({
    repoRoot: REPO_ROOT,
  })

  let layout
  try {
    assert.match(artifact.tarballPath, /opencode-copilot-account-switcher-.*\.tgz$/)

    layout = await createOpencodeLikeCacheLayout({
      artifact,
    })

    assert.match(layout.cacheRoot, /opencode-host-gate/i)
    assert.equal(
      layout.cachePackageJson.dependencies["opencode-copilot-account-switcher"],
      `file:./artifacts/${path.basename(artifact.tarballPath)}`,
    )
    assert.equal(typeof layout.installedPluginRoot, "string")
    assert.equal(layout.installedPluginPackage.name, "opencode-copilot-account-switcher")
    assert.ok(layout.installedPluginDistExists)
  } finally {
    await layout?.cleanup?.()
    await artifact.cleanup()
  }
})

test("host gate artifact helper: resolves npm executable for windows without shell mode", () => {
  assert.equal(resolveExecutable("npm", "win32"), "npm.cmd")
  assert.equal(resolveExecutable("npm", "linux"), "npm")
  assert.equal(resolveExecutable("node", "win32"), "node")
})

test("host gate artifact helper: createHostArtifact cleans temporary directory when pack fails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-artifact-fail-"))

  await assert.rejects(
    () => createHostArtifact({
      repoRoot: REPO_ROOT,
      mkdtempImpl: async () => tempRoot,
      runCommandImpl: async () => {
        throw new Error("pack failed")
      },
    }),
    /pack failed/,
  )

  await assert.rejects(() => access(tempRoot))
})

test("host gate artifact helper: createOpencodeLikeCacheLayout cleans temporary directory when install fails", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-cache-fail-"))
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-artifact-fixture-"))
  const tarballPath = path.join(artifactRoot, "opencode-copilot-account-switcher-fixture.tgz")

  await rm(tarballPath, { force: true })
  await rm(path.join(cacheRoot, "package.json"), { force: true })

  const { writeFile } = await import("node:fs/promises")
  await writeFile(tarballPath, "fixture", "utf8")

  try {
    await assert.rejects(
      () => createOpencodeLikeCacheLayout({
        artifact: { tarballPath },
        mkdtempImpl: async () => cacheRoot,
        runCommandImpl: async () => {
          throw new Error("install failed")
        },
      }),
      /install failed/,
    )

    await assert.rejects(() => access(cacheRoot))
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("host gate plugin-load: loads installed plugin and internal entrypoints in bun style", async () => {
  const artifact = await createHostArtifact({
    repoRoot: REPO_ROOT,
  })

  let layout
  try {
    layout = await createOpencodeLikeCacheLayout({
      artifact,
    })

    const result = await loadInstalledPluginInBunStyle({
      cacheRoot: layout.cacheRoot,
    })

    assert.deepEqual(result, {
      ok: true,
      stage: "plugin-load",
      pluginPackageName: "opencode-copilot-account-switcher",
      internalHasBuildPluginHooks: true,
    })
  } finally {
    await layout?.cleanup?.()
    await artifact.cleanup()
  }
})

test("host gate plugin-load: classifies missing installed module as module-load failure", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-missing-modules-"))

  try {
    const result = await loadInstalledPluginInBunStyle({
      cacheRoot,
    })

    assert.equal(result.ok, false)
    assert.equal(result.stage, "module-load")
    assert.equal(typeof result.error, "string")
    assert.ok(result.error.length > 0)
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test("host gate plugin-load: fails when internal entrypoint lacks buildPluginHooks function", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-internal-missing-hook-"))

  try {
    const pluginDistRoot = path.join(
      cacheRoot,
      "node_modules",
      "opencode-copilot-account-switcher",
      "dist",
    )
    await mkdir(pluginDistRoot, { recursive: true })
    await writeFile(
      path.join(pluginDistRoot, "index.js"),
      "export function CopilotAccountSwitcher() {}\n",
      "utf8",
    )
    await writeFile(path.join(pluginDistRoot, "internal.js"), "export const buildPluginHooks = 1\n", "utf8")

    const result = await loadInstalledPluginInBunStyle({
      cacheRoot,
    })

    assert.equal(result.ok, false)
    assert.equal(result.stage, "module-load")
    assert.equal(result.internalHasBuildPluginHooks, false)
    assert.equal(typeof result.error, "string")
    assert.match(result.error, /buildPluginHooks/i)
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test("host gate plugin-load: encodes reserved characters in windows file href", () => {
  const href = toFileHref("C:\\tmp\\segment#hash?query\\dist\\index.js")

  assert.match(href, /^file:\/\//)
  assert.match(href, /%23/)
  assert.match(href, /%3F/)
})

test("host gate scenario: reaches provider adapter -> wechat-bind -> bind-flow and classifies compat-assembly", { timeout: 240_000 }, async () => {
  const artifact = await createHostArtifact({
    repoRoot: REPO_ROOT,
  })

  let layout
  try {
    layout = await createOpencodeLikeCacheLayout({ artifact })

    const result = await runWechatBindScenario({
      cacheRoot: layout.cacheRoot,
    })

    assert.equal(result.ok, false)
    assert.equal(result.reachedProviderRoute, true)
    assert.equal(result.reachedBindFlow, true)
    assert.equal(result.stage, "compat-assembly")
    assert.equal(typeof result.error, "string")
    assert.ok(result.error.length > 0)
  } finally {
    await layout?.cleanup?.()
    await artifact.cleanup()
  }
})

test("host gate scenario: real compat failure is classified inside host gate", { timeout: 480_000 }, async () => {
  const artifact = await createHostArtifact({
    repoRoot: REPO_ROOT,
  })

  let layout
  try {
    layout = await createOpencodeLikeCacheLayout({ artifact })

    const result = await runWechatBindScenario({
      cacheRoot: layout.cacheRoot,
      usePatchedCompat: false,
    })

    assert.equal(result.ok, false)
    assert.equal(result.stage, "compat-assembly")
    assert.equal(result.reachedProviderRoute, true)
    assert.equal(result.reachedBindFlow, true)
    assert.equal(typeof result.error, "string")
    assert.ok(result.error.length > 0)
    assert.match(result.error, /wechat-bind timeout after 45000ms|wechat bind failed:/i)
    assert.doesNotMatch(result.error, /timed out after 90000ms/i)
  } finally {
    await layout?.cleanup?.()
    await artifact.cleanup()
  }
})

test("host gate scenario: provider-route failure is classified when provider adapter route throws before bind-flow", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-provider-route-"))

  try {
    const adapterRoot = path.join(
      cacheRoot,
      "node_modules",
      "opencode-copilot-account-switcher",
      "dist",
      "providers",
    )
    await mkdir(adapterRoot, { recursive: true })
    await writeFile(
      path.join(adapterRoot, "copilot-menu-adapter.js"),
      `export function createCopilotMenuAdapter() {
  return {
    async applyAction(_store, action) {
      if (action?.type !== "provider" || action?.name !== "wechat-bind") {
        throw new Error("provider-route-invalid-action-fixture")
      }

      throw new Error("provider-route-fixture")
    },
  }
}
`,
      "utf8",
    )

    const result = await runWechatBindScenario({
      cacheRoot,
      usePatchedCompat: false,
    })

    assert.equal(result.ok, false)
    assert.equal(result.stage, "provider-route")
    assert.equal(result.reachedProviderRoute, true)
    assert.equal(result.reachedBindFlow, false)
    assert.match(result.error, /provider-route-fixture/)
    assert.doesNotMatch(result.error, /provider-route-invalid-action-fixture/)
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test("host gate scenario helper: usePatchedCompat false skips compat patching", async () => {
  const expected = {
    ok: false,
    stage: "module-load",
    reachedProviderRoute: false,
    reachedBindFlow: false,
    error: "fixture",
  }

  let patchCalled = false
  const result = await runWechatBindScenario(
    { cacheRoot: "C:/tmp/opencode-host-gate-cache-fixture", usePatchedCompat: false },
    {
      patchInstalledWechatCompatForScenarioImpl: async () => {
        patchCalled = true
        return async () => {}
      },
      runCommandImpl: async () => ({
        stdout: `${JSON.stringify(expected)}\n`,
        stderr: "",
      }),
    },
  )

  assert.equal(patchCalled, false)
  assert.deepEqual(result, expected)
})

test("host gate scenario helper: timed-out wrapper still returns structured payload from stdout", async () => {
  const expected = {
    ok: false,
    stage: "business-error",
    reachedProviderRoute: true,
    reachedBindFlow: true,
    error: "wechat bind failed: fixture",
  }
  const timeoutError = new Error("bun --eval script timed out after 90000ms")
  timeoutError.stdout = `debug\n${JSON.stringify(expected)}\n`

  const result = await runWechatBindScenario(
    { cacheRoot: "C:/tmp/opencode-host-gate-cache-fixture", usePatchedCompat: false },
    {
      runCommandImpl: async () => {
        throw timeoutError
      },
    },
  )

  assert.deepEqual(result, expected)
})

test("host gate scenario helper: timed-out wrapper without payload falls back to non-business-error classification", async () => {
  const timeoutError = new Error("bun --eval script timed out after 90000ms")
  timeoutError.stdout = ""

  const result = await runWechatBindScenario(
    { cacheRoot: "C:/tmp/opencode-host-gate-cache-fixture", usePatchedCompat: false },
    {
      runCommandImpl: async () => {
        throw timeoutError
      },
    },
  )

  assert.equal(result.ok, false)
  assert.equal(result.stage, "module-load")
  assert.equal(result.reachedProviderRoute, false)
  assert.equal(result.reachedBindFlow, false)
  assert.match(result.error, /timed out after 90000ms/i)
})

test("host gate scenario helper: restoreCompat failure does not swallow structured result", async () => {
  const expected = {
    ok: false,
    stage: "compat-assembly",
    reachedProviderRoute: true,
    reachedBindFlow: true,
    error: "wechat bind failed: host-gate-stop-after-compat-assembly",
  }

  const result = await runWechatBindScenario(
    { cacheRoot: "C:/tmp/opencode-host-gate-cache-fixture" },
    {
      patchInstalledWechatCompatForScenarioImpl: async () => async () => {
        throw new Error("restore failed")
      },
      runCommandImpl: async () => ({
        stdout: `debug\n${JSON.stringify(expected)}\n`,
        stderr: "",
      }),
    },
  )

  assert.deepEqual(result, expected)
})

test("host gate scenario helper: bun eval script flushes payload then exits", async () => {
  const expected = {
    ok: false,
    stage: "business-error",
    reachedProviderRoute: false,
    reachedBindFlow: false,
    error: "fixture",
  }

  let capturedScript = ""
  await runWechatBindScenario(
    { cacheRoot: "C:/tmp/opencode-host-gate-cache-fixture" },
    {
      patchInstalledWechatCompatForScenarioImpl: async () => async () => {},
      runCommandImpl: async (_command, args) => {
        capturedScript = String(args[1] ?? "")
        return {
          stdout: `${JSON.stringify(expected)}\n`,
          stderr: "",
        }
      },
    },
  )

  assert.equal(capturedScript.length > 0, true)
  assert.match(capturedScript, /process\.stdout\.write\(JSON\.stringify\(payload\) \+ "\\n", \(error\) => \{/)
  assert.match(capturedScript, /process\.exit\(0\)/)
})
