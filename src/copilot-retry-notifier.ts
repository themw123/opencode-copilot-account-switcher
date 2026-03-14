export const ACCOUNT_SWITCH_TTL_MS = 30 * 60 * 1000

type ToastVariant = "info" | "success" | "warning" | "error"

type RetryToastState = {
  remaining: number
}

type RetryToastClient = {
  tui?: {
    showToast?: (options: {
      body: {
        title?: string
        message: string
        variant: ToastVariant
        duration?: number
      }
      query?: undefined
    }) => Promise<unknown>
  }
}

type RetryNotifierContext = {
  client?: RetryToastClient
  lastAccountSwitchAt?: number
  getLastAccountSwitchAt?: () => Promise<number | undefined> | number | undefined
  clearAccountSwitchContext?: (lastAccountSwitchAt?: number) => Promise<void>
  now?: () => number
}

function buildPrefix(lastAccountSwitchAt: number | undefined) {
  if (typeof lastAccountSwitchAt !== "number") return "Copilot 输入 ID 自动清理中"
  return "正在清理可能因账号切换遗留的非法输入 ID"
}

async function resolveToastAccountSwitchAt(ctx: RetryNotifierContext) {
  if (ctx.lastAccountSwitchAt !== undefined && ctx.lastAccountSwitchAt !== null) {
    return ctx.lastAccountSwitchAt
  }
  return ctx.getLastAccountSwitchAt?.()
}

function isAccountSwitchContextExpired(lastAccountSwitchAt: number | undefined, now: () => number) {
  if (typeof lastAccountSwitchAt !== "number") return false
  return now() - lastAccountSwitchAt >= ACCOUNT_SWITCH_TTL_MS
}

async function clearContext(ctx: RetryNotifierContext) {
  try {
    await ctx.clearAccountSwitchContext?.()
  } catch (error) {
    console.warn("[copilot-retry-notifier] failed to clear account-switch context", error)
  }
}

export function createCopilotRetryNotifier(ctx: RetryNotifierContext) {
  let lastExpiredContextClearedAt: number | undefined

  async function send(variant: ToastVariant, detail: string, state: RetryToastState, clear = false) {
    const now = ctx.now ?? Date.now
    const lastAccountSwitchAt = await resolveToastAccountSwitchAt(ctx)

    try {
      await ctx.client?.tui?.showToast?.({
        body: {
          variant,
          message: `${buildPrefix(lastAccountSwitchAt)}：${detail}，剩余 ${state.remaining} 项。`,
        },
      })
    } catch (error) {
      console.warn("[copilot-retry-notifier] failed to show toast", error)
    }

    if (
      !clear
      && isAccountSwitchContextExpired(lastAccountSwitchAt, now)
      && lastAccountSwitchAt !== lastExpiredContextClearedAt
    ) {
      lastExpiredContextClearedAt = lastAccountSwitchAt
      await clearContext({
        ...ctx,
        clearAccountSwitchContext: async () => {
          await ctx.clearAccountSwitchContext?.(lastAccountSwitchAt)
        },
      })
    }

    if (!clear) return

    await clearContext({
      ...ctx,
      clearAccountSwitchContext: async () => {
        await ctx.clearAccountSwitchContext?.(lastAccountSwitchAt)
      },
    })
  }

  return {
    started: async (state: RetryToastState) => send("info", "已开始自动清理", state),
    progress: async (state: RetryToastState) => send("info", "自动清理仍在继续", state),
    repairWarning: async (state: RetryToastState) => send("warning", "会话回写失败，继续尝试仅清理请求体", state),
    completed: async (state: RetryToastState) => send("success", "自动清理已完成", state, true),
    stopped: async (state: RetryToastState) => send("warning", "自动清理已停止", state, true),
  }
}
