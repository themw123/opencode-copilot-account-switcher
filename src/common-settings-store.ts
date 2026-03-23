import path from "node:path"
import { promises as fs } from "node:fs"
import { readFileSync } from "node:fs"

import { commonSettingsPath as defaultCommonSettingsPath, legacyCopilotStorePath } from "./store-paths.js"
import { parseStore, type StoreFile } from "./store.js"

export type CommonSettingsStore = {
  loopSafetyEnabled?: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
  networkRetryEnabled?: boolean
  experimentalSlashCommandsEnabled?: boolean
  experimentalStatusSlashCommandEnabled?: boolean
}

function normalizeCommonSettingsStore(input: CommonSettingsStore | undefined): CommonSettingsStore {
  const source = input ?? {}
  const legacySlashCommandsEnabled = source.experimentalStatusSlashCommandEnabled
  return {
    ...(source.loopSafetyEnabled !== false ? { loopSafetyEnabled: true } : { loopSafetyEnabled: false }),
    loopSafetyProviderScope: source.loopSafetyProviderScope === "all-models" ? "all-models" : "copilot-only",
    ...(source.networkRetryEnabled === true ? { networkRetryEnabled: true } : { networkRetryEnabled: false }),
    experimentalSlashCommandsEnabled:
      source.experimentalSlashCommandsEnabled === true || source.experimentalSlashCommandsEnabled === false
        ? source.experimentalSlashCommandsEnabled
        : legacySlashCommandsEnabled === false
        ? false
        : true,
  }
}

function parsePartialCommonSettingsStore(raw: string): CommonSettingsStore {
  const parsed = raw ? (JSON.parse(raw) as CommonSettingsStore) : {}
  const partial: CommonSettingsStore = {}

  if (parsed.loopSafetyEnabled === true || parsed.loopSafetyEnabled === false) {
    partial.loopSafetyEnabled = parsed.loopSafetyEnabled
  }
  if (parsed.loopSafetyProviderScope === "all-models" || parsed.loopSafetyProviderScope === "copilot-only") {
    partial.loopSafetyProviderScope = parsed.loopSafetyProviderScope
  }
  if (parsed.networkRetryEnabled === true || parsed.networkRetryEnabled === false) {
    partial.networkRetryEnabled = parsed.networkRetryEnabled
  }
  if (parsed.experimentalSlashCommandsEnabled === true || parsed.experimentalSlashCommandsEnabled === false) {
    partial.experimentalSlashCommandsEnabled = parsed.experimentalSlashCommandsEnabled
  }
  if (parsed.experimentalStatusSlashCommandEnabled === true || parsed.experimentalStatusSlashCommandEnabled === false) {
    partial.experimentalStatusSlashCommandEnabled = parsed.experimentalStatusSlashCommandEnabled
  }

  return partial
}

function readLegacyCommonSettings(store: StoreFile | undefined): CommonSettingsStore {
  if (!store) return {}
  return normalizeCommonSettingsStore({
    loopSafetyEnabled: store.loopSafetyEnabled,
    loopSafetyProviderScope: store.loopSafetyProviderScope,
    networkRetryEnabled: store.networkRetryEnabled,
    experimentalSlashCommandsEnabled: store.experimentalSlashCommandsEnabled,
    experimentalStatusSlashCommandEnabled: store.experimentalStatusSlashCommandEnabled,
  })
}

function mergeCommonSettings(current: CommonSettingsStore, legacy: CommonSettingsStore) {
  return normalizeCommonSettingsStore({
    loopSafetyEnabled: current.loopSafetyEnabled ?? legacy.loopSafetyEnabled,
    loopSafetyProviderScope: current.loopSafetyProviderScope ?? legacy.loopSafetyProviderScope,
    networkRetryEnabled: current.networkRetryEnabled ?? legacy.networkRetryEnabled,
    experimentalSlashCommandsEnabled:
      current.experimentalSlashCommandsEnabled ?? legacy.experimentalSlashCommandsEnabled,
    experimentalStatusSlashCommandEnabled:
      current.experimentalStatusSlashCommandEnabled ?? legacy.experimentalStatusSlashCommandEnabled,
  })
}

export function parseCommonSettingsStore(raw: string): CommonSettingsStore {
  return normalizeCommonSettingsStore(parsePartialCommonSettingsStore(raw))
}

export function commonSettingsPath() {
  return defaultCommonSettingsPath()
}

export async function readCommonSettingsStore(options?: {
  filePath?: string
  legacyCopilotFilePath?: string
}): Promise<CommonSettingsStore> {
  const file = options?.filePath ?? commonSettingsPath()
  const raw = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const current = parsePartialCommonSettingsStore(raw)

  const legacyFile = options?.legacyCopilotFilePath ?? legacyCopilotStorePath()
  const legacyRaw = await fs.readFile(legacyFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })

  if (!legacyRaw) return normalizeCommonSettingsStore(current)
  const legacy = readLegacyCommonSettings(parseStore(legacyRaw))
  return mergeCommonSettings(current, legacy)
}

export function readCommonSettingsStoreSync(options?: {
  filePath?: string
  legacyCopilotFilePath?: string
}): CommonSettingsStore | undefined {
  const file = options?.filePath ?? commonSettingsPath()
  let current = ""
  try {
    current = readFileSync(file, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") return undefined
  }

  const legacyFile = options?.legacyCopilotFilePath ?? legacyCopilotStorePath()
  let legacyRaw = ""
  try {
    legacyRaw = readFileSync(legacyFile, "utf8")
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code !== "ENOENT") return undefined
  }

  const partial = parsePartialCommonSettingsStore(current)
  if (!legacyRaw) return normalizeCommonSettingsStore(partial)
  return mergeCommonSettings(partial, readLegacyCommonSettings(parseStore(legacyRaw)))
}

export async function writeCommonSettingsStore(
  store: CommonSettingsStore,
  options?: {
    filePath?: string
  },
) {
  const file = options?.filePath ?? commonSettingsPath()
  const normalized = normalizeCommonSettingsStore(store)
  const persisted: CommonSettingsStore = {
    loopSafetyEnabled: normalized.loopSafetyEnabled,
    loopSafetyProviderScope: normalized.loopSafetyProviderScope,
    networkRetryEnabled: normalized.networkRetryEnabled,
    experimentalSlashCommandsEnabled: normalized.experimentalSlashCommandsEnabled,
  }

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(persisted, null, 2), { mode: 0o600 })
}
