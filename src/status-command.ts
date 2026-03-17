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

function buildSuccessMessage(name: string, quota?: StoreFile["accounts"][string]["quota"]) {
  return [
    `${name} Copilot quota`,
    `premium ${formatQuotaValue(quota?.snapshots?.premium)} chat ${formatQuotaValue(quota?.snapshots?.chat)} completions ${formatQuotaValue(quota?.snapshots?.completions)}`,
    formatUpdatedAt(quota?.updatedAt),
  ].join(" | ")
}

function buildMissingActiveMessage() {
  return "No active account available for Copilot status."
}

function buildRefreshFailedMessage(result: { error: string; previousQuota?: StoreFile["accounts"][string]["quota"] }) {
  const previous = result.previousQuota?.snapshots?.premium
  const previousText = previous ? ` Last known premium ${formatQuotaValue(previous)}.` : ""
  return `Copilot quota refresh failed: ${result.error}.${previousText}`
}

function buildPersistFailedMessage(entry: StoreFile["accounts"][string], error: unknown) {
  return `Latest quota refreshed but store persistence failed: ${summarizeError(error)}. ${buildSuccessMessage(entry.name, entry.quota)}`
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
      message: buildPersistFailedMessage(result.entry, error),
      variant: "error",
      warn,
    })
    throw new StatusCommandHandledError()
  }

  await showStatusToast({
    client: input.client,
    message: buildSuccessMessage(result.name, result.entry.quota),
    variant: "success",
    warn,
  })
  throw new StatusCommandHandledError()
}
