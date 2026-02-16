import { ANSI } from "./ansi"
import { select, type MenuItem } from "./select"
import { confirm } from "./confirm"

export type AccountStatus = "active" | "expired" | "unknown"

export interface AccountInfo {
  name: string
  index: number
  addedAt?: number
  lastUsed?: number
  status?: AccountStatus
  isCurrent?: boolean
  source?: "auth" | "manual"
  orgs?: string[]
  plan?: string
  sku?: string
  reset?: string
  models?: { enabled: number; disabled: number }
  modelsError?: string
  modelList?: { available: string[]; disabled: string[] }
  quota?: {
    premium?: { remaining?: number; entitlement?: number; unlimited?: boolean }
    chat?: { remaining?: number; entitlement?: number; unlimited?: boolean }
    completions?: { remaining?: number; entitlement?: number; unlimited?: boolean }
  }
}

export type MenuAction =
  | { type: "add" }
  | { type: "import" }
  | { type: "quota" }
  | { type: "refresh-identity" }
  | { type: "check-models" }
  | { type: "toggle-refresh" }
  | { type: "set-interval" }
  | { type: "switch"; account: AccountInfo }
  | { type: "remove"; account: AccountInfo }
  | { type: "remove-all" }
  | { type: "cancel" }

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "never"
  const days = Math.floor((Date.now() - timestamp) / 86400000)
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return new Date(timestamp).toLocaleDateString()
}

function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return "unknown"
  return new Date(timestamp).toLocaleDateString()
}

function getStatusBadge(status: AccountStatus | undefined): string {
  if (status === "expired") return `${ANSI.red}[expired]${ANSI.reset}`
  return ""
}

export async function showMenu(
  accounts: AccountInfo[],
  refresh?: { enabled: boolean; minutes: number },
  lastQuotaRefresh?: number,
): Promise<MenuAction> {
  const quotaHint = lastQuotaRefresh ? `last ${formatRelativeTime(lastQuotaRefresh)}` : undefined
    const items: MenuItem<MenuAction>[] = [
      { label: "Actions", value: { type: "cancel" }, kind: "heading" },
      { label: "Add account", value: { type: "add" }, color: "cyan", hint: "device login or manual" },
      { label: "Import from auth.json", value: { type: "import" }, color: "cyan" },
      { label: "Check quotas", value: { type: "quota" }, color: "cyan", hint: quotaHint },
      { label: "Refresh identity", value: { type: "refresh-identity" }, color: "cyan" },
      { label: "Check models", value: { type: "check-models" }, color: "cyan" },
    {
      label: refresh?.enabled ? "Disable auto refresh" : "Enable auto refresh",
      value: { type: "toggle-refresh" },
      color: "cyan",
      hint: refresh ? `${refresh.minutes}m` : undefined,
    },
    { label: "Set refresh interval", value: { type: "set-interval" }, color: "cyan" },
    { label: "", value: { type: "cancel" }, separator: true },
    { label: "Accounts", value: { type: "cancel" }, kind: "heading" },
    ...accounts.map((account) => {
      const statusBadge = getStatusBadge(account.status)
      const currentBadge = account.isCurrent ? ` ${ANSI.cyan}*${ANSI.reset}` : ""
      const format = (s?: { remaining?: number; entitlement?: number; unlimited?: boolean }) =>
        s?.unlimited ? "∞" : s?.remaining !== undefined && s?.entitlement !== undefined ? `${s.remaining}/${s.entitlement}` : "?"
      const quotaBadge = account.quota
        ? ` ${ANSI.dim}[${format(account.quota.premium)}|${format(account.quota.chat)}|${format(account.quota.completions)}]${ANSI.reset}`
        : ""
      const numbered = `${account.index + 1}. ${account.name}`
      const label = `${numbered}${currentBadge}${statusBadge ? " " + statusBadge : ""}${quotaBadge}`
      const detail = [
        account.lastUsed ? formatRelativeTime(account.lastUsed) : undefined,
        account.plan,
        account.models ? `${account.models.enabled}/${account.models.enabled + account.models.disabled} mods` : undefined,
      ]
        .filter(Boolean)
        .join(" • ")
      return {
        label,
        hint: detail || undefined,
        value: { type: "switch" as const, account },
      }
    }),
    { label: "", value: { type: "cancel" }, separator: true },
    { label: "Danger zone", value: { type: "cancel" }, kind: "heading" },
    { label: "Remove all accounts", value: { type: "remove-all" }, color: "red" },
  ]

  while (true) {
    const result = await select(items, {
      message: "GitHub Copilot accounts",
      subtitle: "Select an action or account",
      clearScreen: true,
    })

    if (!result) return { type: "cancel" }
    if (result.type === "remove-all") {
      const ok = await confirm("Remove ALL accounts? This cannot be undone.")
      if (!ok) continue
    }
    return result
  }
}

export async function showAccountActions(account: AccountInfo): Promise<"switch" | "remove" | "back"> {
  const badge = getStatusBadge(account.status)
  const header = `${account.name}${badge ? " " + badge : ""}`
  const info = [
    `Added: ${formatDate(account.addedAt)} | Last used: ${formatRelativeTime(account.lastUsed)}`,
    account.plan ? `Plan: ${account.plan}` : undefined,
    account.sku ? `SKU: ${account.sku}` : undefined,
    account.reset ? `Reset: ${account.reset}` : undefined,
    account.models ? `Models: ${account.models.enabled}/${account.models.enabled + account.models.disabled}` : undefined,
    account.orgs?.length ? `Orgs: ${account.orgs.slice(0, 2).join(",")}` : undefined,
    account.modelsError ? `Models error: ${account.modelsError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
  const subtitle = info

  while (true) {
    const modelAction = account.modelList || account.modelsError
      ? [{ label: "View models", value: "models" as const, color: "cyan" as const }]
      : []
    const result = await select(
      [
        { label: "Back", value: "back" as const },
        ...modelAction,
        { label: "Switch to this account", value: "switch" as const, color: "cyan" as const },
        { label: "Remove this account", value: "remove" as const, color: "red" as const },
      ],
      { message: header, subtitle, clearScreen: true, autoSelectSingle: false },
    )

    if (result === "models") {
      await showModels(account)
      continue
    }

    if (result === "remove") {
      const ok = await confirm(`Remove ${account.name}?`)
      if (!ok) continue
    }

    return result ?? "back"
  }
}

async function showModels(account: AccountInfo) {
  const available = account.modelList?.available ?? []
  const disabled = account.modelList?.disabled ?? []
  const items: MenuItem<string>[] = [
    { label: "Back", value: "back" },
    { label: "", value: "", separator: true },
  ]

  if (account.modelsError) {
    items.push({ label: `Error: ${account.modelsError}`, value: "err", disabled: true, color: "red" as const })
    items.push({ label: "Run Check models from the main menu", value: "hint", disabled: true })
  } else if (!account.modelList) {
    items.push({ label: "Models not checked", value: "hint", disabled: true })
    items.push({ label: "Run Check models from the main menu", value: "hint2", disabled: true })
  } else {
    items.push({ label: "Available", value: "", kind: "heading" })
    items.push(...available.map((name) => ({ label: name, value: name, color: "green" as const })))
    items.push({ label: "", value: "", separator: true })
    items.push({ label: "Disabled", value: "", kind: "heading" })
    items.push(...disabled.map((name) => ({ label: name, value: name, color: "red" as const })))
  }

  await select(items, {
    message: "Copilot models",
    subtitle: account.name,
    clearScreen: true,
    autoSelectSingle: false,
  })
}
