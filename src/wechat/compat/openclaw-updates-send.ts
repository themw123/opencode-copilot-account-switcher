import { createRequire } from "node:module"
import { loadModuleWithTsFallback } from "./jiti-loader.js"

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

type PublicGetUpdates = (params: {
  baseUrl: string
  token?: string
  get_updates_buf?: string
  timeoutMs?: number
}) => Promise<{
  msgs?: PublicWeixinMessage[]
  get_updates_buf?: string
}>

const OPENCLAW_UPDATES_MODULE = "@tencent-weixin/openclaw-weixin/src/api/api.ts"
const OPENCLAW_SEND_MODULE = "@tencent-weixin/openclaw-weixin/src/messaging/send.ts"

function toObjectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

export function createOpenClawUpdatesHelper(getUpdates: PublicGetUpdates): { getUpdates: PublicGetUpdates } {
  return {
    async getUpdates(input) {
      return getUpdates(toObjectInput(input) as Parameters<PublicGetUpdates>[0])
    },
  }
}

export function createOpenClawSendHelper(sendMessageWeixin: PublicWeixinSendMessage): {
  sendMessageWeixin: PublicWeixinSendMessage
} {
  return {
    async sendMessageWeixin(input) {
      return sendMessageWeixin(toObjectInput(input) as Parameters<PublicWeixinSendMessage>[0])
    },
  }
}

export async function loadOpenClawUpdatesAndSendHelpers(options: {
  getUpdatesModulePath?: string
  sendMessageWeixinModulePath?: string
} = {}): Promise<{
  getUpdates: PublicGetUpdates
  sendMessageWeixin: PublicWeixinSendMessage
}> {
  const require = createRequire(import.meta.url)
  const getUpdatesModulePath = require.resolve(options.getUpdatesModulePath ?? OPENCLAW_UPDATES_MODULE)
  const sendModulePath = require.resolve(options.sendMessageWeixinModulePath ?? OPENCLAW_SEND_MODULE)

  const getUpdatesModule = await loadModuleWithTsFallback(getUpdatesModulePath, { parentURL: import.meta.url }) as {
    getUpdates?: PublicGetUpdates
  }
  const sendModule = await loadModuleWithTsFallback(sendModulePath, { parentURL: import.meta.url }) as {
    sendMessageWeixin?: PublicWeixinSendMessage
  }

  if (typeof getUpdatesModule.getUpdates !== "function") {
    throw new Error("public getUpdates helper unavailable")
  }
  if (typeof sendModule.sendMessageWeixin !== "function") {
    throw new Error("public sendMessageWeixin helper unavailable")
  }

  return {
    ...createOpenClawUpdatesHelper(getUpdatesModule.getUpdates),
    ...createOpenClawSendHelper(sendModule.sendMessageWeixin),
  }
}
