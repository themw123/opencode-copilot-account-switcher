import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { createJiti } from "jiti"

type OpenClawWeixinPlugin = {
  id?: string
  register(api: CompatHostApi): void
}

export const OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES = {
  stateDir: "@tencent-weixin/openclaw-weixin/src/storage/state-dir.ts",
  syncBuf: "@tencent-weixin/openclaw-weixin/src/storage/sync-buf.ts",
  getUpdates: "@tencent-weixin/openclaw-weixin/src/api/api.ts",
  sendMessageWeixin: "@tencent-weixin/openclaw-weixin/src/messaging/send.ts",
} as const

type WeixinQrGateway = {
  loginWithQrStart: (input?: unknown) => unknown
  loginWithQrWait: (input?: unknown) => unknown
}

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

export type OpenClawWeixinPublicEntry = {
  packageJsonPath: string
  packageRoot: string
  extensions: string[]
  entryRelativePath: string
  entryAbsolutePath: string
}

let publicJitiLoader: ReturnType<typeof createJiti> | null = null

function requireField(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[wechat-compat] ${message}`)
  }
}

function getPublicJiti() {
  if (publicJitiLoader) {
    return publicJitiLoader
  }
  publicJitiLoader = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
  })
  return publicJitiLoader
}

function hasQrLoginMethods(value: unknown): value is WeixinQrGateway {
  if (!value || typeof value !== "object") {
    return false
  }
  const candidate = value as {
    loginWithQrStart?: unknown
    loginWithQrWait?: unknown
  }
  return typeof candidate.loginWithQrStart === "function" && typeof candidate.loginWithQrWait === "function"
}

async function resolveOpenClawWeixinPublicEntry(): Promise<OpenClawWeixinPublicEntry> {
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

async function loadOpenClawWeixinDefaultExport(): Promise<OpenClawWeixinPlugin> {
  const entry = await resolveOpenClawWeixinPublicEntry()
  const moduleNamespace = getPublicJiti()(entry.entryAbsolutePath) as {
    default?: unknown
  }
  const plugin = moduleNamespace.default
  if (!plugin || typeof plugin !== "object" || typeof (plugin as OpenClawWeixinPlugin).register !== "function") {
    throw new Error("[wechat-compat] @tencent-weixin/openclaw-weixin public entry default export is missing register(api)")
  }
  return plugin as OpenClawWeixinPlugin
}

async function loadPublicWeixinQrGateway(): Promise<{ gateway: WeixinQrGateway; pluginId: string }> {
  const registeredPayloads: unknown[] = []
  const compatHostApi: CompatHostApi = {
    runtime: {
      channelRuntime: {
        mode: "guided-smoke",
      },
      gateway: {
        startAccount: {
          source: "guided-smoke",
        },
      },
    },
    registerChannel(payload: unknown) {
      registeredPayloads.push(payload)
    },
    registerCli() {},
  }

  const plugin = await loadOpenClawWeixinDefaultExport()
  plugin.register(compatHostApi)
  for (const payload of registeredPayloads) {
    const payloadPlugin = (payload as { plugin?: unknown } | null | undefined)?.plugin
    const gateway = payloadPlugin && typeof payloadPlugin === "object" ? (payloadPlugin as { gateway?: unknown }).gateway : null
    if (hasQrLoginMethods(gateway)) {
      return { gateway, pluginId: plugin.id ?? "unknown" }
    }
    if (hasQrLoginMethods(payloadPlugin)) {
      return { gateway: payloadPlugin, pluginId: plugin.id ?? "unknown" }
    }
  }

  throw new Error("registerChannel did not expose weixin gateway loginWithQrStart/loginWithQrWait")
}

async function loadLatestWeixinAccountState(): Promise<{ accountId: string; token: string; baseUrl: string; getUpdatesBuf?: string } | null> {
  const require = createRequire(import.meta.url)
  const stateDirModulePath = require.resolve(OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.stateDir)
  const stateDirModule = getPublicJiti()(stateDirModulePath) as { resolveStateDir?: () => string }
  const stateDir = stateDirModule.resolveStateDir?.()
  if (!stateDir) {
    return null
  }

  const accountsIndexPath = path.join(stateDir, "openclaw-weixin", "accounts.json")
  let accountIds: string[] = []
  try {
    const raw = await readFile(accountsIndexPath, "utf8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      accountIds = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    }
  } catch {
    return null
  }

  const accountId = accountIds.at(-1)
  if (!accountId) {
    return null
  }

  try {
    const accountFilePath = path.join(stateDir, "openclaw-weixin", "accounts", `${accountId}.json`)
    const accountRaw = await readFile(accountFilePath, "utf8")
    const account = JSON.parse(accountRaw) as { token?: unknown; baseUrl?: unknown }
    const syncBufModulePath = require.resolve(OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.syncBuf)
    const syncBufModule = getPublicJiti()(syncBufModulePath) as {
      getSyncBufFilePath?: (accountId: string) => string
      loadGetUpdatesBuf?: (filePath: string) => string | undefined
    }
    if (typeof account.token !== "string" || account.token.trim().length === 0) {
      return null
    }
    const syncBufFilePath = syncBufModule.getSyncBufFilePath?.(accountId)
    const persistedGetUpdatesBuf = syncBufFilePath ? syncBufModule.loadGetUpdatesBuf?.(syncBufFilePath) : undefined
    return {
      accountId,
      token: account.token,
      baseUrl: typeof account.baseUrl === "string" && account.baseUrl.trim().length > 0 ? account.baseUrl : "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: typeof persistedGetUpdatesBuf === "string" ? persistedGetUpdatesBuf : undefined,
    }
  } catch {
    return null
  }
}

type PublicWeixinMessageItem = {
  type?: number
  text_item?: {
    text?: string
  }
}

export type PublicWeixinMessage = {
  message_id?: number
  from_user_id?: string
  context_token?: string
  create_time_ms?: number
  item_list?: PublicWeixinMessageItem[]
}

export type PublicWeixinSendMessage = (params: {
  to: string
  text: string
  opts: { baseUrl: string; token: string; contextToken?: string }
}) => Promise<{ messageId: string }>

export type PublicWeixinPersistGetUpdatesBuf = (params: {
  accountId: string
  getUpdatesBuf: string
}) => Promise<void>

export type OpenClawWeixinPublicHelpers = {
  entry: OpenClawWeixinPublicEntry
  pluginId: string
  qrGateway: WeixinQrGateway
  latestAccountState: { accountId: string; token: string; baseUrl: string; getUpdatesBuf?: string } | null
  getUpdates: (params: { baseUrl: string; token?: string; get_updates_buf?: string; timeoutMs?: number }) => Promise<{
    msgs?: PublicWeixinMessage[]
    get_updates_buf?: string
  }>
  sendMessageWeixin: PublicWeixinSendMessage
  persistGetUpdatesBuf?: PublicWeixinPersistGetUpdatesBuf
}

type OpenClawWeixinPublicHelpersLoaders = {
  resolveOpenClawWeixinPublicEntry?: typeof resolveOpenClawWeixinPublicEntry
  loadPublicWeixinQrGateway?: () => Promise<{ gateway: WeixinQrGateway; pluginId?: string }>
  loadLatestWeixinAccountState?: typeof loadLatestWeixinAccountState
  loadPublicWeixinHelpers?: typeof loadPublicWeixinHelpers
  loadPublicWeixinSendHelper?: typeof loadPublicWeixinSendHelper
}

function missingHelperError(helperName: string): Error {
  return new Error(`[wechat-compat] required helper missing: ${helperName}`)
}

async function loadPublicWeixinHelpers(): Promise<{
  getUpdates: (params: { baseUrl: string; token?: string; get_updates_buf?: string; timeoutMs?: number }) => Promise<{ msgs?: PublicWeixinMessage[]; get_updates_buf?: string }>
}> {
  const require = createRequire(import.meta.url)
  const getUpdatesModulePath = require.resolve(OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.getUpdates)
  const getUpdatesModule = getPublicJiti()(getUpdatesModulePath) as {
    getUpdates?: (params: { baseUrl: string; token?: string; get_updates_buf?: string; timeoutMs?: number }) => Promise<{ msgs?: PublicWeixinMessage[]; get_updates_buf?: string }>
  }
  if (typeof getUpdatesModule.getUpdates !== "function") {
    throw new Error("public getUpdates helper unavailable")
  }
  return {
    getUpdates: getUpdatesModule.getUpdates,
  }
}

async function loadPublicWeixinSendHelper(): Promise<{
  sendMessageWeixin: PublicWeixinSendMessage
}> {
  const require = createRequire(import.meta.url)
  const sendModulePath = require.resolve(OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.sendMessageWeixin)
  const sendModule = getPublicJiti()(sendModulePath) as {
    sendMessageWeixin?: PublicWeixinSendMessage
  }
  if (typeof sendModule.sendMessageWeixin !== "function") {
    throw new Error("public sendMessageWeixin helper unavailable")
  }
  return {
    sendMessageWeixin: sendModule.sendMessageWeixin,
  }
}

async function loadPublicWeixinSyncBufHelpers(): Promise<{
  persistGetUpdatesBuf?: PublicWeixinPersistGetUpdatesBuf
}> {
  const require = createRequire(import.meta.url)
  const syncBufModulePath = require.resolve(OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.syncBuf)
  const syncBufModule = getPublicJiti()(syncBufModulePath) as {
    getSyncBufFilePath?: (accountId: string) => string
    saveGetUpdatesBuf?: (filePath: string, getUpdatesBuf: string) => void
  }

  if (typeof syncBufModule.getSyncBufFilePath !== "function" || typeof syncBufModule.saveGetUpdatesBuf !== "function") {
    return {}
  }

  return {
    persistGetUpdatesBuf: async ({ accountId, getUpdatesBuf }) => {
      const filePath = syncBufModule.getSyncBufFilePath!(accountId)
      syncBufModule.saveGetUpdatesBuf!(filePath, getUpdatesBuf)
    },
  }
}

export async function loadOpenClawWeixinPublicHelpers(
  loaders: OpenClawWeixinPublicHelpersLoaders = {},
): Promise<OpenClawWeixinPublicHelpers> {
  const entry = await (loaders.resolveOpenClawWeixinPublicEntry ?? resolveOpenClawWeixinPublicEntry)()
  const qrGatewayResult = await (loaders.loadPublicWeixinQrGateway ?? loadPublicWeixinQrGateway)()
  const latestAccountState = await (loaders.loadLatestWeixinAccountState ?? loadLatestWeixinAccountState)()
  const publicHelpers = await (loaders.loadPublicWeixinHelpers ?? loadPublicWeixinHelpers)()
  const sendHelper = await (loaders.loadPublicWeixinSendHelper ?? loadPublicWeixinSendHelper)()
  const syncBufHelpers = await loadPublicWeixinSyncBufHelpers()

  if (typeof qrGatewayResult?.gateway?.loginWithQrStart !== "function" || typeof qrGatewayResult?.gateway?.loginWithQrWait !== "function") {
    throw missingHelperError("qrGateway")
  }
  if (typeof publicHelpers?.getUpdates !== "function") {
    throw missingHelperError("getUpdates")
  }
  if (typeof sendHelper?.sendMessageWeixin !== "function") {
    throw missingHelperError("sendMessageWeixin")
  }

  return {
    entry,
    pluginId: typeof qrGatewayResult.pluginId === "string" && qrGatewayResult.pluginId.length > 0 ? qrGatewayResult.pluginId : "unknown",
    qrGateway: qrGatewayResult.gateway,
    latestAccountState,
    getUpdates: publicHelpers.getUpdates,
    sendMessageWeixin: sendHelper.sendMessageWeixin,
    persistGetUpdatesBuf: syncBufHelpers.persistGetUpdatesBuf,
  }
}

export type OpenClawWeixinPublicHelpersLoaderOptions = OpenClawWeixinPublicHelpersLoaders
