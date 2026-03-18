import type { AccountEntry, StoreFile } from "./store.js"

export type ResolvedModelAccount = {
  name: string
  entry: AccountEntry
  source: "model" | "active"
}

export function listKnownCopilotModels(store: StoreFile): string[] {
  return [...new Set(
    Object.values(store.accounts).flatMap((entry) => entry.models?.available ?? []),
  )].sort((a, b) => a.localeCompare(b))
}

export function listAssignableAccountsForModel(store: StoreFile, modelID: string): Array<{ name: string; entry: AccountEntry }> {
  const mapped = store.modelAccountAssignments?.[modelID]
  const names = [...new Set(
    Object.entries(store.accounts)
      .filter(([name, entry]) => (entry.models?.available ?? []).includes(modelID) || name === mapped)
      .map(([name]) => name),
  )]

  return names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, entry: store.accounts[name] }))
}

export function resolveCopilotModelAccount(store: StoreFile, modelID?: string): ResolvedModelAccount | undefined {
  if (modelID) {
    const mapped = store.modelAccountAssignments?.[modelID]
    if (mapped && store.accounts[mapped]) {
      return {
        name: mapped,
        entry: store.accounts[mapped],
        source: "model",
      }
    }
  }

  if (!store.active || !store.accounts[store.active]) return undefined
  return {
    name: store.active,
    entry: store.accounts[store.active],
    source: "active",
  }
}

export function rewriteModelAccountAssignments(store: StoreFile, rename: Record<string, string | undefined>) {
  const current = store.modelAccountAssignments
  if (!current) return

  const next = Object.fromEntries(
    Object.entries(current)
      .map(([modelID, accountName]) => [modelID, rename[accountName] ?? accountName] as const)
      .filter(([, accountName]) => typeof accountName === "string" && !!store.accounts[accountName]),
  )

  if (Object.keys(next).length === 0) {
    delete store.modelAccountAssignments
    return
  }

  store.modelAccountAssignments = next
}
