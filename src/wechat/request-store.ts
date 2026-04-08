import path from "node:path"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import {
  WECHAT_FILE_MODE,
  ensureWechatStateLayout,
  requestKindDir,
  requestStatePath,
  type WechatRequestKind,
} from "./state-paths.js"
import { assertValidHandleInput, createRouteKey, normalizeHandle } from "./handle.js"

export type RequestStatus = "open" | "answered" | "rejected" | "expired" | "cleaned"

export type RequestRecord = {
  kind: WechatRequestKind
  requestID: string
  routeKey: string
  handle: string
  scopeKey?: string
  wechatAccountId: string
  userId: string
  status: RequestStatus
  createdAt: number
  answeredAt?: number
  rejectedAt?: number
  expiredAt?: number
  cleanedAt?: number
}

function normalizeRecord(input: RequestRecord): RequestRecord {
  return {
    kind: input.kind,
    requestID: input.requestID,
    routeKey: input.routeKey,
    handle: input.handle,
    ...(isNonEmptyString(input.scopeKey) ? { scopeKey: input.scopeKey } : {}),
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
    status: input.status,
    createdAt: input.createdAt,
    ...(typeof input.answeredAt === "number" ? { answeredAt: input.answeredAt } : {}),
    ...(typeof input.rejectedAt === "number" ? { rejectedAt: input.rejectedAt } : {}),
    ...(typeof input.expiredAt === "number" ? { expiredAt: input.expiredAt } : {}),
    ...(typeof input.cleanedAt === "number" ? { cleanedAt: input.cleanedAt } : {}),
  }
}

function isRequestStatus(value: unknown): value is RequestStatus {
  return ["open", "answered", "rejected", "expired", "cleaned"].includes(value as RequestStatus)
}

function isRequestKind(value: unknown): value is WechatRequestKind {
  return value === "question" || value === "permission"
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function normalizeRequestIdentity(value: string): string {
  return value.trim().toLowerCase()
}

function isSameOpenIdentity(
  current: Pick<RequestRecord, "requestID" | "wechatAccountId" | "userId">,
  input: Pick<RequestRecord, "requestID" | "wechatAccountId" | "userId">,
): boolean {
  return (
    normalizeRequestIdentity(current.requestID) === normalizeRequestIdentity(input.requestID)
    && current.wechatAccountId === input.wechatAccountId
    && current.userId === input.userId
  )
}

function assertValidRouteKey(routeKey: string) {
  if (!/^[a-z0-9-]+$/.test(routeKey) || routeKey.includes("..")) {
    throw new Error("invalid routeKey format")
  }
}

function toRequestRecord(input: unknown): RequestRecord {
  const parsed = input as Partial<RequestRecord>
  if (
    !parsed ||
    !isRequestKind(parsed.kind) ||
    !isNonEmptyString(parsed.requestID) ||
    !isNonEmptyString(parsed.routeKey) ||
    !isNonEmptyString(parsed.handle) ||
    (parsed.scopeKey !== undefined && !isNonEmptyString(parsed.scopeKey)) ||
    !isNonEmptyString(parsed.wechatAccountId) ||
    !isNonEmptyString(parsed.userId) ||
    !isFiniteNumber(parsed.createdAt) ||
    !isRequestStatus(parsed.status)
  ) {
    throw new Error("invalid request record format")
  }

  if (
    (parsed.answeredAt !== undefined && !isFiniteNumber(parsed.answeredAt)) ||
    (parsed.rejectedAt !== undefined && !isFiniteNumber(parsed.rejectedAt)) ||
    (parsed.expiredAt !== undefined && !isFiniteNumber(parsed.expiredAt)) ||
    (parsed.cleanedAt !== undefined && !isFiniteNumber(parsed.cleanedAt))
  ) {
    throw new Error("invalid request record format")
  }

  return normalizeRecord(parsed as RequestRecord)
}

async function readRequest(kind: WechatRequestKind, routeKey: string): Promise<RequestRecord> {
  try {
    const raw = await readFile(requestStatePath(kind, routeKey), "utf8")
    const record = toRequestRecord(JSON.parse(raw))
    if (record.kind !== kind) {
      throw new Error("invalid request record format")
    }
    return record
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") throw error
    if (error instanceof Error && error.message === "invalid request record format") throw error
    throw new Error("invalid request record format")
  }
}

async function readRequestIfExists(kind: WechatRequestKind, routeKey: string): Promise<RequestRecord | undefined> {
  try {
    return await readRequest(kind, routeKey)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

async function writeRequest(record: RequestRecord): Promise<RequestRecord> {
  await ensureWechatStateLayout()
  const filePath = requestStatePath(record.kind, record.routeKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  const normalized = normalizeRecord(record)
  await writeFile(filePath, JSON.stringify(normalized, null, 2), { mode: WECHAT_FILE_MODE })
  return normalized
}

async function markTerminalStatus(input: {
  kind: WechatRequestKind
  routeKey: string
  status: Exclude<RequestStatus, "open" | "cleaned">
  atField: "answeredAt" | "rejectedAt" | "expiredAt"
  at: number
}) {
  if (!isFiniteNumber(input.at)) {
    throw new Error("invalid request record format")
  }

  const current = await readRequest(input.kind, input.routeKey)
  if (current.status !== "open") {
    throw new Error("request is not open")
  }
  return writeRequest({
    ...current,
    status: input.status,
    [input.atField]: input.at,
  })
}

export async function upsertRequest(
  input: Omit<RequestRecord, "status" | "answeredAt" | "rejectedAt" | "expiredAt" | "cleanedAt">,
): Promise<RequestRecord> {
  if (
    !isRequestKind((input as { kind: unknown }).kind) ||
    !isNonEmptyString((input as { requestID: unknown }).requestID) ||
    !isNonEmptyString((input as { routeKey: unknown }).routeKey) ||
    !isNonEmptyString((input as { wechatAccountId: unknown }).wechatAccountId) ||
    !isNonEmptyString((input as { userId: unknown }).userId) ||
    !isFiniteNumber((input as { createdAt: unknown }).createdAt)
  ) {
    throw new Error("invalid request record format")
  }

  assertValidRouteKey(input.routeKey)
  assertValidHandleInput(input.handle)
  const normalizedHandle = normalizeHandle(input.handle)

  try {
    const current = await readRequest(input.kind, input.routeKey)
    if (current.status !== "open") {
      throw new Error("cannot upsert terminal request")
    }

    if (!isSameOpenIdentity(current, input)) {
      throw new Error("cannot upsert open request with different identity")
    }

    return current
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") throw error
  }

  const active = await listActiveRequests()
  if (active.some((item) => item.kind === input.kind && item.status === "open" && item.handle === normalizedHandle)) {
    throw new Error("open request handle already exists")
  }

  return writeRequest({
    ...input,
    handle: normalizedHandle,
    status: "open",
  })
}

export async function expireOpenRequestsForScope(input: {
  scopeKey: string
  expiredAt: number
}) {
  if (!isNonEmptyString(input.scopeKey) || !isFiniteNumber(input.expiredAt)) {
    throw new Error("invalid request record format")
  }

  const activeRequests = await listActiveRequests()
  const expired: RequestRecord[] = []

  for (const item of activeRequests) {
    if (item.status !== "open") {
      continue
    }
    if (item.scopeKey !== input.scopeKey) {
      continue
    }

    expired.push(await markRequestExpired({
      kind: item.kind,
      routeKey: item.routeKey,
      expiredAt: input.expiredAt,
    }))
  }

  return expired
}

export async function markRequestAnswered(input: {
  kind: WechatRequestKind
  routeKey: string
  answeredAt: number
}) {
  return markTerminalStatus({
    kind: input.kind,
    routeKey: input.routeKey,
    status: "answered",
    atField: "answeredAt",
    at: input.answeredAt,
  })
}

export async function markRequestRejected(input: {
  kind: WechatRequestKind
  routeKey: string
  rejectedAt: number
}) {
  return markTerminalStatus({
    kind: input.kind,
    routeKey: input.routeKey,
    status: "rejected",
    atField: "rejectedAt",
    at: input.rejectedAt,
  })
}

export async function markRequestExpired(input: {
  kind: WechatRequestKind
  routeKey: string
  expiredAt: number
}) {
  return markTerminalStatus({
    kind: input.kind,
    routeKey: input.routeKey,
    status: "expired",
    atField: "expiredAt",
    at: input.expiredAt,
  })
}

export async function markCleaned(input: {
  kind: WechatRequestKind
  routeKey: string
  cleanedAt: number
}) {
  const current = await readRequest(input.kind, input.routeKey)
  if (!["answered", "rejected", "expired"].includes(current.status)) {
    throw new Error("request cannot be cleaned from current status")
  }
  return writeRequest({
    ...current,
    status: "cleaned",
    cleanedAt: input.cleanedAt,
  })
}

export async function purgeCleanedBefore(input: { cutoffAt: number }) {
  await ensureWechatStateLayout()
  let deleted = 0

  for (const kind of ["question", "permission"] as const) {
    const dir = requestKindDir(kind)
    const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })

    for (const fileName of files) {
      if (!fileName.endsWith(".json")) continue
      const routeKey = fileName.slice(0, -5)
      const current = await readRequest(kind, routeKey)
      if (current.status !== "cleaned") continue
      if (typeof current.cleanedAt !== "number") continue
      if (current.cleanedAt >= input.cutoffAt) continue

      await rm(requestStatePath(kind, routeKey), { force: true })
      deleted += 1
    }
  }

  return deleted
}

export async function listActiveRequests(): Promise<RequestRecord[]> {
  await ensureWechatStateLayout()
  const result: RequestRecord[] = []

  for (const kind of ["question", "permission"] as const) {
    const dir = requestKindDir(kind)
    const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })

    for (const fileName of files) {
      if (!fileName.endsWith(".json")) continue
      const routeKey = fileName.slice(0, -5)
      const current = await readRequest(kind, routeKey)
      if (current.status === "cleaned") continue
      result.push(current)
    }
  }

  result.sort((a, b) => a.createdAt - b.createdAt)
  return result
}

export async function findOpenRequestByHandle(input: {
  kind: WechatRequestKind
  handle: string
}): Promise<RequestRecord | undefined> {
  if (!isRequestKind((input as { kind: unknown }).kind) || !isNonEmptyString((input as { handle: unknown }).handle)) {
    throw new Error("invalid request record format")
  }

  const normalizedHandle = normalizeHandle(input.handle)
  const all = await listActiveRequests()
  return all.find((item) => item.kind === input.kind && item.status === "open" && item.handle === normalizedHandle)
}

export async function findOpenRequestByIdentity(input: {
  kind: WechatRequestKind
  requestID: string
  wechatAccountId: string
  userId: string
  scopeKey?: string
}): Promise<RequestRecord | undefined> {
  if (
    !isRequestKind((input as { kind: unknown }).kind) ||
    !isNonEmptyString((input as { requestID: unknown }).requestID) ||
    !isNonEmptyString((input as { wechatAccountId: unknown }).wechatAccountId) ||
    !isNonEmptyString((input as { userId: unknown }).userId)
  ) {
    throw new Error("invalid request record format")
  }

  const routeKey = createRouteKey({
    kind: input.kind,
    requestID: input.requestID,
    scopeKey: input.scopeKey,
  })
  const current = await readRequestIfExists(input.kind, routeKey)
  if (!current) {
    return undefined
  }
  if (current.status !== "open") {
    return undefined
  }
  if (normalizeRequestIdentity(current.requestID) !== normalizeRequestIdentity(input.requestID)) {
    return undefined
  }
  if (current.wechatAccountId !== input.wechatAccountId || current.userId !== input.userId) {
    return undefined
  }
  return current
}

export async function findRequestByRouteKey(input: {
  kind: WechatRequestKind
  routeKey: string
}): Promise<RequestRecord | undefined> {
  if (!isRequestKind((input as { kind: unknown }).kind) || !isNonEmptyString((input as { routeKey: unknown }).routeKey)) {
    throw new Error("invalid request record format")
  }

  assertValidRouteKey(input.routeKey)
  return readRequestIfExists(input.kind, input.routeKey)
}
