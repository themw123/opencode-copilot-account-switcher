import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { xdgData } from "xdg-basedir"

const SESSION_WINDOW_MS = 30 * 60 * 1000
const TOUCH_THROTTLE_MS = 60 * 1000
const APPEND_MAX_RETRIES = 3
const ROTATE_MAX_RETRIES = 3

type OpenFileHandle = {
  appendFile(data: string, options?: BufferEncoding): Promise<void>
  close(): Promise<void>
}

type RoutingStateIO = {
  mkdir: typeof fs.mkdir
  appendFile: typeof fs.appendFile
  readFile: typeof fs.readFile
  readdir: typeof fs.readdir
  rename: typeof fs.rename
  writeFile: typeof fs.writeFile
  unlink: typeof fs.unlink
  open: (path: string, flags: string) => Promise<OpenFileHandle>
}

const defaultRoutingStateIO: RoutingStateIO = {
  mkdir: fs.mkdir.bind(fs),
  appendFile: fs.appendFile.bind(fs),
  readFile: fs.readFile.bind(fs),
  readdir: fs.readdir.bind(fs),
  rename: fs.rename.bind(fs),
  writeFile: fs.writeFile.bind(fs),
  unlink: fs.unlink.bind(fs),
  open: fs.open.bind(fs) as unknown as RoutingStateIO["open"],
}

type AppendRoutingEventInput = {
  directory: string
  event: RoutingEvent
  maxRetries?: number
  retryDelayMs?: number
  io?: RoutingStateIO
}

export type RotateActiveLogInput = {
  directory: string
  now?: number
  pid?: number
  maxRetries?: number
  retryDelayMs?: number
  io?: RoutingStateIO
  beforeCreateActiveLog?: () => Promise<void>
}

export type RotateActiveLogResult = {
  rotated: boolean
  skipped: boolean
  segmentName?: string
}

type CompactRoutingStateInput = {
  directory: string
  now: number
  io?: RoutingStateIO
}

export type RoutingAccountState = {
  sessions?: Record<string, number>
  lastRateLimitedAt?: number
}

export type RoutingSnapshot = {
  accounts: Record<string, RoutingAccountState>
  appliedSegments?: string[]
}

export type SessionTouchEvent = {
  type: "session-touch"
  accountName: string
  sessionID: string
  at: number
}

export type RateLimitFlaggedEvent = {
  type: "rate-limit-flagged"
  accountName: string
  at: number
  retryAfterMs?: number
}

export type RoutingEvent = SessionTouchEvent | RateLimitFlaggedEvent

export type AppendSessionTouchEventInput = {
  directory: string
  accountName: string
  sessionID: string
  at: number
  lastTouchWrites: Map<string, number>
  appendEvent?: (input: {
    directory: string
    event: RoutingEvent
  }) => Promise<void>
}

export function routingStatePath(): string {
  const dataDir = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(dataDir, "opencode", "copilot-routing-state")
}

function isRetryableAppendError(error: unknown): boolean {
  const issue = error as NodeJS.ErrnoException
  return issue?.code === "ENOENT" || issue?.code === "EBUSY" || issue?.code === "EACCES" || issue?.code === "EPERM" || issue?.code === "EIO"
}

function isRetryableRenameError(error: unknown): boolean {
  const issue = error as NodeJS.ErrnoException
  return issue?.code === "EBUSY" || issue?.code === "EACCES" || issue?.code === "EPERM"
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureActiveLogExists(filePath: string, io: RoutingStateIO): Promise<void> {
  const handle = await io.open(filePath, "a")
  await handle.close()
}

export async function appendRoutingEvent(input: AppendRoutingEventInput) {
  const io = input.io ?? defaultRoutingStateIO
  await io.mkdir(input.directory, { recursive: true })

  const activeFile = path.join(input.directory, "active.log")
  const line = `${JSON.stringify(input.event)}\n`
  const maxRetries = Math.max(1, input.maxRetries ?? APPEND_MAX_RETRIES)
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? 5)

  let lastError: unknown = undefined
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let handle: OpenFileHandle | undefined
    try {
      handle = await io.open(activeFile, "a")
      await handle.appendFile(line, "utf8")
      await handle.close()
      return
    } catch (error) {
      lastError = error
      if (handle) {
        try {
          await handle.close()
        } catch {
          // ignore close errors after append failure
        }
      }

      if (attempt === maxRetries - 1 || !isRetryableAppendError(error)) {
        throw error
      }

      await io.mkdir(input.directory, { recursive: true })
      await delay(retryDelayMs)
    }
  }

  if (lastError) throw lastError
}

export async function appendSessionTouchEvent(input: AppendSessionTouchEventInput) {
  const key = `${input.accountName}:${input.sessionID}`
  const lastWrite = input.lastTouchWrites.get(key)
  if (typeof lastWrite === "number" && input.at - lastWrite < TOUCH_THROTTLE_MS) {
    return false
  }

  const appendEvent = input.appendEvent ?? appendRoutingEvent
  await appendEvent({
    directory: input.directory,
    event: {
      type: "session-touch",
      accountName: input.accountName,
      sessionID: input.sessionID,
      at: input.at,
    },
  })
  input.lastTouchWrites.set(key, input.at)
  return true
}

export function buildCandidateAccountLoads(input: {
  snapshot: RoutingSnapshot
  candidateAccountNames: string[]
  now: number
}) {
  const loads = new Map<string, number>()
  const cutoff = input.now - SESSION_WINDOW_MS

  for (const accountName of input.candidateAccountNames) {
    const sessions = input.snapshot.accounts[accountName]?.sessions
    if (!sessions) {
      loads.set(accountName, 0)
      continue
    }

    let count = 0
    for (const at of Object.values(sessions)) {
      if (typeof at === "number" && Number.isFinite(at) && at >= cutoff) {
        count += 1
      }
    }
    loads.set(accountName, count)
  }

  return loads
}

export function getAccountLastRateLimitedAt(snapshot: RoutingSnapshot, accountName: string): number | undefined {
  const value = snapshot.accounts[accountName]?.lastRateLimitedAt
  if (typeof value !== "number" || Number.isFinite(value) === false) return undefined
  return value
}

export function isAccountRateLimitCooledDown(input: {
  snapshot: RoutingSnapshot
  accountName: string
  now: number
  cooldownMs: number
}) {
  const lastRateLimitedAt = getAccountLastRateLimitedAt(input.snapshot, input.accountName)
  if (lastRateLimitedAt === undefined) return true
  return input.now - lastRateLimitedAt >= input.cooldownMs
}

function cloneSnapshot(input: RoutingSnapshot): RoutingSnapshot {
  const accounts: Record<string, RoutingAccountState> = {}
  for (const [accountName, account] of Object.entries(input.accounts ?? {})) {
    const cloned: RoutingAccountState = {}
    if (account.sessions && typeof account.sessions === "object") {
      cloned.sessions = { ...account.sessions }
    }
    if (typeof account.lastRateLimitedAt === "number" && Number.isFinite(account.lastRateLimitedAt)) {
      cloned.lastRateLimitedAt = account.lastRateLimitedAt
    }
    accounts[accountName] = cloned
  }

  return {
    accounts,
    appliedSegments: Array.isArray(input.appliedSegments) ? [...input.appliedSegments] : [],
  }
}

function normalizeSnapshot(raw: unknown): RoutingSnapshot {
  if (!raw || typeof raw !== "object") {
    return { accounts: {}, appliedSegments: [] }
  }

  const parsed = raw as {
    accounts?: unknown
    appliedSegments?: unknown
  }

  const accounts: Record<string, RoutingAccountState> = {}
  if (parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) {
    for (const [accountName, accountValue] of Object.entries(parsed.accounts)) {
      if (!accountValue || typeof accountValue !== "object" || Array.isArray(accountValue)) continue
      const account = accountValue as { sessions?: unknown; lastRateLimitedAt?: unknown }
      const next: RoutingAccountState = {}

      if (account.sessions && typeof account.sessions === "object" && !Array.isArray(account.sessions)) {
        const sessions: Record<string, number> = {}
        for (const [sessionID, at] of Object.entries(account.sessions)) {
          if (typeof at !== "number" || !Number.isFinite(at)) continue
          sessions[sessionID] = at
        }
        if (Object.keys(sessions).length > 0) next.sessions = sessions
      }

      if (typeof account.lastRateLimitedAt === "number" && Number.isFinite(account.lastRateLimitedAt)) {
        next.lastRateLimitedAt = account.lastRateLimitedAt
      }

      accounts[accountName] = next
    }
  }

  const appliedSegments = Array.isArray(parsed.appliedSegments)
    ? parsed.appliedSegments.filter((name): name is string => typeof name === "string" && name.length > 0)
    : []

  return {
    accounts,
    appliedSegments,
  }
}

function emptySnapshot(): RoutingSnapshot {
  return { accounts: {}, appliedSegments: [] }
}

async function readSnapshot(filePath: string): Promise<RoutingSnapshot> {
  let raw = ""
  try {
    raw = await defaultRoutingStateIO.readFile(filePath, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return emptySnapshot()
    throw error
  }

  try {
    return normalizeSnapshot(JSON.parse(raw))
  } catch {
    return emptySnapshot()
  }
}

function parseRoutingEvent(value: unknown): RoutingEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const event = value as Record<string, unknown>
  const type = event.type
  const accountName = event.accountName
  const at = event.at

  if (typeof type !== "string" || typeof accountName !== "string" || typeof at !== "number" || !Number.isFinite(at)) {
    return undefined
  }

  if (type === "session-touch") {
    if (typeof event.sessionID !== "string" || event.sessionID.length === 0) return undefined
    return {
      type,
      accountName,
      sessionID: event.sessionID,
      at,
    }
  }

  if (type === "rate-limit-flagged") {
    return {
      type,
      accountName,
      at,
      retryAfterMs: typeof event.retryAfterMs === "number" && Number.isFinite(event.retryAfterMs)
        ? event.retryAfterMs
        : undefined,
    }
  }

  return undefined
}

async function readEventsFromLog(filePath: string): Promise<RoutingEvent[]> {
  let raw = ""
  try {
    raw = await defaultRoutingStateIO.readFile(filePath, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return []
    throw error
  }

  const events: RoutingEvent[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      const event = parseRoutingEvent(parsed)
      if (event) events.push(event)
    } catch {
      continue
    }
  }
  return events
}

export function foldRoutingEvents(base: RoutingSnapshot, events: RoutingEvent[]): RoutingSnapshot {
  const next = cloneSnapshot(base)

  for (const event of events) {
    if (event.type === "session-touch") {
      next.accounts[event.accountName] ??= {}
      next.accounts[event.accountName].sessions ??= {}

      const current = next.accounts[event.accountName].sessions?.[event.sessionID] ?? 0
      next.accounts[event.accountName].sessions![event.sessionID] = Math.max(current, event.at)
      continue
    }

    next.accounts[event.accountName] ??= {}
    const current = next.accounts[event.accountName].lastRateLimitedAt ?? 0
    next.accounts[event.accountName].lastRateLimitedAt = Math.max(current, event.at)
  }

  return next
}

export function compactRoutingSnapshot(snapshot: RoutingSnapshot, now: number): RoutingSnapshot {
  const next = cloneSnapshot(snapshot)
  const cutoff = now - SESSION_WINDOW_MS

  for (const [accountName, account] of Object.entries(next.accounts)) {
    if (account.sessions) {
      for (const [sessionID, at] of Object.entries(account.sessions)) {
        if (at < cutoff) delete account.sessions[sessionID]
      }
      if (Object.keys(account.sessions).length === 0) delete account.sessions
    }

    if (!account.sessions && account.lastRateLimitedAt === undefined) {
      delete next.accounts[accountName]
    }
  }

  return next
}

export async function readRoutingState(directory: string): Promise<RoutingSnapshot> {
  const snapshotFile = path.join(directory, "snapshot.json")
  const activeFile = path.join(directory, "active.log")

  const snapshot = await readSnapshot(snapshotFile)
  const applied = new Set(snapshot.appliedSegments ?? [])
  const activeEventsPromise = readEventsFromLog(activeFile)

  let entries: string[] = []
  try {
    entries = await defaultRoutingStateIO.readdir(directory)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") {
      entries = []
    } else {
      throw error
    }
  }

  const sealedSegments = entries
    .filter((name) => /^sealed-.*\.log$/.test(name))
    .filter((name) => !applied.has(name))
    .sort((a, b) => a.localeCompare(b))

  const sealedEvents = await Promise.all(
    sealedSegments.map((segment) => readEventsFromLog(path.join(directory, segment))),
  )

  let state = cloneSnapshot(snapshot)
  for (const segmentEvents of sealedEvents) {
    state = foldRoutingEvents(state, segmentEvents)
  }

  const activeEvents = await activeEventsPromise
  state = foldRoutingEvents(state, activeEvents)
  state.appliedSegments = [...new Set([...(snapshot.appliedSegments ?? []), ...sealedSegments])]
  return state
}

export async function rotateActiveLog(input: RotateActiveLogInput): Promise<RotateActiveLogResult> {
  const io = input.io ?? defaultRoutingStateIO
  const now = input.now ?? Date.now()
  const pid = input.pid ?? process.pid
  const maxRetries = Math.max(1, input.maxRetries ?? ROTATE_MAX_RETRIES)
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? 5)
  const activeFile = path.join(input.directory, "active.log")
  const segmentName = `sealed-${now}-${pid}.log`
  const sealedFile = path.join(input.directory, segmentName)

  await io.mkdir(input.directory, { recursive: true })

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      await io.rename(activeFile, sealedFile)
      if (input.beforeCreateActiveLog) {
        await input.beforeCreateActiveLog()
      }
      await ensureActiveLogExists(activeFile, io)
      return { rotated: true, skipped: false, segmentName }
    } catch (error) {
      const issue = error as NodeJS.ErrnoException
      if (issue.code === "ENOENT") {
        await ensureActiveLogExists(activeFile, io)
        return { rotated: false, skipped: true }
      }

      if (attempt === maxRetries - 1 || !isRetryableRenameError(error)) {
        if (isRetryableRenameError(error)) {
          return { rotated: false, skipped: true }
        }
        throw error
      }

      await delay(retryDelayMs)
    }
  }

  return { rotated: false, skipped: true }
}

async function readSnapshotWithIO(filePath: string, io: RoutingStateIO): Promise<RoutingSnapshot> {
  let raw = ""
  try {
    raw = await io.readFile(filePath, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return emptySnapshot()
    throw error
  }

  try {
    return normalizeSnapshot(JSON.parse(raw))
  } catch {
    return emptySnapshot()
  }
}

async function readEventsFromLogWithIO(filePath: string, io: RoutingStateIO): Promise<RoutingEvent[]> {
  let raw = ""
  try {
    raw = await io.readFile(filePath, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return []
    throw error
  }

  const events: RoutingEvent[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      const event = parseRoutingEvent(parsed)
      if (event) events.push(event)
    } catch {
      continue
    }
  }
  return events
}

async function readRoutingStateWithIO(directory: string, io: RoutingStateIO): Promise<RoutingSnapshot> {
  const snapshotFile = path.join(directory, "snapshot.json")
  const activeFile = path.join(directory, "active.log")

  const snapshot = await readSnapshotWithIO(snapshotFile, io)
  const applied = new Set(snapshot.appliedSegments ?? [])
  const activeEventsPromise = readEventsFromLogWithIO(activeFile, io)

  let entries: string[] = []
  try {
    entries = await io.readdir(directory)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") {
      entries = []
    } else {
      throw error
    }
  }

  const sealedSegments = entries
    .filter((name) => /^sealed-.*\.log$/.test(name))
    .filter((name) => !applied.has(name))
    .sort((a, b) => a.localeCompare(b))

  const sealedEvents = await Promise.all(
    sealedSegments.map((segment) => readEventsFromLogWithIO(path.join(directory, segment), io)),
  )

  let state = cloneSnapshot(snapshot)
  for (const segmentEvents of sealedEvents) {
    state = foldRoutingEvents(state, segmentEvents)
  }

  const activeEvents = await activeEventsPromise
  state = foldRoutingEvents(state, activeEvents)
  state.appliedSegments = [...new Set([...(snapshot.appliedSegments ?? []), ...sealedSegments])]
  return state
}

export async function compactRoutingState(input: CompactRoutingStateInput): Promise<RoutingSnapshot> {
  const io = input.io ?? defaultRoutingStateIO
  const snapshotFile = path.join(input.directory, "snapshot.json")
  const snapshotTmpFile = path.join(input.directory, "snapshot.tmp")

  await io.mkdir(input.directory, { recursive: true })
  try {
    await io.unlink(snapshotTmpFile)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") throw error
  }

  const merged = await readRoutingStateWithIO(input.directory, io)
  const compacted = compactRoutingSnapshot(merged, input.now)
  const sealedToDelete = [...(merged.appliedSegments ?? [])]

  await io.writeFile(snapshotTmpFile, JSON.stringify(compacted, null, 2), "utf8")
  await io.rename(snapshotTmpFile, snapshotFile)

  for (const segmentName of sealedToDelete) {
    try {
      await io.unlink(path.join(input.directory, segmentName))
    } catch (error) {
      const issue = error as NodeJS.ErrnoException
      if (issue.code !== "ENOENT") throw error
    }
  }

  let entries: string[] = []
  try {
    entries = await io.readdir(input.directory)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") throw error
  }

  const remainingSealed = new Set(entries.filter((name) => /^sealed-.*\.log$/.test(name)))
  const finalSnapshot: RoutingSnapshot = {
    ...compacted,
    appliedSegments: (compacted.appliedSegments ?? []).filter((name) => remainingSealed.has(name)),
  }

  await io.writeFile(snapshotTmpFile, JSON.stringify(finalSnapshot, null, 2), "utf8")
  await io.rename(snapshotTmpFile, snapshotFile)

  return finalSnapshot
}
