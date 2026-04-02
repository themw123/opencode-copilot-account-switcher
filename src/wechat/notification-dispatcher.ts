import { readCommonSettingsStore } from "../common-settings-store.js"
import {
  listPendingNotifications,
  markNotificationResolved,
  markNotificationFailed,
  markNotificationSent,
  purgeTerminalNotificationsBefore,
} from "./notification-store.js"
import { formatWechatNotificationText } from "./notification-format.js"
import type { NotificationKind } from "./notification-types.js"
import { findRequestByRouteKey } from "./request-store.js"

export type WechatNotificationSendInput = {
  to: string
  text: string
}

type CreateWechatNotificationDispatcherInput = {
  sendMessage: (input: WechatNotificationSendInput) => Promise<unknown>
}

type WechatNotificationDispatcher = {
  drainOutboundMessages: () => Promise<void>
}

const DEFAULT_NOTIFICATION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function toPositiveNumber(rawValue: string | undefined, fallback: number): number {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function shouldSendKind(kind: NotificationKind, notifications: {
  enabled: boolean
  question: boolean
  permission: boolean
  sessionError: boolean
}): boolean {
  if (!notifications.enabled) {
    return false
  }
  if (kind === "question") {
    return notifications.question
  }
  if (kind === "permission") {
    return notifications.permission
  }
  return notifications.sessionError
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  return String(error)
}

function isNotPendingStateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /not pending/i.test(error.message)
}

function isNotSuppressibleStateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /not pending|neither pending nor sent/i.test(error.message)
}

async function shouldSuppressPendingNotification(record: {
  kind: NotificationKind
  routeKey?: string
}): Promise<boolean> {
  if (record.kind === "sessionError") {
    return false
  }
  if (typeof record.routeKey !== "string" || record.routeKey.trim().length === 0) {
    return false
  }

  const request = await findRequestByRouteKey({
    kind: record.kind,
    routeKey: record.routeKey,
  })
  if (!request) {
    return false
  }
  return request.status !== "open"
}

export function createWechatNotificationDispatcher(
  input: CreateWechatNotificationDispatcherInput,
): WechatNotificationDispatcher {
  return {
    drainOutboundMessages: async () => {
      const retentionMs = toPositiveNumber(
        process.env.WECHAT_NOTIFICATION_TERMINAL_RETENTION_MS,
        DEFAULT_NOTIFICATION_TERMINAL_RETENTION_MS,
      )
      await purgeTerminalNotificationsBefore({
        cutoffAt: Date.now() - retentionMs,
      })

      const settings = await readCommonSettingsStore()
      const notifications = settings.wechat?.notifications
      const targetUserId = settings.wechat?.primaryBinding?.userId
      const targetAccountId = settings.wechat?.primaryBinding?.accountId
      if (!notifications) {
        return
      }
      if (typeof targetUserId !== "string" || targetUserId.trim().length === 0) {
        return
      }
      if (typeof targetAccountId !== "string" || targetAccountId.trim().length === 0) {
        return
      }

      const pending = await listPendingNotifications()
      for (const record of pending) {
        if (await shouldSuppressPendingNotification(record)) {
          try {
            await markNotificationResolved({
              idempotencyKey: record.idempotencyKey,
              resolvedAt: Date.now(),
              suppressed: true,
            })
          } catch (error) {
            if (!isNotSuppressibleStateError(error)) {
              throw error
            }
          }
          continue
        }

        if (!shouldSendKind(record.kind, notifications)) {
          continue
        }
        if (record.userId !== targetUserId || record.wechatAccountId !== targetAccountId) {
          continue
        }

        try {
          await input.sendMessage({
            to: targetUserId,
            text: formatWechatNotificationText(record),
          })
        } catch (error) {
          try {
            await markNotificationFailed({
              idempotencyKey: record.idempotencyKey,
              failedAt: Date.now(),
              reason: toErrorMessage(error),
            })
          } catch (markError) {
            if (!isNotPendingStateError(markError)) {
              throw markError
            }
          }
          continue
        }

        try {
          await markNotificationSent({
            idempotencyKey: record.idempotencyKey,
            sentAt: Date.now(),
          })
        } catch (error) {
          if (!isNotPendingStateError(error)) {
            throw error
          }
        }
      }
    },
  }
}
