import path from "node:path"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import {
  ensureWechatStateLayout,
  WECHAT_FILE_MODE,
  wechatDeadLetterKindDir,
  wechatDeadLetterPath,
  type WechatRequestKind,
} from "./state-paths.js"

export type WechatDeadLetterReason =
  | "instanceStale"
  | "startupCleanup"
  | "runtimeCleanup"
  | "manualCleanup"
  | "futureRecoveryFailed"

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
    (parsed.sessionID !== undefined && !isNonEmptyString(parsed.sessionID))
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
