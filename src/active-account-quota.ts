import { getGitHubToken, normalizeDomain } from "./copilot-api-helpers.js"
import type { AccountEntry, StoreFile } from "./store.js"

function buildSnapshot(raw?: {
  entitlement?: number
  remaining?: number
  used?: number
  unlimited?: boolean
  percent_remaining?: number
}) {
  if (!raw) return undefined
  const entitlement = raw.entitlement
  const remaining = raw.remaining
  const used = raw.used ??
    (entitlement !== undefined && remaining !== undefined ? entitlement - remaining : undefined)
  const percentRemaining = raw.percent_remaining
  return {
    entitlement,
    remaining,
    used,
    unlimited: raw.unlimited,
    percentRemaining,
  }
}

export async function fetchQuota(entry: AccountEntry): Promise<AccountEntry["quota"]> {
  try {
    const headers = {
      Accept: "application/json",
      Authorization: `token ${getGitHubToken(entry)}`,
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "Editor-Version": "vscode/1.96.2",
      "Copilot-Integration-Id": "vscode-chat",
      "X-Github-Api-Version": "2025-04-01",
    }
    const base = entry.enterpriseUrl ? `https://api.${normalizeDomain(entry.enterpriseUrl)}` : "https://api.github.com"
    const quotaRes = await fetch(`${base}/copilot_internal/user`, { headers })
    if (!quotaRes.ok) {
      return { error: `quota ${quotaRes.status}` }
    }
    const quotaData = (await quotaRes.json()) as {
      access_type_sku?: string
      copilot_plan?: string
      quota_reset_date?: string
      quota_snapshots?: {
        premium_interactions?: {
          entitlement?: number
          remaining?: number
          used?: number
          unlimited?: boolean
          percent_remaining?: number
        }
        chat?: {
          entitlement?: number
          remaining?: number
          used?: number
          unlimited?: boolean
          percent_remaining?: number
        }
        completions?: {
          entitlement?: number
          remaining?: number
          used?: number
          unlimited?: boolean
          percent_remaining?: number
        }
      }
    }
    return {
      sku: quotaData.access_type_sku,
      plan: quotaData.copilot_plan,
      reset: quotaData.quota_reset_date,
      updatedAt: Date.now(),
      snapshots: {
        premium: buildSnapshot(quotaData.quota_snapshots?.premium_interactions),
        chat: buildSnapshot(quotaData.quota_snapshots?.chat),
        completions: buildSnapshot(quotaData.quota_snapshots?.completions),
      },
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export type RefreshActiveAccountQuotaResult =
  | { type: "missing-active" }
  | { type: "refresh-failed"; name?: string; error: string; previousQuota?: AccountEntry["quota"] }
  | { type: "success"; name: string; entry: AccountEntry }

export async function refreshActiveAccountQuota(input: {
  store: StoreFile
  fetchQuotaImpl?: typeof fetchQuota
  now?: () => number
}): Promise<RefreshActiveAccountQuotaResult> {
  const store = input.store
  if (!store.active) return { type: "missing-active" }
  const entry = store.accounts[store.active]
  if (!entry) return { type: "missing-active" }

  const quota = await (input.fetchQuotaImpl ?? fetchQuota)(entry)
  if (quota?.error) {
    return {
      type: "refresh-failed",
      name: store.active,
      error: quota.error,
      previousQuota: entry.quota,
    }
  }

  store.accounts[store.active] = {
    ...entry,
    quota,
  }
  store.lastQuotaRefresh = (input.now ?? Date.now)()
  return { type: "success", name: store.active, entry: store.accounts[store.active] }
}
