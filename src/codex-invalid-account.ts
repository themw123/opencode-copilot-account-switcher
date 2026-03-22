import type { CodexAccountEntry, CodexStoreFile } from "./codex-store.js"

export type CodexRecoveryCandidate = {
  name: string
  entry: CodexAccountEntry
}

export type CodexSetAuthInput = {
  path: { id: string }
  body: {
    type: "oauth"
    refresh?: string
    access?: string
    expires?: number
    accountId?: string
  }
}

export type RecoverInvalidCodexAccountResult = {
  removed: string
  replacement?: string
  switched: boolean
  weekRecoveryOnly: boolean
  noCandidates: boolean
  store: CodexStoreFile
}

function pickPositiveNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return value > 0 ? value : 0
}

function pickFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

function getWeekRemaining(entry: CodexAccountEntry): number {
  return pickPositiveNumber(entry.snapshot?.usageWeek?.remaining)
}

function get5hRemaining(entry: CodexAccountEntry): number {
  return pickPositiveNumber(entry.snapshot?.usage5h?.remaining)
}

function compareResetAt(a?: number, b?: number): number {
  const aMissing = a === undefined
  const bMissing = b === undefined
  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1
  if (a === b) return 0
  return a < b ? -1 : 1
}

export function getCodexDisplayName(entry: CodexAccountEntry | undefined, fallbackName: string): string {
  return entry?.workspaceName
    ?? entry?.name
    ?? entry?.email
    ?? entry?.accountId
    ?? fallbackName
}

export function sortCodexRecoveryCandidates(candidates: CodexRecoveryCandidate[]): CodexRecoveryCandidate[] {
  const withIndex = candidates.map((candidate, index) => ({ candidate, index }))
  const weekPositive = withIndex.filter(({ candidate }) => getWeekRemaining(candidate.entry) > 0)
  const pool = weekPositive.length > 0 ? weekPositive : withIndex
  const has5hPositiveInPool = pool.some(({ candidate }) => get5hRemaining(candidate.entry) > 0)

  return pool
    .slice()
    .sort((a, b) => {
      if (weekPositive.length > 0 && has5hPositiveInPool) {
        const a5h = get5hRemaining(a.candidate.entry)
        const b5h = get5hRemaining(b.candidate.entry)
        if (a5h > 0 && b5h <= 0) return -1
        if (a5h <= 0 && b5h > 0) return 1

        const by5hResetAt = compareResetAt(
          pickFiniteNumber(a.candidate.entry.snapshot?.usage5h?.resetAt),
          pickFiniteNumber(b.candidate.entry.snapshot?.usage5h?.resetAt),
        )
        if (by5hResetAt !== 0) return by5hResetAt
      }

      const byWeekResetAt = compareResetAt(
        pickFiniteNumber(a.candidate.entry.snapshot?.usageWeek?.resetAt),
        pickFiniteNumber(b.candidate.entry.snapshot?.usageWeek?.resetAt),
      )
      if (byWeekResetAt !== 0) return byWeekResetAt
      return a.index - b.index
    })
    .map(({ candidate }) => candidate)
}

export async function recoverInvalidCodexAccount(input: {
  store: CodexStoreFile
  invalidAccountName: string
  setAuth?: (next: CodexSetAuthInput) => Promise<unknown>
}): Promise<RecoverInvalidCodexAccountResult> {
  const store: CodexStoreFile = {
    ...input.store,
    accounts: { ...input.store.accounts },
  }

  delete store.accounts[input.invalidAccountName]

  const candidates = Object.entries(store.accounts).map(([name, entry]) => ({
    name,
    entry,
  }))
  const sorted = sortCodexRecoveryCandidates(candidates)
  const replacement = sorted[0]
  const noCandidates = !replacement
  const switched = Boolean(replacement)
  const weekRecoveryOnly = Boolean(
    replacement
    && getWeekRemaining(replacement.entry) <= 0,
  )

  if (replacement) {
    store.active = replacement.name
  } else if (store.active === input.invalidAccountName) {
    delete store.active
  }

  if (replacement && input.setAuth) {
    await input.setAuth({
      path: { id: "openai" },
      body: {
        type: "oauth",
        refresh: replacement.entry.refresh,
        access: replacement.entry.access,
        expires: replacement.entry.expires,
        accountId: replacement.entry.accountId,
      },
    })
  }

  return {
    removed: input.invalidAccountName,
    replacement: replacement?.name,
    switched,
    weekRecoveryOnly,
    noCandidates,
    store,
  }
}
