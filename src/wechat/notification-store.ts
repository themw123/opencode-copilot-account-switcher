import path from "node:path"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import {
  WECHAT_FILE_MODE,
  ensureWechatStateLayout,
  notificationStatePath,
  notificationsDir,
} from "./state-paths.js"
import { type NotificationKind, type NotificationRecord } from "./notification-types.js"

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNotificationKind(value: unknown): value is NotificationKind {
  return value === "question" || value === "permission" || value === "sessionError"
}

function isNotificationStatus(value: unknown): value is NotificationRecord["status"] {
  return ["pending", "sent", "resolved", "failed", "suppressed"].includes(value as NotificationRecord["status"])
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeRecord(input: NotificationRecord): NotificationRecord {
  const base = {
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    createdAt: input.createdAt,
    status: input.status,
    ...(typeof input.sentAt === "number" ? { sentAt: input.sentAt } : {}),
    ...(typeof input.resolvedAt === "number" ? { resolvedAt: input.resolvedAt } : {}),
    ...(typeof input.failedAt === "number" ? { failedAt: input.failedAt } : {}),
    ...(typeof input.suppressedAt === "number" ? { suppressedAt: input.suppressedAt } : {}),
    ...(isNonEmptyString(input.failureReason) ? { failureReason: input.failureReason } : {}),
  }

  if (input.kind === "sessionError") {
    return base
  }

  return {
    ...base,
    ...(isNonEmptyString(input.routeKey) ? { routeKey: input.routeKey } : {}),
    ...(isNonEmptyString(input.handle) ? { handle: input.handle } : {}),
  }
}

function assertValidIdempotencyKey(idempotencyKey: string) {
  if (!/^[a-z0-9-]+$/.test(idempotencyKey) || idempotencyKey.includes("..")) {
    throw new Error("invalid notification record format")
  }
}

function toRecord(input: unknown): NotificationRecord {
  const parsed = input as Partial<NotificationRecord>
  if (
    !parsed ||
    !isNonEmptyString(parsed.idempotencyKey) ||
    !isNotificationKind(parsed.kind) ||
    !isNonEmptyString(parsed.wechatAccountId) ||
    !isNonEmptyString(parsed.userId) ||
    !isFiniteNumber(parsed.createdAt) ||
    !isNotificationStatus(parsed.status)
  ) {
    throw new Error("invalid notification record format")
  }

  if (
    (parsed.sentAt !== undefined && !isFiniteNumber(parsed.sentAt)) ||
    (parsed.resolvedAt !== undefined && !isFiniteNumber(parsed.resolvedAt)) ||
    (parsed.failedAt !== undefined && !isFiniteNumber(parsed.failedAt)) ||
    (parsed.suppressedAt !== undefined && !isFiniteNumber(parsed.suppressedAt)) ||
    (parsed.failureReason !== undefined && !isNonEmptyString(parsed.failureReason))
  ) {
    throw new Error("invalid notification record format")
  }

  if (parsed.kind === "sessionError") {
    if (parsed.routeKey !== undefined || parsed.handle !== undefined) {
      throw new Error("invalid notification record format")
    }
  } else {
    if (!isNonEmptyString(parsed.routeKey) || !isNonEmptyString(parsed.handle)) {
      throw new Error("invalid notification record format")
    }
  }

  if (parsed.status === "sent" && !isFiniteNumber(parsed.sentAt)) {
    throw new Error("invalid notification record format")
  }
  if (parsed.status === "resolved" && !isFiniteNumber(parsed.resolvedAt)) {
    throw new Error("invalid notification record format")
  }
  if (
    parsed.status === "failed" &&
    (!isFiniteNumber(parsed.failedAt) || !isNonEmptyString(parsed.failureReason))
  ) {
    throw new Error("invalid notification record format")
  }
  if (parsed.status === "suppressed" && !isFiniteNumber(parsed.suppressedAt)) {
    throw new Error("invalid notification record format")
  }

  return normalizeRecord(parsed as NotificationRecord)
}

async function readNotification(idempotencyKey: string): Promise<NotificationRecord> {
  try {
    const raw = await readFile(notificationStatePath(idempotencyKey), "utf8")
    const record = toRecord(JSON.parse(raw))
    if (record.idempotencyKey !== idempotencyKey) {
      throw new Error("invalid notification record format")
    }
    return record
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") throw error
    if (error instanceof Error && error.message === "invalid notification record format") throw error
    throw new Error("invalid notification record format")
  }
}

async function writeNotification(record: NotificationRecord): Promise<NotificationRecord> {
  await ensureWechatStateLayout()
  const filePath = notificationStatePath(record.idempotencyKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  const normalized = normalizeRecord(record)
  await writeFile(filePath, JSON.stringify(normalized, null, 2), { mode: WECHAT_FILE_MODE })
  return normalized
}

export async function upsertNotification(
  input: Omit<NotificationRecord, "status" | "sentAt" | "resolvedAt" | "failedAt" | "suppressedAt" | "failureReason">,
): Promise<NotificationRecord> {
  if (
    !isNonEmptyString((input as { idempotencyKey: unknown }).idempotencyKey) ||
    !isNotificationKind((input as { kind: unknown }).kind) ||
    !isNonEmptyString((input as { wechatAccountId: unknown }).wechatAccountId) ||
    !isNonEmptyString((input as { userId: unknown }).userId) ||
    !isFiniteNumber((input as { createdAt: unknown }).createdAt)
  ) {
    throw new Error("invalid notification record format")
  }

  assertValidIdempotencyKey(input.idempotencyKey)

  if (input.kind === "sessionError") {
    if ((input as { routeKey?: string }).routeKey !== undefined || (input as { handle?: string }).handle !== undefined) {
      throw new Error("invalid notification record format")
    }
  } else if (
    !isNonEmptyString((input as { routeKey?: unknown }).routeKey) ||
    !isNonEmptyString((input as { handle?: unknown }).handle)
  ) {
    throw new Error("invalid notification record format")
  }

  try {
    return await readNotification(input.idempotencyKey)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") throw error
  }

  return writeNotification({
    ...input,
    status: "pending",
  })
}

export async function markNotificationSent(input: { idempotencyKey: string; sentAt: number }): Promise<NotificationRecord> {
  if (!isFiniteNumber(input.sentAt) || !isNonEmptyString(input.idempotencyKey)) {
    throw new Error("invalid notification record format")
  }
  assertValidIdempotencyKey(input.idempotencyKey)
  const current = await readNotification(input.idempotencyKey)
  if (current.status !== "pending") {
    throw new Error("notification is not pending")
  }
  return writeNotification({
    ...current,
    status: "sent",
    sentAt: input.sentAt,
  })
}

export async function markNotificationResolved(input: {
  idempotencyKey: string
  resolvedAt: number
  suppressed?: boolean
}): Promise<NotificationRecord> {
  if (!isFiniteNumber(input.resolvedAt) || !isNonEmptyString(input.idempotencyKey)) {
    throw new Error("invalid notification record format")
  }
  assertValidIdempotencyKey(input.idempotencyKey)
  const current = await readNotification(input.idempotencyKey)
  if (input.suppressed) {
    if (current.status !== "pending" && current.status !== "sent") {
      throw new Error("notification is neither pending nor sent")
    }
    return writeNotification({
      ...current,
      status: "suppressed",
      suppressedAt: input.resolvedAt,
    })
  }

  if (current.status !== "sent") {
    throw new Error("notification is not sent")
  }

  return writeNotification({
    ...current,
    status: "resolved",
    resolvedAt: input.resolvedAt,
  })
}

export async function markNotificationFailed(input: {
  idempotencyKey: string
  failedAt: number
  reason: string
}): Promise<NotificationRecord> {
  if (!isFiniteNumber(input.failedAt) || !isNonEmptyString(input.reason) || !isNonEmptyString(input.idempotencyKey)) {
    throw new Error("invalid notification record format")
  }
  assertValidIdempotencyKey(input.idempotencyKey)
  const current = await readNotification(input.idempotencyKey)
  if (current.status !== "pending") {
    throw new Error("notification is not pending")
  }
  return writeNotification({
    ...current,
    status: "failed",
    failedAt: input.failedAt,
    failureReason: input.reason,
  })
}

export async function listPendingNotifications(): Promise<NotificationRecord[]> {
  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  const pending: NotificationRecord[] = []
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    const idempotencyKey = fileName.slice(0, -5)
    const record = await readNotification(idempotencyKey)
    if (record.status === "pending") {
      pending.push(record)
    }
  }
  pending.sort((a, b) => a.createdAt - b.createdAt)
  return pending
}

export async function findSentNotificationByRequest(input: {
  kind: Exclude<NotificationKind, "sessionError">
  routeKey: string
  handle: string
}): Promise<NotificationRecord | undefined> {
  if (
    (input.kind !== "question" && input.kind !== "permission")
    || !isNonEmptyString(input.routeKey)
    || !isNonEmptyString(input.handle)
  ) {
    throw new Error("invalid notification record format")
  }

  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  const expectedRouteKey = normalizeLookupValue(input.routeKey)
  const expectedHandle = normalizeLookupValue(input.handle)
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    const idempotencyKey = fileName.slice(0, -5)
    const record = await readNotification(idempotencyKey)
    if (record.status !== "sent") continue
    if (record.kind !== input.kind) continue
    if (!isNonEmptyString(record.routeKey) || !isNonEmptyString(record.handle)) continue
    if (normalizeLookupValue(record.routeKey) !== expectedRouteKey) continue
    if (normalizeLookupValue(record.handle) !== expectedHandle) continue
    return record
  }

  return undefined
}

function terminalAt(record: NotificationRecord): number | undefined {
  if (record.status === "resolved") return record.resolvedAt
  if (record.status === "failed") return record.failedAt
  if (record.status === "suppressed") return record.suppressedAt
  return undefined
}

export async function purgeTerminalNotificationsBefore(input: { cutoffAt: number }): Promise<number> {
  if (!isFiniteNumber(input.cutoffAt)) {
    throw new Error("invalid notification record format")
  }
  await ensureWechatStateLayout()
  const files = await readdir(notificationsDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  let deleted = 0
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) continue
    const idempotencyKey = fileName.slice(0, -5)
    const record = await readNotification(idempotencyKey)
    const at = terminalAt(record)
    if (typeof at !== "number") continue
    if (at >= input.cutoffAt) continue
    await rm(notificationStatePath(idempotencyKey), { force: true })
    deleted += 1
  }

  return deleted
}
