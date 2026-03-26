import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { createJiti } from "jiti"
import { loadOpenClawAccountHelpers, type WeixinAccountHelpers } from "./openclaw-account-helpers.js"
import {
  loadRegisteredWeixinPluginPayloads,
  resolveOpenClawWeixinPublicEntry,
  type OpenClawWeixinPublicEntry,
} from "./openclaw-public-entry.js"
import { loadOpenClawQrGateway, type WeixinQrGateway } from "./openclaw-qr-gateway.js"
import {
  loadOpenClawUpdatesAndSendHelpers,
  type PublicWeixinMessage,
  type PublicWeixinSendMessage,
} from "./openclaw-updates-send.js"
import { loadOpenClawSyncBufHelper, type PublicWeixinPersistGetUpdatesBuf } from "./openclaw-sync-buf.js"

export const OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES = {
  stateDir: "@tencent-weixin/openclaw-weixin/src/storage/state-dir.ts",
  syncBuf: "@tencent-weixin/openclaw-weixin/src/storage/sync-buf.ts",
  getUpdates: "@tencent-weixin/openclaw-weixin/src/api/api.ts",
  sendMessageWeixin: "@tencent-weixin/openclaw-weixin/src/messaging/send.ts",
} as const

let publicJitiLoader: ReturnType<typeof createJiti> | null = null

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

export type OpenClawWeixinPublicHelpers = {
  entry: OpenClawWeixinPublicEntry
  pluginId: string
  qrGateway: WeixinQrGateway
  accountHelpers: WeixinAccountHelpers
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
  loadRegisteredWeixinPluginPayloads?: typeof loadRegisteredWeixinPluginPayloads
  loadOpenClawQrGateway?: (payloads: Array<{ plugin?: unknown }>) => Promise<{ gateway: WeixinQrGateway; pluginId: string }>
  loadPublicWeixinQrGateway?: () => Promise<{ gateway: WeixinQrGateway; pluginId?: string }>
  loadLatestWeixinAccountState?: typeof loadLatestWeixinAccountState
  loadOpenClawAccountHelpers?: typeof loadOpenClawAccountHelpers
  loadOpenClawUpdatesAndSendHelpers?: typeof loadOpenClawUpdatesAndSendHelpers
  loadOpenClawSyncBufHelper?: typeof loadOpenClawSyncBufHelper
  loadPublicWeixinHelpers?: () => Promise<{
    getUpdates: (params: { baseUrl: string; token?: string; get_updates_buf?: string; timeoutMs?: number }) => Promise<{ msgs?: PublicWeixinMessage[]; get_updates_buf?: string }>
  }>
  loadPublicWeixinSendHelper?: () => Promise<{
    sendMessageWeixin: PublicWeixinSendMessage
  }>
}

function missingHelperError(helperName: string): Error {
  return new Error(`[wechat-compat] required helper missing: ${helperName}`)
}

export async function loadOpenClawWeixinPublicHelpers(
  loaders: OpenClawWeixinPublicHelpersLoaders = {},
): Promise<OpenClawWeixinPublicHelpers> {
  const entry = await (loaders.resolveOpenClawWeixinPublicEntry ?? resolveOpenClawWeixinPublicEntry)()
  const qrGatewayResult = loaders.loadPublicWeixinQrGateway
    ? await loaders.loadPublicWeixinQrGateway()
    : await (async () => {
        const payloads = await (loaders.loadRegisteredWeixinPluginPayloads ?? loadRegisteredWeixinPluginPayloads)()
        return (loaders.loadOpenClawQrGateway ?? loadOpenClawQrGateway)(payloads)
      })()
  const accountHelpers = await (loaders.loadOpenClawAccountHelpers ?? loadOpenClawAccountHelpers)()
  const latestAccountState = await (loaders.loadLatestWeixinAccountState ?? loadLatestWeixinAccountState)()
  const updatesSend = loaders.loadOpenClawUpdatesAndSendHelpers
    ? await loaders.loadOpenClawUpdatesAndSendHelpers()
    : await (async () => {
        const defaults = await loadOpenClawUpdatesAndSendHelpers()
        const maybeUpdates = loaders.loadPublicWeixinHelpers ? await loaders.loadPublicWeixinHelpers() : undefined
        const maybeSend = loaders.loadPublicWeixinSendHelper ? await loaders.loadPublicWeixinSendHelper() : undefined
        return {
          getUpdates: loaders.loadPublicWeixinHelpers ? maybeUpdates?.getUpdates : defaults.getUpdates,
          sendMessageWeixin: loaders.loadPublicWeixinSendHelper ? maybeSend?.sendMessageWeixin : defaults.sendMessageWeixin,
        }
      })()
  const syncBufHelpers = await (loaders.loadOpenClawSyncBufHelper ?? loadOpenClawSyncBufHelper)()

  if (typeof qrGatewayResult?.gateway?.loginWithQrStart !== "function" || typeof qrGatewayResult?.gateway?.loginWithQrWait !== "function") {
    throw missingHelperError("qrGateway")
  }
  if (typeof updatesSend?.getUpdates !== "function") {
    throw missingHelperError("getUpdates")
  }
  if (
    typeof accountHelpers?.listAccountIds !== "function" ||
    typeof accountHelpers?.resolveAccount !== "function" ||
    typeof accountHelpers?.describeAccount !== "function"
  ) {
    throw missingHelperError("accountHelpers")
  }
  if (typeof updatesSend?.sendMessageWeixin !== "function") {
    throw missingHelperError("sendMessageWeixin")
  }

  return {
    entry,
    pluginId: typeof qrGatewayResult.pluginId === "string" && qrGatewayResult.pluginId.length > 0 ? qrGatewayResult.pluginId : "unknown",
    qrGateway: qrGatewayResult.gateway,
    accountHelpers,
    latestAccountState,
    getUpdates: updatesSend.getUpdates,
    sendMessageWeixin: updatesSend.sendMessageWeixin,
    persistGetUpdatesBuf: syncBufHelpers.persistGetUpdatesBuf,
  }
}

export type OpenClawWeixinPublicHelpersLoaderOptions = OpenClawWeixinPublicHelpersLoaders
export type { PublicWeixinMessage, PublicWeixinSendMessage, PublicWeixinPersistGetUpdatesBuf }
