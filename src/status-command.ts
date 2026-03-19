import type { RefreshActiveAccountQuotaResult } from "./active-account-quota.js"
import type { StoreFile, StoreWriteDebugMeta } from "./store.js"

type ToastVariant = "info" | "success" | "warning" | "error"

type ToastClient = {
  tui?: {
    showToast?: (options: {
      body: {
        message: string
        variant: ToastVariant
      }
      query?: undefined
    }) => Promise<unknown>
  }
}

export class StatusCommandHandledError extends Error {
  constructor() {
    super("status-command-handled")
    this.name = "StatusCommandHandledError"
  }
}

function summarizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatQuotaValue(snapshot?: { remaining?: number; entitlement?: number }) {
  const remaining = snapshot?.remaining
  const entitlement = snapshot?.entitlement
  if (remaining === undefined && entitlement === undefined) return "n/a"
  return `${remaining ?? "?"}/${entitlement ?? "?"}`
}

function formatUpdatedAt(updatedAt?: number) {
  if (typeof updatedAt !== "number") return "updated at unknown"
  return `updated at ${new Date(updatedAt).toISOString()}`
}

function formatActiveGroup(store: StoreFile) {
  const names = Array.isArray(store.activeAccountNames) ? store.activeAccountNames : []
  if (names.length > 0) return names.join(", ")
  return "none"
}

function formatRoutingGroup(store: StoreFile) {
  const assignments = store.modelAccountAssignments ?? {}
  const modelIDs = Object.keys(assignments).sort((a, b) => a.localeCompare(b))
  const mapped = modelIDs
    .map((modelID) => {
      const names = assignments[modelID] ?? []
      if (names.length === 0) return undefined
      return `${modelID} -> ${names.join(", ")}`
    })
    .filter((line): line is string => Boolean(line))
  return mapped.length > 0 ? mapped.join("; ") : "none"
}

function buildSuccessMessage(store: StoreFile, name: string, quota?: StoreFile["accounts"][string]["quota"]) {
  const activeSummary = [
    `current active: ${name}`,
    `premium ${formatQuotaValue(quota?.snapshots?.premium)}`,
    `chat ${formatQuotaValue(quota?.snapshots?.chat)}`,
    `completions ${formatQuotaValue(quota?.snapshots?.completions)}`,
    formatUpdatedAt(quota?.updatedAt),
  ].join(" | ")

  return [activeSummary, `活跃组: ${formatActiveGroup(store)}`, `路由组: ${formatRoutingGroup(store)}`].join("\n")
}

function buildMissingActiveMessage() {
  return "No active account available for Copilot status."
}

function buildRefreshFailedMessage(result: { error: string; previousQuota?: StoreFile["accounts"][string]["quota"] }) {
  const previous = result.previousQuota?.snapshots?.premium
  const previousText = previous ? ` Last known premium ${formatQuotaValue(previous)}.` : ""
  return `Copilot quota refresh failed: ${result.error}.${previousText}`
}

function buildPersistFailedMessage(store: StoreFile, entry: StoreFile["accounts"][string], error: unknown) {
  return `Latest quota refreshed but store persistence failed: ${summarizeError(error)}. ${buildSuccessMessage(store, entry.name, entry.quota)}`
}

export async function showStatusToast(input: {
  client?: ToastClient
  message: string
  variant: ToastVariant
  warn?: (scope: string, error: unknown) => void
}): Promise<void> {
  const tui = input.client?.tui
  const showToast = tui?.showToast
  if (!showToast) return
  try {
    await showToast.call(tui, {
      body: {
        message: input.message,
        variant: input.variant,
      },
    })
  } catch (error) {
    input.warn?.("status-command.toast", error)
  }
}

export async function handleStatusCommand(input: {
  client?: ToastClient
  loadStore: () => Promise<StoreFile | undefined>
  writeStore: (store: StoreFile, meta?: StoreWriteDebugMeta) => Promise<void>
  refreshQuota: (store: StoreFile) => Promise<RefreshActiveAccountQuotaResult>
}): Promise<never> {
  const warn = (scope: string, error: unknown) => {
    console.warn(`[${scope}] failed to show toast`, error)
  }

  let store: StoreFile | undefined
  try {
    store = await input.loadStore()
  } catch (error) {
    await showStatusToast({
      client: input.client,
      message: `Failed to read Copilot status store: ${summarizeError(error)}`,
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  if (!store) {
    await showStatusToast({
      client: input.client,
      message: "Failed to read Copilot status store.",
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  if (!store.active || !store.accounts[store.active]) {
    await showStatusToast({
      client: input.client,
      message: buildMissingActiveMessage(),
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  await showStatusToast({
    client: input.client,
    message: "Fetching Copilot quota...",
    variant: "info",
    warn,
  })

  let result: RefreshActiveAccountQuotaResult
  try {
    result = await input.refreshQuota(store)
  } catch (error) {
    await showStatusToast({
      client: input.client,
      message: `Copilot quota refresh failed: ${summarizeError(error)}`,
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  if (result.type === "missing-active") {
    await showStatusToast({
      client: input.client,
      message: buildMissingActiveMessage(),
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  if (result.type === "refresh-failed") {
    await showStatusToast({
      client: input.client,
      message: buildRefreshFailedMessage(result),
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  try {
    await input.writeStore(store, {
      reason: "status-command-refresh",
      source: "status-command",
    })
  } catch (error) {
    await showStatusToast({
      client: input.client,
      message: buildPersistFailedMessage(store, result.entry, error),
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  await showStatusToast({
    client: input.client,
    message: buildSuccessMessage(store, result.name, result.entry.quota),
    variant: "success",
    warn,
  })
  throw new StatusCommandHandledError()
}
