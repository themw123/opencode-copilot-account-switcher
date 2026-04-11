import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { WECHAT_FILE_MODE, ensureWechatStateLayout, tokenStatePath } from "./state-paths.js"

export type TokenSource = "question" | "permission" | "message"

export const NOTIFICATION_DELIVERY_FAILED_STALE_REASON = "notification-delivery-failed"
const SYNTHETIC_STALE_TOKEN_SOURCE_REF_PREFIX = "synthetic-stale"

export type TokenState = {
  contextToken: string
  updatedAt: number
  source: TokenSource
  sourceRef?: string
  staleReason?: string
}

type TokenKey = {
  wechatAccountId: string
  userId: string
}

function isSafeTokenKeyPart(value: unknown): value is string {
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  return !trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.includes("..")
}

function toTokenKey(input: TokenKey): TokenKey {
  if (!isSafeTokenKeyPart(input.wechatAccountId) || !isSafeTokenKeyPart(input.userId)) {
    throw new Error("invalid token state format")
  }
  return {
    wechatAccountId: input.wechatAccountId,
    userId: input.userId,
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function normalizeTokenState(input: TokenState): TokenState {
  return {
    contextToken: input.contextToken,
    updatedAt: input.updatedAt,
    source: input.source,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.staleReason ? { staleReason: input.staleReason } : {}),
  }
}

function isTokenSource(value: unknown): value is TokenSource {
  return value === "question" || value === "permission" || value === "message"
}

function createSyntheticStaleTokenState(input: TokenKey & { staleReason: string }): TokenState {
  return {
    contextToken: `stale-placeholder:${input.wechatAccountId}:${input.userId}`,
    updatedAt: Date.now(),
    source: "question",
    sourceRef: `${SYNTHETIC_STALE_TOKEN_SOURCE_REF_PREFIX}:${input.staleReason}`,
    staleReason: input.staleReason,
  }
}

function toTokenState(input: unknown): TokenState {
  const parsed = input as Partial<TokenState>
  if (
    !parsed ||
    !isNonEmptyString(parsed.contextToken) ||
    !isFiniteNumber(parsed.updatedAt) ||
    !isTokenSource(parsed.source)
  ) {
    throw new Error("invalid token state format")
  }

  if (
    (parsed.sourceRef !== undefined && !isNonEmptyString(parsed.sourceRef)) ||
    (parsed.staleReason !== undefined && !isNonEmptyString(parsed.staleReason))
  ) {
    throw new Error("invalid token state format")
  }

  return normalizeTokenState(parsed as TokenState)
}

async function writeTokenState(key: TokenKey, state: TokenState) {
  const safeKey = toTokenKey(key)
  await ensureWechatStateLayout()
  const filePath = tokenStatePath(safeKey.wechatAccountId, safeKey.userId)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(normalizeTokenState(state), null, 2), { mode: WECHAT_FILE_MODE })
  return normalizeTokenState(state)
}

export async function readTokenState(wechatAccountId: string, userId: string): Promise<TokenState | undefined> {
  try {
    const safeKey = toTokenKey({ wechatAccountId, userId })
    const raw = await readFile(tokenStatePath(safeKey.wechatAccountId, safeKey.userId), "utf8")
    return toTokenState(JSON.parse(raw))
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return undefined
    if (error instanceof Error && error.message === "invalid token state format") throw error
    throw new Error("invalid token state format")
  }
}

export function isLiveTokenState(state: TokenState | undefined): state is TokenState {
  return Boolean(state && !state.staleReason)
}

export async function upsertInboundToken(input: TokenKey & TokenState): Promise<TokenState> {
  const safeKey = toTokenKey(input)
  const next = toTokenState({
    contextToken: input.contextToken,
    updatedAt: input.updatedAt,
    source: input.source,
    sourceRef: input.sourceRef,
    staleReason: input.staleReason,
  })

  return writeTokenState(safeKey, next)
}

export async function markTokenStale(input: TokenKey & { staleReason: string }): Promise<TokenState> {
  const safeKey = toTokenKey(input)
  if (!isNonEmptyString(input.staleReason)) {
    throw new Error("invalid token state format")
  }

  let current: TokenState | undefined
  try {
    current = await readTokenState(safeKey.wechatAccountId, safeKey.userId)
  } catch (error) {
    if (error instanceof Error && error.message === "invalid token state format") {
      current = undefined
    } else {
      throw error
    }
  }

  return writeTokenState(safeKey, {
    ...(current ?? createSyntheticStaleTokenState({
      ...safeKey,
      staleReason: input.staleReason,
    })),
    staleReason: input.staleReason,
  })
}
