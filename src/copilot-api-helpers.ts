import type { AccountEntry } from "./store.js"

export function getGitHubToken(entry: AccountEntry): string {
  if (entry.access && (entry.access.startsWith("ghu_") || entry.access.startsWith("gho_") || entry.access.startsWith("ghp_") || entry.access.startsWith("github_pat_"))) {
    return entry.access
  }
  if (entry.refresh && (entry.refresh.startsWith("ghu_") || entry.refresh.startsWith("gho_") || entry.refresh.startsWith("ghp_") || entry.refresh.startsWith("github_pat_"))) {
    return entry.refresh
  }
  if (entry.refresh?.startsWith("ghr_") && entry.access && !entry.access.startsWith("ghr_")) {
    return entry.access
  }
  return entry.refresh || entry.access
}

export function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}
