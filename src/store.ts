import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { xdgConfig, xdgData } from "xdg-basedir"

export type AccountEntry = {
  name: string
  refresh: string
  access: string
  expires: number
  enterpriseUrl?: string
  user?: string
  email?: string
  orgs?: string[]
  addedAt?: number
  lastUsed?: number
  source?: "auth" | "manual"
  providerId?: string
  quota?: {
    plan?: string
    sku?: string
    reset?: string
    updatedAt?: number
    error?: string
    snapshots?: {
      premium?: {
        entitlement?: number
        remaining?: number
        used?: number
        unlimited?: boolean
        percentRemaining?: number
      }
      chat?: {
        entitlement?: number
        remaining?: number
        used?: number
        unlimited?: boolean
        percentRemaining?: number
      }
      completions?: {
        entitlement?: number
        remaining?: number
        used?: number
        unlimited?: boolean
        percentRemaining?: number
      }
    }
  }
  models?: {
    available: string[]
    disabled: string[]
    updatedAt?: number
    error?: string
  }
}

export type StoreFile = {
  active?: string
  accounts: Record<string, AccountEntry>
  autoRefresh?: boolean
  refreshMinutes?: number
  lastQuotaRefresh?: number
  loopSafetyEnabled?: boolean
}

const filename = "copilot-accounts.json"
const authFile = "auth.json"

export function storePath(): string {
  const base = xdgConfig ?? path.join(os.homedir(), ".config")
  return path.join(base, "opencode", filename)
}

export function authPath(): string {
  const dataDir = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(dataDir, "opencode", authFile)
}

export function parseStore(raw: string): StoreFile {
  const data = raw ? (JSON.parse(raw) as StoreFile) : ({ accounts: {} } as StoreFile)
  if (!data.accounts) data.accounts = {}
  if (data.loopSafetyEnabled !== true) data.loopSafetyEnabled = false
  for (const [name, entry] of Object.entries(data.accounts)) {
    const info = entry as AccountEntry
    if (!info.name) info.name = name
  }
  return data
}

export async function readStore(filePath = storePath()): Promise<StoreFile> {
  const raw = await fs.readFile(filePath, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  return parseStore(raw)
}

export async function readStoreSafe(filePath = storePath()): Promise<StoreFile | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    return parseStore(raw)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return parseStore("")
    return undefined
  }
}

export async function readAuth(filePath?: string): Promise<Record<string, AccountEntry>> {
  const dataFile = path.join(xdgData ?? path.join(os.homedir(), ".local", "share"), "opencode", authFile)
  const configFile = path.join(xdgConfig ?? path.join(os.homedir(), ".config"), "opencode", authFile)
  const files = filePath ? [filePath] : [dataFile, configFile]
  let raw = ""
  for (const file of files) {
    raw = await fs.readFile(file, "utf-8").catch(() => "")
    if (raw) break
  }
  if (!raw) return {}
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return Object.entries(parsed).reduce((acc, [key, value]) => {
    if (!value || typeof value !== "object") return acc
    const info = value as {
      type?: string
      refresh?: string
      access?: string
      expires?: number
      enterpriseUrl?: string
    }
    if (info.type !== "oauth" || !(info.refresh || info.access)) return acc
    acc[key] = {
      name: `auth:${key}`,
      refresh: info.refresh ?? info.access!,
      access: info.access ?? info.refresh!,
      expires: info.expires ?? 0,
      enterpriseUrl: info.enterpriseUrl,
      source: "auth",
      providerId: key,
    }
    return acc
  }, {} as Record<string, AccountEntry>)
}

export async function writeStore(store: StoreFile) {
  const file = storePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 })
}
