import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { xdgConfig } from "xdg-basedir"

const filename = "codex-store.json"

export type CodexAccountSnapshot = {
  id?: string
  email?: string
  plan?: string
}

export type CodexStatusSnapshot = {
  premium?: {
    entitlement?: number
    remaining?: number
  }
}

export type CodexStoreFile = {
  activeProvider?: string
  activeAccountId?: string
  activeEmail?: string
  lastStatusRefresh?: number
  account?: CodexAccountSnapshot
  status?: CodexStatusSnapshot
}

function pickCodexStore(input: unknown): CodexStoreFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const source = input as Record<string, unknown>
  const store: CodexStoreFile = {}

  if (typeof source.activeProvider === "string") store.activeProvider = source.activeProvider
  if (typeof source.activeAccountId === "string") store.activeAccountId = source.activeAccountId
  if (typeof source.activeEmail === "string") store.activeEmail = source.activeEmail
  if (typeof source.lastStatusRefresh === "number" && !Number.isNaN(source.lastStatusRefresh)) {
    store.lastStatusRefresh = source.lastStatusRefresh
  }

  if (source.account && typeof source.account === "object" && !Array.isArray(source.account)) {
    const account = source.account as Record<string, unknown>
    const next: CodexAccountSnapshot = {}
    if (typeof account.id === "string") next.id = account.id
    if (typeof account.email === "string") next.email = account.email
    if (typeof account.plan === "string") next.plan = account.plan
    if (Object.keys(next).length > 0) store.account = next
  }

  if (source.status && typeof source.status === "object" && !Array.isArray(source.status)) {
    const status = source.status as Record<string, unknown>
    if (status.premium && typeof status.premium === "object" && !Array.isArray(status.premium)) {
      const premium = status.premium as Record<string, unknown>
      const nextPremium: CodexStatusSnapshot["premium"] = {}
      if (typeof premium.entitlement === "number" && !Number.isNaN(premium.entitlement)) {
        nextPremium.entitlement = premium.entitlement
      }
      if (typeof premium.remaining === "number" && !Number.isNaN(premium.remaining)) {
        nextPremium.remaining = premium.remaining
      }
      if (Object.keys(nextPremium).length > 0) store.status = { premium: nextPremium }
    }
  }

  return store
}

export function parseCodexStore(raw: string): CodexStoreFile {
  const parsed = raw ? JSON.parse(raw) : {}
  return pickCodexStore(parsed)
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
  const next = pickCodexStore(store)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 })
}
