import { access, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function resolveExecutable(command, platform = process.platform) {
  if (platform === "win32" && command === "npm") {
    return "npm.cmd"
  }
  return command
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOptions } = options
    const resolvedCommand = resolveExecutable(command)
    const spawnCommand = process.platform === "win32" && resolvedCommand.endsWith(".cmd")
      ? "cmd.exe"
      : resolvedCommand
    const spawnArgs = process.platform === "win32" && resolvedCommand.endsWith(".cmd")
      ? ["/d", "/s", "/c", resolvedCommand, ...args]
      : args

    const child = spawn(spawnCommand, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...spawnOptions,
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })

    const timeoutHandle = typeof timeoutMs === "number" && timeoutMs > 0
      ? setTimeout(() => {
        child.kill()
        const timeoutError = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`)
        timeoutError.stdout = stdout
        timeoutError.stderr = stderr
        reject(timeoutError)
      }, timeoutMs)
      : null

    child.on("error", reject)
    child.on("close", (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      const commandError = new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`)
      commandError.stdout = stdout
      commandError.stderr = stderr
      reject(commandError)
    })
  })
}

export function toFileHref(absolutePath) {
  return pathToFileURL(absolutePath).href
}

function parseLastJsonLine(rawOutput) {
  if (typeof rawOutput !== "string") {
    return null
  }

  const lines = rawOutput.trim().split(/\r?\n/).filter(Boolean)
  const payload = lines[lines.length - 1] ?? ""
  if (!payload) {
    return null
  }

  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

async function removeTreeWithRetry(targetPath, { retries = 5, delayMs = 200 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error?.code
      const retryable = code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM"
      const shouldRetry = retryable && attempt < retries
      if (!shouldRetry) {
        throw error
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
    }
  }
}

export async function createHostArtifact({ repoRoot }) {
  const mkdtempImpl = arguments[0]?.mkdtempImpl ?? mkdtemp
  const runCommandImpl = arguments[0]?.runCommandImpl ?? runCommand
  const tempRoot = await mkdtempImpl(path.join(os.tmpdir(), "opencode-host-gate-artifact-"))

  try {
    const { stdout } = await runCommandImpl("npm", ["pack", "--json", "--pack-destination", tempRoot], {
      cwd: repoRoot,
    })
    const [packResult] = JSON.parse(stdout)

    return {
      tempRoot,
      tarballPath: path.join(tempRoot, packResult.filename),
      cleanup: async () => removeTreeWithRetry(tempRoot),
    }
  } catch (error) {
    await removeTreeWithRetry(tempRoot)
    throw error
  }
}

export async function createOpencodeLikeCacheLayout({ artifact }) {
  const mkdtempImpl = arguments[0]?.mkdtempImpl ?? mkdtemp
  const runCommandImpl = arguments[0]?.runCommandImpl ?? runCommand
  const cacheRoot = await mkdtempImpl(path.join(os.tmpdir(), "opencode-host-gate-cache-"))

  try {
    const artifactsDir = path.join(cacheRoot, "artifacts")
    await mkdir(artifactsDir, { recursive: true })

    const tarballName = path.basename(artifact.tarballPath)
    const stagedTarballPath = path.join(artifactsDir, tarballName)
    await copyFile(artifact.tarballPath, stagedTarballPath)

    const packageJsonPath = path.join(cacheRoot, "package.json")
    const cachePackageJson = {
      private: true,
      type: "module",
      dependencies: {
        "opencode-copilot-account-switcher": `file:./artifacts/${tarballName}`,
      },
    }
    await writeFile(packageJsonPath, `${JSON.stringify(cachePackageJson, null, 2)}\n`, "utf8")

    await runCommandImpl("npm", ["install"], { cwd: cacheRoot })

    const installedPluginRoot = path.join(cacheRoot, "node_modules", "opencode-copilot-account-switcher")
    const installedPluginPackage = JSON.parse(
      await readFile(path.join(installedPluginRoot, "package.json"), "utf8"),
    )

    let installedPluginDistExists = false
    try {
      await access(path.join(installedPluginRoot, "dist"))
      installedPluginDistExists = true
    } catch {
      installedPluginDistExists = false
    }

    return {
      cacheRoot,
      cachePackageJson,
      installedPluginRoot,
      installedPluginPackage,
      installedPluginDistExists,
      cleanup: async () => removeTreeWithRetry(cacheRoot),
    }
  } catch (error) {
    await removeTreeWithRetry(cacheRoot)
    throw error
  }
}

export async function loadInstalledPluginInBunStyle({ cacheRoot }) {
  const pluginEntry = path.join(
    cacheRoot,
    "node_modules",
    "opencode-copilot-account-switcher",
    "dist",
    "index.js",
  )
  const internalEntry = path.join(
    cacheRoot,
    "node_modules",
    "opencode-copilot-account-switcher",
    "dist",
    "internal.js",
  )
  const pluginEntryHref = toFileHref(pluginEntry)
  const internalEntryHref = toFileHref(internalEntry)

  const script = `
const pluginEntryHref = ${JSON.stringify(pluginEntryHref)}
const internalEntryHref = ${JSON.stringify(internalEntryHref)}

try {
  const pluginModule = await import(pluginEntryHref)
  const internalModule = await import(internalEntryHref)
  const hasPluginEntrypoint =
    typeof pluginModule.CopilotAccountSwitcher === "function" ||
    typeof pluginModule.OpenAICodexAccountSwitcher === "function"
  const internalHasBuildPluginHooks = typeof internalModule.buildPluginHooks === "function"

  if (!hasPluginEntrypoint || !internalHasBuildPluginHooks) {
    const issues = []
    if (!hasPluginEntrypoint) {
      issues.push("plugin entrypoint export is missing")
    }
    if (!internalHasBuildPluginHooks) {
      issues.push("internal buildPluginHooks export is missing or not a function")
    }

    console.log(JSON.stringify({
      ok: false,
      stage: "module-load",
      pluginPackageName: "opencode-copilot-account-switcher",
      internalHasBuildPluginHooks,
      error: issues.join("; "),
    }))
  } else {
    console.log(JSON.stringify({
      ok: true,
      stage: "plugin-load",
      pluginPackageName: "opencode-copilot-account-switcher",
      internalHasBuildPluginHooks: true,
    }))
  }
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.log(JSON.stringify({
    ok: false,
    stage: "module-load",
    pluginPackageName: "opencode-copilot-account-switcher",
    internalHasBuildPluginHooks: false,
    error: message,
  }))
}
`

  try {
    const { stdout } = await runCommand("bun", ["--eval", script], { cwd: cacheRoot })
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
    const payload = lines[lines.length - 1] ?? ""
    return JSON.parse(payload)
  } catch (error) {
    return {
      ok: false,
      stage: "module-load",
      pluginPackageName: "opencode-copilot-account-switcher",
      internalHasBuildPluginHooks: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function patchInstalledWechatCompatForScenario({ compatFilePath }) {
  const originalContent = await readFile(compatFilePath, "utf8")
  const patchedContent = `export async function loadOpenClawWeixinPublicHelpers() {
  globalThis.__wechatHostGateProbe = {
    ...(globalThis.__wechatHostGateProbe ?? {}),
    reachedCompatAssembly: true,
  }

  return {
    entry: {},
    pluginId: "host-gate-plugin",
    qrGateway: {
      loginWithQrStart: () => ({
        sessionKey: "host-gate-session",
        qrDataUrl: "https://host-gate.invalid/qr",
      }),
      loginWithQrWait: () => {
        throw new Error("host-gate-stop-after-compat-assembly")
      },
    },
    accountHelpers: {
      listAccountIds: async () => ["host-gate-account"],
      resolveAccount: async () => ({
        enabled: true,
        name: "Host Gate Account",
        userId: "host-gate-user",
      }),
      describeAccount: async () => ({
        configured: true,
      }),
    },
    latestAccountState: {
      accountId: "host-gate-account",
      token: "",
      baseUrl: "https://ilinkai.weixin.qq.com",
    },
    getUpdates: async () => ({ updates: [] }),
    sendMessageWeixin: async () => ({ ok: true }),
  }
}
`

  await writeFile(compatFilePath, patchedContent, "utf8")

  return async () => {
    await writeFile(compatFilePath, originalContent, "utf8")
  }
}

async function patchInstalledBindFlowProbeForScenario({ bindFlowFilePath }) {
  let originalContent
  try {
    originalContent = await readFile(bindFlowFilePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      return async () => {}
    }
    throw error
  }

  let patchedContent = originalContent
  patchedContent = patchedContent.replace(
    "export async function runWechatBindFlow(input) {",
    `export async function runWechatBindFlow(input) {
    globalThis.__wechatHostGateProbe = {
        ...(globalThis.__wechatHostGateProbe ?? {}),
        reachedBindFlow: true,
    };`,
  )
  patchedContent = patchedContent.replace(
    "const helpers = await loadPublicHelpers();",
    `globalThis.__wechatHostGateProbe = {
            ...(globalThis.__wechatHostGateProbe ?? {}),
            reachedCompatAssembly: true,
        };
        const helpers = await loadPublicHelpers();`,
  )

  await writeFile(bindFlowFilePath, patchedContent, "utf8")

  return async () => {
    await writeFile(bindFlowFilePath, originalContent, "utf8")
  }
}

export async function runWechatBindScenario({ cacheRoot, usePatchedCompat = true }, overrides = {}) {
  const runCommandImpl = overrides.runCommandImpl ?? runCommand
  const patchInstalledWechatCompatForScenarioImpl =
    overrides.patchInstalledWechatCompatForScenarioImpl ?? patchInstalledWechatCompatForScenario
  const patchInstalledBindFlowProbeForScenarioImpl =
    overrides.patchInstalledBindFlowProbeForScenarioImpl ?? patchInstalledBindFlowProbeForScenario
  const installedPluginRoot = path.join(cacheRoot, "node_modules", "opencode-copilot-account-switcher")
  const adapterEntry = path.join(installedPluginRoot, "dist", "providers", "copilot-menu-adapter.js")
  const compatFilePath = path.join(
    installedPluginRoot,
    "dist",
    "wechat",
    "compat",
    "openclaw-public-helpers.js",
  )
  const bindFlowFilePath = path.join(installedPluginRoot, "dist", "wechat", "bind-flow.js")
  const adapterEntryHref = toFileHref(adapterEntry)

  const restoreCompat = usePatchedCompat
    ? await patchInstalledWechatCompatForScenarioImpl({ compatFilePath })
    : null
  const restoreBindFlowProbe = await patchInstalledBindFlowProbeForScenarioImpl({ bindFlowFilePath })
  const script = `
const adapterEntryHref = ${JSON.stringify(adapterEntryHref)}
let payload

try {
  const adapterMod = await import(adapterEntryHref)
  const store = {
    active: undefined,
    accounts: {},
    autoRefresh: false,
    refreshMinutes: 15,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    experimentalSlashCommandsEnabled: true,
    syntheticAgentInitiatorEnabled: false,
  }

  const adapter = adapterMod.createCopilotMenuAdapter({
    client: { auth: { set: async () => {} } },
    readStore: async () => store,
    writeStore: async () => {},
    readAuth: async () => ({}),
    readCommonSettings: async () => ({
      wechat: {
        notifications: {
          enabled: true,
          question: true,
          permission: true,
          sessionError: true,
        },
      },
    }),
    writeCommonSettings: async () => {},
  })

  try {
    const bindTimeoutMs = 45_000
    let timeoutHandle
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("wechat-bind timeout after " + bindTimeoutMs + "ms")), bindTimeoutMs)
      timeoutHandle.unref?.()
    })
    try {
      await Promise.race([
        adapter.applyAction(store, { type: "provider", name: "wechat-bind" }),
        timeoutPromise,
      ])
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
    payload = {
      ok: false,
      stage: "provider-route",
      reachedProviderRoute: true,
      reachedBindFlow: false,
      error: "wechat-bind unexpectedly completed",
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    const reachedCompatAssembly = globalThis.__wechatHostGateProbe?.reachedCompatAssembly === true
    const reachedBindFlow = globalThis.__wechatHostGateProbe?.reachedBindFlow === true

    payload = {
      ok: false,
      stage: reachedCompatAssembly
        ? "compat-assembly"
        : reachedBindFlow
          ? "business-error"
          : "provider-route",
      reachedProviderRoute: true,
      reachedBindFlow,
      error: message,
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  payload = {
    ok: false,
    stage: "module-load",
    reachedProviderRoute: false,
    reachedBindFlow: false,
    error: message,
  }
}

await new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(payload) + "\\n", (error) => {
    if (error) {
      reject(error)
      return
    }
    resolve()
  })
})
process.exit(0)
`

  try {
    const { stdout } = await runCommandImpl("bun", ["--eval", script], {
      cwd: cacheRoot,
      timeoutMs: 90_000,
    })
    return parseLastJsonLine(stdout) ?? {
      ok: false,
      stage: "module-load",
      reachedProviderRoute: false,
      reachedBindFlow: false,
      error: "unable to parse gate payload from bun stdout",
    }
  } catch (error) {
    const parsedPayload = parseLastJsonLine(error?.stdout)
    if (parsedPayload) {
      return parsedPayload
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      stage: "module-load",
      reachedProviderRoute: false,
      reachedBindFlow: false,
      error: errorMessage,
    }
  } finally {
    try {
      await restoreBindFlowProbe?.()
    } catch {
      // best effort cleanup; preserve scenario payload
    }
    try {
      await restoreCompat?.()
    } catch {
      // best effort cleanup; preserve scenario payload
    }
  }
}
