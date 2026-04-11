import path from "node:path"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import {
  ensureWechatStateLayout,
  WECHAT_FILE_MODE,
  wechatDeadLetterKindDir,
  wechatDeadLetterPath,
  type WechatRequestKind,
} from "./state-paths.js"
import { normalizeHandle } from "./handle.js"

export type WechatDeadLetterReason =
  | "instanceStale"
  | "startupCleanup"
  | "runtimeCleanup"
  | "manualCleanup"
  | "futureRecoveryFailed"

export type WechatDeadLetterRecoveryStatus = "recovered" | "failed"

export type WechatDeadLetterRecord = {
  kind: WechatRequestKind
  routeKey: string
  requestID: string
  handle: string
  scopeKey?: string
  finalStatus: "expired" | "cleaned"
  reason: WechatDeadLetterReason
  createdAt: number
  finalizedAt: number
  wechatAccountId?: string
  userId?: string
  instanceID?: string
  sessionID?: string
  recoveryStatus?: WechatDeadLetterRecoveryStatus
  recoveryErrorCode?: string
  recoveryErrorMessage?: string
  recoveryFailureToken?: string
  recoveredAt?: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isDeadLetterReason(value: unknown): value is WechatDeadLetterReason {
  return ["instanceStale", "startupCleanup", "runtimeCleanup", "manualCleanup", "futureRecoveryFailed"].includes(
    value as WechatDeadLetterReason,
  )
}

function isDeadLetterRecoveryStatus(value: unknown): value is WechatDeadLetterRecoveryStatus {
  return value === "recovered" || value === "failed"
}

function assertValidRouteKey(routeKey: string) {
  if (!/^[a-z0-9-]+$/.test(routeKey) || routeKey.includes("..")) {
    throw new Error("invalid dead-letter record format")
  }
}

function normalizeRecord(record: WechatDeadLetterRecord): WechatDeadLetterRecord {
  return {
    kind: record.kind,
    routeKey: record.routeKey,
    requestID: record.requestID,
    handle: record.handle,
    ...(isNonEmptyString(record.scopeKey) ? { scopeKey: record.scopeKey } : {}),
    finalStatus: record.finalStatus,
    reason: record.reason,
    createdAt: record.createdAt,
    finalizedAt: record.finalizedAt,
    ...(isNonEmptyString(record.wechatAccountId) ? { wechatAccountId: record.wechatAccountId } : {}),
    ...(isNonEmptyString(record.userId) ? { userId: record.userId } : {}),
    ...(isNonEmptyString(record.instanceID) ? { instanceID: record.instanceID } : {}),
    ...(isNonEmptyString(record.sessionID) ? { sessionID: record.sessionID } : {}),
    ...(isDeadLetterRecoveryStatus(record.recoveryStatus) ? { recoveryStatus: record.recoveryStatus } : {}),
    ...(record.recoveryStatus === "failed" && isNonEmptyString(record.recoveryErrorCode)
      ? { recoveryErrorCode: record.recoveryErrorCode }
      : {}),
    ...(record.recoveryStatus === "failed" && isNonEmptyString(record.recoveryErrorMessage)
      ? { recoveryErrorMessage: record.recoveryErrorMessage }
      : {}),
    ...(record.recoveryStatus === "failed" && isNonEmptyString(record.recoveryFailureToken)
      ? { recoveryFailureToken: record.recoveryFailureToken }
      : {}),
    ...(isFiniteNumber(record.recoveredAt) ? { recoveredAt: record.recoveredAt } : {}),
  }
}

function toDeadLetterRecord(input: unknown): WechatDeadLetterRecord {
  const parsed = input as Partial<WechatDeadLetterRecord>
  if (
    !parsed ||
    (parsed.kind !== "question" && parsed.kind !== "permission") ||
    !isNonEmptyString(parsed.routeKey) ||
    !isNonEmptyString(parsed.requestID) ||
    !isNonEmptyString(parsed.handle) ||
    parsed.finalStatus !== "expired" && parsed.finalStatus !== "cleaned" ||
    !isDeadLetterReason(parsed.reason) ||
    !isFiniteNumber(parsed.createdAt) ||
    !isFiniteNumber(parsed.finalizedAt) ||
    (parsed.scopeKey !== undefined && !isNonEmptyString(parsed.scopeKey)) ||
    (parsed.wechatAccountId !== undefined && !isNonEmptyString(parsed.wechatAccountId)) ||
    (parsed.userId !== undefined && !isNonEmptyString(parsed.userId)) ||
    (parsed.instanceID !== undefined && !isNonEmptyString(parsed.instanceID)) ||
    (parsed.sessionID !== undefined && !isNonEmptyString(parsed.sessionID)) ||
    (parsed.recoveryStatus !== undefined && !isDeadLetterRecoveryStatus(parsed.recoveryStatus)) ||
    (parsed.recoveryErrorCode !== undefined && !isNonEmptyString(parsed.recoveryErrorCode)) ||
    (parsed.recoveryErrorMessage !== undefined && !isNonEmptyString(parsed.recoveryErrorMessage)) ||
    (parsed.recoveryFailureToken !== undefined && !isNonEmptyString(parsed.recoveryFailureToken)) ||
    (parsed.recoveredAt !== undefined && !isFiniteNumber(parsed.recoveredAt))
  ) {
    throw new Error("invalid dead-letter record format")
  }

  assertValidRouteKey(parsed.routeKey)
  return normalizeRecord(parsed as WechatDeadLetterRecord)
}

async function readDeadLetterFile(kind: WechatRequestKind, routeKey: string): Promise<WechatDeadLetterRecord> {
  try {
    const raw = await readFile(wechatDeadLetterPath(kind, routeKey), "utf8")
    const record = toDeadLetterRecord(JSON.parse(raw))
    if (record.kind !== kind) {
      throw new Error("invalid dead-letter record format")
    }
    return record
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") throw error
    if (error instanceof Error && error.message === "invalid dead-letter record format") throw error
    throw new Error("invalid dead-letter record format")
  }
}

export async function writeDeadLetter(record: WechatDeadLetterRecord): Promise<WechatDeadLetterRecord> {
  await ensureWechatStateLayout()
  const normalized = toDeadLetterRecord(record)
  const filePath = wechatDeadLetterPath(normalized.kind, normalized.routeKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(normalized, null, 2), { mode: WECHAT_FILE_MODE })
  return normalized
}

export async function readDeadLetter(kind: WechatRequestKind, routeKey: string): Promise<WechatDeadLetterRecord | null> {
  try {
    return await readDeadLetterFile(kind, routeKey)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
}

async function listKind(kind: WechatRequestKind): Promise<WechatDeadLetterRecord[]> {
  try {
    const entries = await readdir(wechatDeadLetterKindDir(kind))
    const records = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
      const routeKey = entry.slice(0, -5)
      return readDeadLetterFile(kind, routeKey)
    }))
    return records.sort((left, right) => left.finalizedAt - right.finalizedAt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw error
  }
}

export async function listDeadLetters(kind?: WechatRequestKind): Promise<WechatDeadLetterRecord[]> {
  if (kind) {
    return listKind(kind)
  }
  const all = await Promise.all([listKind("question"), listKind("permission")])
  return all.flat().sort((left, right) => left.finalizedAt - right.finalizedAt)
}

function isRecoverableRecord(record: WechatDeadLetterRecord): boolean {
  return (
    record.reason === "instanceStale"
    && record.recoveryStatus !== "recovered"
    && isNonEmptyString(record.wechatAccountId)
    && isNonEmptyString(record.userId)
  )
}

function isRequestKind(value: unknown): value is WechatRequestKind {
  return value === "question" || value === "permission"
}

export async function listRecoverableDeadLetters(kind?: WechatRequestKind): Promise<WechatDeadLetterRecord[]> {
  const all = await listDeadLetters(kind)
  return all.filter(isRecoverableRecord)
}

export async function listDeadLettersByHandle(handle: string, kind?: WechatRequestKind): Promise<WechatDeadLetterRecord[]> {
  const normalizedHandle = normalizeHandle(handle)
  const all = await listDeadLetters(kind)
  return all.filter((record) => record.handle === normalizedHandle)
}

export async function listRecoverableDeadLettersByHandle(
  handle: string,
  kind?: WechatRequestKind,
): Promise<WechatDeadLetterRecord[]> {
  const normalizedHandle = normalizeHandle(handle)
  const recoverable = await listRecoverableDeadLetters(kind)
  return recoverable.filter((record) => record.handle === normalizedHandle)
}

export async function listRecoveryChainHandles(input: {
  kind: WechatRequestKind
  requestID: string
  wechatAccountId?: string
  userId?: string
}): Promise<string[]> {
  if (
    !isRequestKind((input as { kind: unknown }).kind)
    || !isNonEmptyString((input as { requestID: unknown }).requestID)
    || ((input as { wechatAccountId?: unknown }).wechatAccountId !== undefined
      && !isNonEmptyString((input as { wechatAccountId?: unknown }).wechatAccountId))
    || ((input as { userId?: unknown }).userId !== undefined
      && !isNonEmptyString((input as { userId?: unknown }).userId))
  ) {
    throw new Error("invalid dead-letter record format")
  }

  const all = await listDeadLetters(input.kind)
  return all
    .filter((record) => (
      record.requestID === input.requestID
      && record.wechatAccountId === input.wechatAccountId
      && record.userId === input.userId
    ))
    .map((record) => record.handle)
}

export async function markDeadLetterRecovered(input: {
  kind: WechatRequestKind
  routeKey: string
  recoveredAt: number
}): Promise<WechatDeadLetterRecord> {
  if (!isFiniteNumber(input.recoveredAt)) {
    throw new Error("invalid dead-letter record format")
  }

  const current = await readDeadLetterFile(input.kind, input.routeKey)
  return writeDeadLetter({
    ...current,
    recoveryStatus: "recovered",
    recoveryErrorCode: undefined,
    recoveryErrorMessage: undefined,
    recoveryFailureToken: undefined,
    recoveredAt: input.recoveredAt,
  })
}

export async function markDeadLetterRecoveryFailed(input: {
  kind: WechatRequestKind
  routeKey: string
  recoveryErrorCode: string
  recoveryErrorMessage: string
  recoveryFailureToken?: string
}): Promise<WechatDeadLetterRecord> {
  if (
    !isNonEmptyString(input.recoveryErrorCode)
    || !isNonEmptyString(input.recoveryErrorMessage)
    || (input.recoveryFailureToken !== undefined && !isNonEmptyString(input.recoveryFailureToken))
  ) {
    throw new Error("invalid dead-letter record format")
  }

  const current = await readDeadLetterFile(input.kind, input.routeKey)
  if (current.recoveryStatus === "recovered") {
    return current
  }
  return writeDeadLetter({
    ...current,
    recoveryStatus: "failed",
    recoveryErrorCode: input.recoveryErrorCode,
    recoveryErrorMessage: input.recoveryErrorMessage,
    recoveryFailureToken: input.recoveryFailureToken,
    recoveredAt: undefined,
  })
}

export async function purgeDeadLettersBefore(cutoffAt: number): Promise<WechatDeadLetterRecord[]> {
  if (!isFiniteNumber(cutoffAt)) {
    throw new Error("invalid dead-letter record format")
  }

  const deleted: WechatDeadLetterRecord[] = []
  for (const kind of ["question", "permission"] as const) {
    const records = await listKind(kind)
    for (const record of records) {
      if (record.finalizedAt >= cutoffAt) {
        continue
      }
      await rm(wechatDeadLetterPath(kind, record.routeKey), { force: true })
      deleted.push(record)
    }
  }
  return deleted
}
