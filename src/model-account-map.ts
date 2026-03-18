import type { AccountEntry, StoreFile } from "./store.js"

export type ResolvedModelAccount = {
  name: string
  entry: AccountEntry
  source: "model" | "active"
}

export type ResolvedModelAccountCandidate = {
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
  const mapped = new Set(store.modelAccountAssignments?.[modelID] ?? [])
  const names = [...new Set(
    Object.entries(store.accounts)
      .filter(([name, entry]) => (entry.models?.available ?? []).includes(modelID) || mapped.has(name))
      .map(([name]) => name),
  )]

  return names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, entry: store.accounts[name] }))
}

function resolveCandidateAccountNames(store: StoreFile, modelID?: string) {
  if (modelID && store.modelAccountAssignments && Object.prototype.hasOwnProperty.call(store.modelAccountAssignments, modelID)) {
    return {
      names: store.modelAccountAssignments[modelID] ?? [],
      source: "model" as const,
    }
  }

  if (Array.isArray(store.activeAccountNames)) {
    return {
      names: store.activeAccountNames,
      source: "active" as const,
    }
  }

  return {
    names: store.active ? [store.active] : [],
    source: "active" as const,
  }
}

function isCandidateAvailableForModel(entry: AccountEntry, modelID?: string) {
  if (!modelID) return true
  const models = entry.models
  if (!models) return true
  if (models.disabled?.includes(modelID)) return false
  if (models.available?.includes(modelID)) return true
  if (Array.isArray(models.available)) return false
  return true
}

export function resolveCopilotModelAccounts(store: StoreFile, modelID?: string): ResolvedModelAccountCandidate[] {
  const { names, source } = resolveCandidateAccountNames(store, modelID)
  const seen = new Set<string>()
  const resolved: ResolvedModelAccountCandidate[] = []

  for (const name of names) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue
    seen.add(name)
    const entry = store.accounts[name]
    if (!entry) continue
    if (!isCandidateAvailableForModel(entry, modelID)) continue
    resolved.push({
      name,
      entry,
      source,
    })
  }

  return resolved
}

export function resolveCopilotModelAccount(store: StoreFile, modelID?: string): ResolvedModelAccount | undefined {
  const first = resolveCopilotModelAccounts(store, modelID)[0]
  if (!first) return undefined
  return first
}

export function rewriteModelAccountAssignments(store: StoreFile, rename: Record<string, string | undefined>) {
  const current = store.modelAccountAssignments
  if (!current) return

  const next = Object.fromEntries(
    Object.entries(current)
      .map(([modelID, accountNames]) => {
        const seen = new Set<string>()
        const resolvedNames: string[] = []
        for (const originalName of accountNames) {
          const mappedName = rename[originalName] ?? originalName
          if (typeof mappedName !== "string" || !store.accounts[mappedName] || seen.has(mappedName)) continue
          seen.add(mappedName)
          resolvedNames.push(mappedName)
        }
        return [modelID, resolvedNames] as const
      })
      .filter(([, accountNames]) => accountNames.length > 0),
  )

  if (Object.keys(next).length === 0) {
    delete store.modelAccountAssignments
    return
  }

  store.modelAccountAssignments = next
}
