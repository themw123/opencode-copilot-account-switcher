import path from "node:path"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import {
  WECHAT_FILE_MODE,
  ensureWechatStateLayout,
  requestKindDir,
  requestStatePath,
  type WechatRequestKind,
} from "./state-paths.js"
import { assertValidHandleInput, createHandle, createRouteKey, normalizeHandle } from "./handle.js"
import { normalizeRequestPromptSummary, type RequestPromptSummary } from "./question-interaction.js"

export type RequestStatus = "open" | "answered" | "rejected" | "expired" | "cleaned"

export type RequestRecord = {
  kind: WechatRequestKind
  requestID: string
  routeKey: string
  handle: string
  scopeKey?: string
  prompt?: RequestPromptSummary
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
    ...(input.prompt !== undefined ? { prompt: normalizeRequestPromptSummary(input.kind, input.prompt) } : {}),
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

  if (parsed.prompt !== undefined) {
    normalizeRequestPromptSummary(parsed.kind, parsed.prompt)
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

function createRecoveryRouteKey(input: {
  kind: WechatRequestKind
  requestID: string
  scopeKey?: string
  recoveredAt: number
  attempt: number
}): string {
  return createRouteKey({
    kind: input.kind,
    requestID: `${input.requestID}-recover-${input.recoveredAt}-${input.attempt}`,
    scopeKey: input.scopeKey,
  })
}

export type PreparedRecoveryRequestReopen = {
  originalRequest: RequestRecord
  nextHandle: string
  nextRouteKey: string
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export async function allocateFreshRecoveryHandle(input: {
  kind: WechatRequestKind
  bannedHandles?: string[]
}): Promise<string> {
  if (!isRequestKind((input as { kind: unknown }).kind)) {
    throw new Error("invalid request record format")
  }

  if (
    (input as { bannedHandles?: unknown }).bannedHandles !== undefined
    && !Array.isArray((input as { bannedHandles?: unknown }).bannedHandles)
  ) {
    throw new Error("invalid request record format")
  }

  const active = await listActiveRequests()
  const existingOpenHandles = active
    .filter((item) => item.kind === input.kind && item.status === "open")
    .map((item) => item.handle)
  const bannedHandles = Array.isArray(input.bannedHandles)
    ? input.bannedHandles.filter((item): item is string => isNonEmptyString(item)).map((item) => normalizeHandle(item))
    : []

  return createHandle(input.kind, [...existingOpenHandles, ...bannedHandles])
}

export async function prepareRecoveryRequestReopen(input: {
  kind: WechatRequestKind
  routeKey: string
  recoveredAt: number
  bannedHandles?: string[]
}): Promise<PreparedRecoveryRequestReopen> {
  if (
    !isRequestKind((input as { kind: unknown }).kind) ||
    !isNonEmptyString((input as { routeKey: unknown }).routeKey) ||
    !isFiniteNumber((input as { recoveredAt: unknown }).recoveredAt)
  ) {
    throw new Error("invalid request record format")
  }

  if (
    (input as { bannedHandles?: unknown }).bannedHandles !== undefined
    && !Array.isArray((input as { bannedHandles?: unknown }).bannedHandles)
  ) {
    throw new Error("invalid request record format")
  }

  assertValidRouteKey(input.routeKey)
  const current = await readRequestIfExists(input.kind, input.routeKey)
  if (!current) {
    throw new Error("request missing for recovery")
  }
  if (current.status !== "expired" && current.status !== "cleaned") {
    throw new Error("request is not recoverable from current status")
  }

  const nextHandle = await allocateFreshRecoveryHandle({
    kind: current.kind,
    bannedHandles: [current.handle, ...(input.bannedHandles ?? [])],
  })

  let nextRouteKey: string | undefined
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const candidateRouteKey = createRecoveryRouteKey({
      kind: current.kind,
      requestID: current.requestID,
      scopeKey: current.scopeKey,
      recoveredAt: input.recoveredAt,
      attempt,
    })
    const existing = await readRequestIfExists(current.kind, candidateRouteKey)
    if (!existing) {
      nextRouteKey = candidateRouteKey
      break
    }
  }

  if (!nextRouteKey) {
    throw new Error("failed to allocate recovery routeKey")
  }

  return {
    originalRequest: current,
    nextHandle,
    nextRouteKey,
  }
}

export async function commitPreparedRecoveryRequestReopen(
  prepared: PreparedRecoveryRequestReopen,
): Promise<RequestRecord> {
  const current = await readRequestIfExists(prepared.originalRequest.kind, prepared.originalRequest.routeKey)
  if (!current) {
    throw new Error("request missing for recovery")
  }
  if (current.status !== "expired" && current.status !== "cleaned") {
    throw new Error("request is not recoverable from current status")
  }

  const active = await listActiveRequests()
  if (active.some((item) => (
    item.kind === prepared.originalRequest.kind
    && item.status === "open"
    && item.handle === prepared.nextHandle
  ))) {
    throw new Error("recovery handle is no longer fresh")
  }

  const existingTarget = await readRequestIfExists(prepared.originalRequest.kind, prepared.nextRouteKey)
  if (existingTarget) {
    throw new Error("recovery routeKey is no longer fresh")
  }

  const recovered = await writeRequest({
    ...current,
    routeKey: prepared.nextRouteKey,
    handle: prepared.nextHandle,
    status: "open",
    answeredAt: undefined,
    rejectedAt: undefined,
    expiredAt: undefined,
    cleanedAt: undefined,
  })

  try {
    await rm(requestStatePath(prepared.originalRequest.kind, prepared.originalRequest.routeKey), { force: true })
  } catch (error) {
    try {
      await rm(requestStatePath(prepared.originalRequest.kind, prepared.nextRouteKey), { force: true })
    } catch (cleanupError) {
      throw new Error(
        `failed to cleanup fresh recovery request after original removal failure: ${toErrorMessage(cleanupError)}`,
      )
    }
    throw error
  }

  return recovered
}

export async function rollbackPreparedRecoveryRequestReopen(
  prepared: PreparedRecoveryRequestReopen,
): Promise<void> {
  let cleanupFreshError: Error | undefined
  let restoreOriginalError: Error | undefined

  try {
    await rm(requestStatePath(prepared.originalRequest.kind, prepared.nextRouteKey), { force: true })
  } catch (error) {
    cleanupFreshError = new Error(toErrorMessage(error))
  }

  try {
    const original = await readRequestIfExists(prepared.originalRequest.kind, prepared.originalRequest.routeKey)
    if (!original) {
      await writeRequest(prepared.originalRequest)
    }
  } catch (error) {
    restoreOriginalError = new Error(toErrorMessage(error))
  }

  if (cleanupFreshError && restoreOriginalError) {
    throw new Error(
      `failed to cleanup fresh recovery request: ${cleanupFreshError.message}; failed to restore original recovery request: ${restoreOriginalError.message}`,
    )
  }
  if (cleanupFreshError) {
    throw cleanupFreshError
  }
  if (restoreOriginalError) {
    throw restoreOriginalError
  }
}

export async function recoverRequestFromDeadLetter(input: {
  kind: WechatRequestKind
  routeKey: string
  recoveredAt: number
  excludedHandles?: string[]
}) {
  if (
    !isRequestKind((input as { kind: unknown }).kind) ||
    !isNonEmptyString((input as { routeKey: unknown }).routeKey) ||
    !isFiniteNumber((input as { recoveredAt: unknown }).recoveredAt)
  ) {
    throw new Error("invalid request record format")
  }

  if (
    (input as { excludedHandles?: unknown }).excludedHandles !== undefined
    && !Array.isArray((input as { excludedHandles?: unknown }).excludedHandles)
  ) {
    throw new Error("invalid request record format")
  }

  const prepared = await prepareRecoveryRequestReopen({
    kind: input.kind,
    routeKey: input.routeKey,
    recoveredAt: input.recoveredAt,
    bannedHandles: input.excludedHandles,
  })
  return commitPreparedRecoveryRequestReopen(prepared)
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
  const purged = await purgeCleanedRequestsBefore(input)
  return purged.length
}

export async function purgeCleanedRequestsBefore(input: { cutoffAt: number }) {
  await ensureWechatStateLayout()
  const deleted: RequestRecord[] = []

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
      deleted.push(current)
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

  const all = await listActiveRequests()
  const matches = all.filter((item) => (
    item.kind === input.kind
    && item.status === "open"
    && normalizeRequestIdentity(item.requestID) === normalizeRequestIdentity(input.requestID)
    && item.wechatAccountId === input.wechatAccountId
    && item.userId === input.userId
    && (input.scopeKey === undefined || item.scopeKey === input.scopeKey)
  ))

  if (input.scopeKey === undefined) {
    return matches.length === 1 ? matches[0] : undefined
  }

  return matches[0]
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
