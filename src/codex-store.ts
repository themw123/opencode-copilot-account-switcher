import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { xdgConfig } from "xdg-basedir"

const filename = "codex-store.json"

type CodexUsageWindow = {
  entitlement?: number
  remaining?: number
  used?: number
  resetAt?: number
}

export type CodexAccountSnapshot = {
  plan?: string
  usage5h?: CodexUsageWindow
  usageWeek?: CodexUsageWindow
  updatedAt?: number
  error?: string
}

export type CodexAccountEntry = {
  name?: string
  providerId?: string
  refresh?: string
  access?: string
  expires?: number
  accountId?: string
  email?: string
  addedAt?: number
  lastUsed?: number
  source?: string
  snapshot?: CodexAccountSnapshot
}

export type CodexStoreFile = {
  accounts: Record<string, CodexAccountEntry>
  active?: string
  activeAccountNames?: string[]
  autoRefresh?: boolean
  refreshMinutes?: number
  lastSnapshotRefresh?: number
  bootstrapAuthImportTried?: boolean
  bootstrapAuthImportAt?: number
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function pickString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function pickNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function pickBoolean(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined
}

function pickUsageWindow(input: unknown): CodexUsageWindow | undefined {
  const source = asRecord(input)
  if (!source) return undefined
  const next: CodexUsageWindow = {}
  if (pickNumber(source.entitlement) !== undefined) next.entitlement = pickNumber(source.entitlement)
  if (pickNumber(source.remaining) !== undefined) next.remaining = pickNumber(source.remaining)
  if (pickNumber(source.used) !== undefined) next.used = pickNumber(source.used)
  if (pickNumber(source.resetAt) !== undefined) next.resetAt = pickNumber(source.resetAt)
  return Object.keys(next).length > 0 ? next : undefined
}

function pickSnapshot(input: unknown): CodexAccountSnapshot | undefined {
  const source = asRecord(input)
  if (!source) return undefined
  const next: CodexAccountSnapshot = {}
  if (pickString(source.plan)) next.plan = pickString(source.plan)
  const usage5h = pickUsageWindow(source.usage5h)
  if (usage5h) next.usage5h = usage5h
  const usageWeek = pickUsageWindow(source.usageWeek)
  if (usageWeek) next.usageWeek = usageWeek
  if (pickNumber(source.updatedAt) !== undefined) next.updatedAt = pickNumber(source.updatedAt)
  if (pickString(source.error)) next.error = pickString(source.error)
  return Object.keys(next).length > 0 ? next : undefined
}

function pickEntry(input: unknown): CodexAccountEntry | undefined {
  const source = asRecord(input)
  if (!source) return undefined
  const next: CodexAccountEntry = {}
  if (pickString(source.name)) next.name = pickString(source.name)
  if (pickString(source.providerId)) next.providerId = pickString(source.providerId)
  if (pickString(source.refresh)) next.refresh = pickString(source.refresh)
  if (pickString(source.access)) next.access = pickString(source.access)
  if (pickNumber(source.expires) !== undefined) next.expires = pickNumber(source.expires)
  if (pickString(source.accountId)) next.accountId = pickString(source.accountId)
  if (pickString(source.email)) next.email = pickString(source.email)
  if (pickNumber(source.addedAt) !== undefined) next.addedAt = pickNumber(source.addedAt)
  if (pickNumber(source.lastUsed) !== undefined) next.lastUsed = pickNumber(source.lastUsed)
  if (pickString(source.source)) next.source = pickString(source.source)
  const snapshot = pickSnapshot(source.snapshot)
  if (snapshot) next.snapshot = snapshot
  return next
}

function pickActiveAccountNames(input: unknown, accounts: Record<string, CodexAccountEntry>): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const next: string[] = []
  for (const item of input) {
    const name = pickString(item)
    if (!name || seen.has(name) || !accounts[name]) continue
    seen.add(name)
    next.push(name)
  }
  return next.length > 0 ? next : undefined
}

function normalizeNewStore(source: Record<string, unknown>): CodexStoreFile {
  const accounts: Record<string, CodexAccountEntry> = {}
  const sourceAccounts = asRecord(source.accounts)
  if (sourceAccounts) {
    for (const [name, value] of Object.entries(sourceAccounts)) {
      const entry = pickEntry(value)
      if (!entry) continue
      accounts[name] = {
        ...entry,
        ...(entry.name ? {} : { name }),
      }
    }
  }

  const store: CodexStoreFile = { accounts }
  const active = pickString(source.active)
  if (active && accounts[active]) store.active = active
  const activeNames = pickActiveAccountNames(source.activeAccountNames, accounts)
  if (activeNames) store.activeAccountNames = activeNames
  if (pickBoolean(source.autoRefresh) !== undefined) store.autoRefresh = pickBoolean(source.autoRefresh)
  if (pickNumber(source.refreshMinutes) !== undefined) store.refreshMinutes = pickNumber(source.refreshMinutes)
  if (pickNumber(source.lastSnapshotRefresh) !== undefined) store.lastSnapshotRefresh = pickNumber(source.lastSnapshotRefresh)
  if (pickBoolean(source.bootstrapAuthImportTried) !== undefined) {
    store.bootstrapAuthImportTried = pickBoolean(source.bootstrapAuthImportTried)
  }
  if (pickNumber(source.bootstrapAuthImportAt) !== undefined) {
    store.bootstrapAuthImportAt = pickNumber(source.bootstrapAuthImportAt)
  }
  return store
}

function normalizeLegacyStore(source: Record<string, unknown>): CodexStoreFile {
  const legacyAccount = asRecord(source.account)
  const legacyStatus = asRecord(source.status)
  const legacyPremium = asRecord(legacyStatus?.premium)
  const accountId = pickString(source.activeAccountId) ?? pickString(legacyAccount?.id)
  const email = pickString(source.activeEmail) ?? pickString(legacyAccount?.email)
  const plan = pickString(legacyAccount?.plan)
  const entitlement = pickNumber(legacyPremium?.entitlement)
  const remaining = pickNumber(legacyPremium?.remaining)
  const updatedAt = pickNumber(source.lastStatusRefresh)

  const hasLegacy = Boolean(
    accountId
    || email
    || plan
    || entitlement !== undefined
    || remaining !== undefined,
  )

  const store: CodexStoreFile = {
    accounts: {},
  }
  if (pickBoolean(source.bootstrapAuthImportTried) !== undefined) {
    store.bootstrapAuthImportTried = pickBoolean(source.bootstrapAuthImportTried)
  }
  if (pickNumber(source.bootstrapAuthImportAt) !== undefined) {
    store.bootstrapAuthImportAt = pickNumber(source.bootstrapAuthImportAt)
  }
  if (updatedAt !== undefined) store.lastSnapshotRefresh = updatedAt
  if (!hasLegacy) return store

  const name = accountId ?? email ?? "default"
  const snapshot: CodexAccountSnapshot = {}
  if (plan) snapshot.plan = plan
  if (entitlement !== undefined || remaining !== undefined) {
    snapshot.usage5h = {
      ...(entitlement !== undefined ? { entitlement } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
    }
  }
  if (updatedAt !== undefined) snapshot.updatedAt = updatedAt

  store.accounts[name] = {
    name,
    providerId: "codex",
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(Object.keys(snapshot).length > 0 ? { snapshot } : {}),
  }
  store.active = name
  return store
}

function mergeLegacyIntoStore(store: CodexStoreFile, source: Record<string, unknown>): CodexStoreFile {
  const legacy = normalizeLegacyStore(source)
  if (Object.keys(legacy.accounts).length === 0) {
    return {
      ...store,
      lastSnapshotRefresh: store.lastSnapshotRefresh ?? legacy.lastSnapshotRefresh,
      ...(legacy.bootstrapAuthImportTried !== undefined ? { bootstrapAuthImportTried: legacy.bootstrapAuthImportTried } : {}),
      ...(legacy.bootstrapAuthImportAt !== undefined ? { bootstrapAuthImportAt: legacy.bootstrapAuthImportAt } : {}),
    }
  }

  if (Object.keys(store.accounts).length > 0) {
    return {
      ...store,
      lastSnapshotRefresh: store.lastSnapshotRefresh ?? legacy.lastSnapshotRefresh,
      bootstrapAuthImportTried: store.bootstrapAuthImportTried ?? legacy.bootstrapAuthImportTried,
      bootstrapAuthImportAt: store.bootstrapAuthImportAt ?? legacy.bootstrapAuthImportAt,
    }
  }

  return {
    ...legacy,
    ...store,
    accounts: {
      ...legacy.accounts,
      ...store.accounts,
    },
    active: store.active ?? legacy.active,
    activeAccountNames: store.activeAccountNames ?? legacy.activeAccountNames,
    autoRefresh: store.autoRefresh ?? legacy.autoRefresh,
    refreshMinutes: store.refreshMinutes ?? legacy.refreshMinutes,
    lastSnapshotRefresh: store.lastSnapshotRefresh ?? legacy.lastSnapshotRefresh,
    bootstrapAuthImportTried: store.bootstrapAuthImportTried ?? legacy.bootstrapAuthImportTried,
    bootstrapAuthImportAt: store.bootstrapAuthImportAt ?? legacy.bootstrapAuthImportAt,
  }
}

export function normalizeCodexStore(input: unknown): CodexStoreFile {
  const source = asRecord(input)
  if (!source) return { accounts: {} }
  if (source.accounts && asRecord(source.accounts)) {
    return mergeLegacyIntoStore(normalizeNewStore(source), source)
  }
  return normalizeLegacyStore(source)
}

export function parseCodexStore(raw: string): CodexStoreFile {
  const parsed = raw ? JSON.parse(raw) : {}
  return normalizeCodexStore(parsed)
}

export function getActiveCodexAccount(store: CodexStoreFile): { name: string; entry: CodexAccountEntry } | undefined {
  if (store.active && store.accounts[store.active]) {
    return {
      name: store.active,
      entry: store.accounts[store.active],
    }
  }
  const first = Object.entries(store.accounts)[0]
  if (!first) return undefined
  return {
    name: first[0],
    entry: first[1],
  }
}

export function codexStorePath(): string {
  const base = xdgConfig ?? path.join(os.homedir(), ".config")
  return path.join(base, "opencode", filename)
}

export async function readCodexStore(filePath = codexStorePath()): Promise<CodexStoreFile> {
  const raw = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  return parseCodexStore(raw)
}

export async function writeCodexStore(
  store: CodexStoreFile,
  options?: {
    filePath?: string
  },
) {
  const file = options?.filePath ?? codexStorePath()
  const next = normalizeCodexStore(store)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 })
}
