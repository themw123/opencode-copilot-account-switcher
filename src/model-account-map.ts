import type { AccountEntry, StoreFile } from "./store.js"

export type ResolvedModelAccountCandidate = {
  name: string
  entry: AccountEntry
  source: "model" | "active"
}

export type ResolvedModelAccount = ResolvedModelAccountCandidate

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

function isCandidateAvailableForModel(entry: AccountEntry, modelID?: string) {
  if (!modelID) return true
  const models = entry.models
  if (!models) return true
  if (models.disabled?.includes(modelID)) return false
  if (models.available?.includes(modelID)) return true
  if (Array.isArray(models.available)) return false
  return true
}

function resolveCandidatesFromNames(
  store: StoreFile,
  names: string[],
  source: ResolvedModelAccountCandidate["source"],
  modelID?: string,
) {
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

export function resolveCopilotModelAccounts(store: StoreFile, modelID?: string): ResolvedModelAccountCandidate[] {
  const hasMappedGroup = Boolean(
    modelID
    && store.modelAccountAssignments
    && Object.prototype.hasOwnProperty.call(store.modelAccountAssignments, modelID),
  )

  if (hasMappedGroup) {
    const mapped = resolveCandidatesFromNames(store, store.modelAccountAssignments?.[modelID!] ?? [], "model", modelID)
    if (mapped.length > 0) return mapped
  }

  if (Array.isArray(store.activeAccountNames)) {
    return resolveCandidatesFromNames(store, store.activeAccountNames, "active", modelID)
  }

  return resolveCandidatesFromNames(store, store.active ? [store.active] : [], "active", modelID)
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
