import { bindOperator, readOperatorBinding, rebindOperator, resetOperatorBinding } from "./operator-store.js"
import { loadOpenClawWeixinPublicHelpers } from "./compat/openclaw-public-helpers.js"
import { buildOpenClawMenuAccount } from "./openclaw-account-adapter.js"
import type { CommonSettingsStore } from "../common-settings-store.js"

type BindAction = "wechat-bind" | "wechat-rebind"

type WechatBindFlowResult = {
  accountId: string
  userId: string
  name?: string
  enabled?: boolean
  configured?: boolean
  boundAt: number
}

type WechatBindFlowInput = {
  action: BindAction
  loadPublicHelpers?: typeof loadOpenClawWeixinPublicHelpers
  bindOperator?: typeof bindOperator
  rebindOperator?: typeof rebindOperator
  readOperatorBinding?: typeof readOperatorBinding
  resetOperatorBinding?: typeof resetOperatorBinding
  readCommonSettings: () => Promise<CommonSettingsStore>
  writeCommonSettings: (settings: CommonSettingsStore) => Promise<void>
  now?: () => number
}

function pickFirstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return String(error)
}

export async function runWechatBindFlow(input: WechatBindFlowInput): Promise<WechatBindFlowResult> {
  const now = input.now ?? Date.now
  const loadPublicHelpers = input.loadPublicHelpers ?? loadOpenClawWeixinPublicHelpers
  const persistOperatorBinding = input.bindOperator ?? bindOperator
  const persistOperatorRebinding = input.rebindOperator ?? rebindOperator
  const loadOperatorBinding = input.readOperatorBinding ?? readOperatorBinding
  const clearOperatorBinding = input.resetOperatorBinding ?? resetOperatorBinding

  try {
    const helpers = await loadPublicHelpers()
    const started = await Promise.resolve(helpers.qrGateway.loginWithQrStart({ source: "menu", action: input.action }))
    const sessionKey = pickFirstNonEmptyString(
      (started as { sessionKey?: unknown } | null | undefined)?.sessionKey,
      (started as { key?: unknown } | null | undefined)?.key,
    )
    const waited = await Promise.resolve(helpers.qrGateway.loginWithQrWait({ timeoutMs: 120000, sessionKey }))
    const accountId = pickFirstNonEmptyString(
      helpers.latestAccountState?.accountId,
      (waited as { accountId?: unknown } | null | undefined)?.accountId,
      (await helpers.accountHelpers.listAccountIds()).at(-1),
    )
    const userId = pickFirstNonEmptyString(
      (waited as { userId?: unknown } | null | undefined)?.userId,
      (waited as { openid?: unknown } | null | undefined)?.openid,
      (waited as { uid?: unknown } | null | undefined)?.uid,
    )

    if (!accountId) {
      throw new Error("missing accountId after qr login")
    }
    if (!userId) {
      throw new Error("missing userId after qr login")
    }

    const boundAt = now()
    const operatorBinding = {
      wechatAccountId: accountId,
      userId,
      boundAt,
    }
    const previousOperatorBinding = input.action === "wechat-rebind" ? await loadOperatorBinding() : undefined
    if (input.action === "wechat-rebind") {
      await persistOperatorRebinding(operatorBinding)
    } else {
      await persistOperatorBinding(operatorBinding)
    }

    const menuAccount = await buildOpenClawMenuAccount({
      latestAccountState: helpers.latestAccountState,
      accountHelpers: helpers.accountHelpers,
    })

    const settings = await input.readCommonSettings()
    const notifications = settings.wechat?.notifications ?? {
      enabled: true,
      question: true,
      permission: true,
      sessionError: true,
    }
    settings.wechat = {
      ...settings.wechat,
      notifications,
      primaryBinding: {
        accountId,
        userId,
        name: menuAccount?.name,
        enabled: menuAccount?.enabled,
        configured: menuAccount?.configured,
        boundAt,
      },
    }
    try {
      await input.writeCommonSettings(settings)
    } catch (error) {
      if (input.action === "wechat-rebind" && previousOperatorBinding) {
        await persistOperatorRebinding(previousOperatorBinding).catch(() => {})
      } else {
        await clearOperatorBinding().catch(() => {})
      }
      throw error
    }

    return {
      accountId,
      userId,
      name: menuAccount?.name,
      enabled: menuAccount?.enabled,
      configured: menuAccount?.configured,
      boundAt,
    }
  } catch (error) {
    if (input.action === "wechat-rebind") {
      throw new Error(`wechat rebind failed: ${toErrorMessage(error)}`)
    }
    throw new Error(`wechat bind failed: ${toErrorMessage(error)}`)
  }
}
