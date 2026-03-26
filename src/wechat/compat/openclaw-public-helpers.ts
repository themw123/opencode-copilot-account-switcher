import { loadOpenClawAccountHelpers, type WeixinAccountHelpers } from "./openclaw-account-helpers.js"
import {
  loadRegisteredWeixinPluginContext,
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
import {
  loadLatestWeixinAccountState,
  loadOpenClawSyncBufHelper,
  type PublicWeixinPersistGetUpdatesBuf,
} from "./openclaw-sync-buf.js"

export const OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES = {
  stateDir: "@tencent-weixin/openclaw-weixin/src/storage/state-dir.ts",
  syncBuf: "@tencent-weixin/openclaw-weixin/src/storage/sync-buf.ts",
  getUpdates: "@tencent-weixin/openclaw-weixin/src/api/api.ts",
  sendMessageWeixin: "@tencent-weixin/openclaw-weixin/src/messaging/send.ts",
} as const

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
  loadRegisteredWeixinPluginContext?: typeof loadRegisteredWeixinPluginContext
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
        if (loaders.loadRegisteredWeixinPluginContext) {
          const context = await loaders.loadRegisteredWeixinPluginContext()
          return (loaders.loadOpenClawQrGateway ?? loadOpenClawQrGateway)(context.payloads, { pluginId: context.pluginId })
        }
        const context = await loadRegisteredWeixinPluginContext()
        return (loaders.loadOpenClawQrGateway ?? loadOpenClawQrGateway)(context.payloads, { pluginId: context.pluginId })
      })()
  const accountHelpers = await (loaders.loadOpenClawAccountHelpers ?? loadOpenClawAccountHelpers)()
  const latestAccountState = await (loaders.loadLatestWeixinAccountState ?? loadLatestWeixinAccountState)({
    stateDirModulePath: OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.stateDir,
    syncBufModulePath: OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.syncBuf,
  })
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
