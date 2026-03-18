import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { readFileSync } from "node:fs"
import { xdgConfig, xdgData } from "xdg-basedir"

export type StoreWriteDebugMeta = {
  reason?: string
  source?: string
  actionType?: string
  inputStage?: string
  parsedKey?: string
}

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
  activeAccountNames?: string[]
  accounts: Record<string, AccountEntry>
  modelAccountAssignments?: Record<string, string>
  autoRefresh?: boolean
  refreshMinutes?: number
  lastAccountSwitchAt?: number
  lastQuotaRefresh?: number
  loopSafetyEnabled?: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
  networkRetryEnabled?: boolean
  syntheticAgentInitiatorEnabled?: boolean
  experimentalSlashCommandsEnabled?: boolean
  // legacy migration fallback; new writes should use experimentalSlashCommandsEnabled
  experimentalStatusSlashCommandEnabled?: boolean
}

const filename = "copilot-accounts.json"
const authFile = "auth.json"
const defaultStoreDebugLogFile = (() => {
  const tmp = process.env.TEMP || process.env.TMP || "/tmp"
  return `${tmp}/opencode-copilot-store-debug.log`
})()

function isStoreDebugEnabled() {
  return process.env.OPENCODE_COPILOT_STORE_DEBUG === "1"
}

function buildStoreSnapshot(store: StoreFile | undefined) {
  return {
    active: store?.active ?? null,
    accountCount: Object.keys(store?.accounts ?? {}).length,
    modelAccountAssignmentCount: Object.keys(store?.modelAccountAssignments ?? {}).length,
    loopSafetyEnabled: store?.loopSafetyEnabled ?? null,
    loopSafetyProviderScope: store?.loopSafetyProviderScope ?? null,
    networkRetryEnabled: store?.networkRetryEnabled ?? null,
    experimentalSlashCommandsEnabled: store?.experimentalSlashCommandsEnabled ?? null,
    lastAccountSwitchAt: store?.lastAccountSwitchAt ?? null,
    syntheticAgentInitiatorEnabled: store?.syntheticAgentInitiatorEnabled ?? false,
  }
}

function buildCallStack() {
  const stack = new Error().stack?.split("\n") ?? []
  return stack
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
}

async function logStoreWrite(input: {
  filePath: string
  before?: StoreFile
  after: StoreFile
  debug?: StoreWriteDebugMeta
}) {
  if (!isStoreDebugEnabled()) return

  const filePath = process.env.OPENCODE_COPILOT_STORE_DEBUG_FILE || defaultStoreDebugLogFile
  const event = {
    kind: "store-write",
    at: new Date().toISOString(),
    targetFile: input.filePath,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 8),
    stack: buildCallStack(),
    ...input.debug,
    before: buildStoreSnapshot(input.before),
    after: buildStoreSnapshot(input.after),
  }

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8")
  } catch (error) {
    console.warn("[copilot-store-debug] failed to write debug log", error)
  }
}

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
  const legacySlashCommandsEnabled = (data as StoreFile & { experimentalStatusSlashCommandEnabled?: unknown }).experimentalStatusSlashCommandEnabled
  const rawActiveAccountNames = (data as StoreFile & { activeAccountNames?: unknown }).activeAccountNames
  if (!data.accounts) data.accounts = {}

  const normalizeAccountNameList = (names: unknown) => {
    if (!Array.isArray(names)) return undefined
    const next = [...new Set(names.filter((item): item is string => typeof item === "string" && item.length > 0 && !!data.accounts[item]))].sort((a, b) =>
      a.localeCompare(b),
    )
    return next.length > 0 ? next : undefined
  }

  const normalizedActiveAccountNames = normalizeAccountNameList(rawActiveAccountNames)
  if (normalizedActiveAccountNames) data.activeAccountNames = normalizedActiveAccountNames
  else if (typeof data.active === "string" && data.active.length > 0 && data.accounts[data.active]) {
    data.activeAccountNames = [data.active]
  } else {
    delete data.activeAccountNames
  }

  const modelAccountAssignments = (data as StoreFile & {
    modelAccountAssignments?: Record<string, unknown>
  }).modelAccountAssignments
  if (!modelAccountAssignments || typeof modelAccountAssignments !== "object" || Array.isArray(modelAccountAssignments)) {
    delete (data as StoreFile & { modelAccountAssignments?: Record<string, unknown> }).modelAccountAssignments
  }
  if (modelAccountAssignments && typeof modelAccountAssignments === "object" && !Array.isArray(modelAccountAssignments)) {
    const normalizedAssignments = Object.fromEntries(
      Object.entries(modelAccountAssignments).flatMap(([modelID, accountName]) => {
        if (typeof modelID !== "string" || modelID.length === 0) return []
        if (typeof accountName === "string") {
          const names = normalizeAccountNameList([accountName])
          return names ? [[modelID, names]] : []
        }
        const names = normalizeAccountNameList(accountName)
        return names ? [[modelID, names]] : []
      }),
    )
    if (Object.keys(normalizedAssignments).length === 0) {
      delete (data as StoreFile & { modelAccountAssignments?: Record<string, unknown> }).modelAccountAssignments
    } else {
      ;(data as unknown as { modelAccountAssignments?: Record<string, string[]> }).modelAccountAssignments = normalizedAssignments
    }
  }
  if (typeof data.lastAccountSwitchAt !== "number" || Number.isNaN(data.lastAccountSwitchAt)) {
    delete data.lastAccountSwitchAt
  }
  if (data.loopSafetyEnabled !== false) data.loopSafetyEnabled = true
  if (data.loopSafetyProviderScope !== "all-models") data.loopSafetyProviderScope = "copilot-only"
  if (data.networkRetryEnabled !== true) data.networkRetryEnabled = false
  if (data.syntheticAgentInitiatorEnabled !== true) data.syntheticAgentInitiatorEnabled = false
  if (data.experimentalSlashCommandsEnabled !== true && data.experimentalSlashCommandsEnabled !== false) {
    data.experimentalSlashCommandsEnabled = legacySlashCommandsEnabled === false ? false : true
  }
  delete (data as StoreFile & { experimentalStatusSlashCommandEnabled?: unknown }).experimentalStatusSlashCommandEnabled
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

export function readStoreSafeSync(filePath = storePath()): StoreFile | undefined {
  try {
    return parseStore(readFileSync(filePath, "utf-8"))
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

export async function writeStore(
  store: StoreFile,
  options?: {
    filePath?: string
    debug?: StoreWriteDebugMeta
  },
) {
  const file = options?.filePath ?? storePath()
  const before = await readStoreSafe(file)
  await logStoreWrite({
    filePath: file,
    before,
    after: store,
    debug: options?.debug,
  })
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 })
}
