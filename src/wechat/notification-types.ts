import type { RequestPromptSummary } from "./question-interaction.js"

export type NotificationKind = "question" | "permission" | "sessionError"

export type NotificationStatus = "pending" | "sent" | "resolved" | "failed" | "suppressed"

export type NotificationRecord = {
  idempotencyKey: string
  kind: NotificationKind
  wechatAccountId: string
  userId: string
  createdAt: number
  status: NotificationStatus
  routeKey?: string
  handle?: string
  prompt?: RequestPromptSummary
  sentAt?: number
  resolvedAt?: number
  failedAt?: number
  suppressedAt?: number
  failureReason?: string
}
