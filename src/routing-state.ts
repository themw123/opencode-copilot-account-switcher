import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { xdgData } from "xdg-basedir"

const SESSION_WINDOW_MS = 30 * 60 * 1000
const TOUCH_THROTTLE_MS = 60 * 1000

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
}

export function routingStatePath(): string {
  const dataDir = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(dataDir, "opencode", "copilot-routing-state")
}

export async function appendRoutingEvent(input: {
  directory: string
  event: RoutingEvent
}) {
  await fs.mkdir(input.directory, { recursive: true })
  await fs.appendFile(path.join(input.directory, "active.log"), `${JSON.stringify(input.event)}\n`, "utf8")
}

export async function appendSessionTouchEvent(input: AppendSessionTouchEventInput) {
  const key = `${input.accountName}:${input.sessionID}`
  const lastWrite = input.lastTouchWrites.get(key)
  if (typeof lastWrite === "number" && input.at - lastWrite < TOUCH_THROTTLE_MS) {
    return false
  }

  await appendRoutingEvent({
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
    raw = await fs.readFile(filePath, "utf8")
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
    raw = await fs.readFile(filePath, "utf8")
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
    entries = await fs.readdir(directory)
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
