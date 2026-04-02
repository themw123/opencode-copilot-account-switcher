import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { loadModuleWithTsFallback } from "./jiti-loader.js"

type CompatHostApi = {
  runtime?: {
    channelRuntime?: unknown
    gateway?: {
      startAccount?: unknown
    }
  }
  registerChannel?: (input: unknown) => void
  registerCli?: (handler: unknown, options?: unknown) => void
}

type OpenClawWeixinPlugin = {
  id?: string
  register(api: CompatHostApi): void
}

export type OpenClawWeixinPublicEntry = {
  packageJsonPath: string
  packageRoot: string
  extensions: string[]
  entryRelativePath: string
  entryAbsolutePath: string
}

function requireField(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[wechat-compat] ${message}`)
  }
}

export async function resolveOpenClawWeixinPublicEntry(): Promise<OpenClawWeixinPublicEntry> {
  const require = createRequire(import.meta.url)
  const packageName = "@tencent-weixin/openclaw-weixin"
  const packageJsonPath = require.resolve(`${packageName}/package.json`)
  const packageJsonRaw = await readFile(packageJsonPath, "utf8")
  const packageJson = JSON.parse(packageJsonRaw) as {
    openclaw?: { extensions?: unknown }
  }

  const extensions = Array.isArray(packageJson.openclaw?.extensions)
    ? packageJson.openclaw?.extensions.filter((it): it is string => typeof it === "string")
    : []

  requireField(extensions.length > 0, `${packageName} openclaw.extensions[0] is required`)
  const entryRelativePath = extensions[0]
  requireField(Boolean(entryRelativePath?.startsWith("./")), `${packageName} openclaw.extensions[0] must start with ./`)

  const packageRoot = path.dirname(packageJsonPath)
  const entryAbsolutePath = path.resolve(packageRoot, entryRelativePath)

  return {
    packageJsonPath,
    packageRoot,
    extensions,
    entryRelativePath,
    entryAbsolutePath,
  }
}

export async function loadOpenClawWeixinDefaultExport(): Promise<OpenClawWeixinPlugin> {
  const entry = await resolveOpenClawWeixinPublicEntry()
  const moduleNamespace = await loadModuleWithTsFallback(entry.entryAbsolutePath, { parentURL: import.meta.url }) as {
    default?: unknown
  }
  const plugin = moduleNamespace.default
  if (!plugin || typeof plugin !== "object" || typeof (plugin as OpenClawWeixinPlugin).register !== "function") {
    throw new Error("[wechat-compat] @tencent-weixin/openclaw-weixin public entry default export is missing register(api)")
  }
  return plugin as OpenClawWeixinPlugin
}

export async function loadRegisteredWeixinPluginPayloads(): Promise<Array<{ plugin?: unknown }>> {
  const context = await loadRegisteredWeixinPluginContext()
  return context.payloads
}

export async function loadRegisteredWeixinPluginContext(): Promise<{
  pluginId: string
  payloads: Array<{ plugin?: unknown }>
}> {
  const payloads: Array<{ plugin?: unknown }> = []
  const plugin = await loadOpenClawWeixinDefaultExport()
  plugin.register({
    runtime: {
      channelRuntime: { mode: "guided-smoke" },
      gateway: { startAccount: { source: "guided-smoke" } },
    },
    registerChannel(payload) {
      payloads.push(payload as { plugin?: unknown })
    },
    registerCli() {},
  })
  return {
    pluginId: typeof plugin.id === "string" && plugin.id.trim().length > 0 ? plugin.id : "wechat-openclaw-weixin",
    payloads,
  }
}
