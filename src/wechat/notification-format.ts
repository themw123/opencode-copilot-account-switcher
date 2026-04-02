import type { NotificationRecord } from "./notification-types.js"

function formatHandle(handle: string | undefined, fallback: string): string {
  if (typeof handle === "string" && handle.trim().length > 0) {
    return handle
  }
  return fallback
}

export function formatWechatNotificationText(record: NotificationRecord): string {
  if (record.kind === "question") {
    const handle = formatHandle(record.handle, "q?")
    return `收到新的问题请求（${handle}），请在 OpenCode 中处理。`
  }

  if (record.kind === "permission") {
    const handle = formatHandle(record.handle, "p?")
    return `收到新的权限请求（${handle}），请在 OpenCode 中处理。`
  }

  return "检测到会话异常（retry），请在 OpenCode 中检查并处理。"
}
