import { ANSI } from "./ansi.js"
import { select, type MenuItem } from "./select.js"
import { confirm } from "./confirm.js"

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
  | { type: "toggle-language" }
  | { type: "toggle-loop-safety" }
  | { type: "toggle-network-retry" }
  | { type: "toggle-synthetic-agent-initiator" }
  | { type: "switch"; account: AccountInfo }
  | { type: "remove"; account: AccountInfo }
  | { type: "remove-all" }
  | { type: "cancel" }

export type MenuLanguage = "zh" | "en"

export function getMenuCopy(language: MenuLanguage = "zh") {
  if (language === "en") {
    return {
      menuTitle: "GitHub Copilot accounts",
      menuSubtitle: "Select an action or account",
      switchLanguageLabel: "切换到中文",
      actionsHeading: "Actions",
      addAccount: "Add account",
      addAccountHint: "device login or manual",
      importAuth: "Import from auth.json",
      checkQuotas: "Check quotas",
      refreshIdentity: "Refresh identity",
      checkModels: "Check models",
      enableRefresh: "Enable auto refresh",
      disableRefresh: "Disable auto refresh",
      setRefresh: "Set refresh interval",
      enableLoopSafety: "Enable guided loop safety",
      disableLoopSafety: "Disable guided loop safety",
      loopSafetyHint: "Prompt-guided: fewer report interruptions, less unnecessary waiting",
      enableRetry: "Enable Copilot network retry",
      disableRetry: "Disable Copilot network retry",
      retryHint: "Overrides official fetch path; may drift from upstream",
      enableSyntheticInitiator: "Enable agent initiator for synthetic messages",
      disableSyntheticInitiator: "Disable agent initiator for synthetic messages",
      syntheticInitiatorHint: "Differs from upstream behavior; misuse can be treated as abuse and may trigger unexpected billing",
      accountsHeading: "Accounts",
      dangerHeading: "Danger zone",
      removeAll: "Remove all accounts",
    }
  }

  return {
    menuTitle: "GitHub Copilot 账号",
    menuSubtitle: "请选择操作或账号",
    switchLanguageLabel: "Switch to English",
    actionsHeading: "操作",
    addAccount: "添加账号",
    addAccountHint: "设备登录或手动录入",
    importAuth: "从 auth.json 导入",
    checkQuotas: "检查配额",
    refreshIdentity: "刷新身份信息",
    checkModels: "检查模型",
    enableRefresh: "开启自动刷新",
    disableRefresh: "关闭自动刷新",
    setRefresh: "设置刷新间隔",
    enableLoopSafety: "开启 Guided Loop Safety",
    disableLoopSafety: "关闭 Guided Loop Safety",
    loopSafetyHint: "提示词引导：减少汇报打断与不必要等待",
    enableRetry: "开启 Copilot Network Retry",
    disableRetry: "关闭 Copilot Network Retry",
    retryHint: "包装官方 fetch；可能随 upstream 产生漂移",
    enableSyntheticInitiator: "开启 synthetic 消息的 agent initiator",
    disableSyntheticInitiator: "关闭 synthetic 消息的 agent initiator",
    syntheticInitiatorHint: "与 upstream 行为存在差异；滥用可能被视为 abuse，并带来 unexpected billing 风险",
    accountsHeading: "账号",
    dangerHeading: "危险操作",
    removeAll: "删除全部账号",
  }
}

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

export function buildMenuItems(input: {
  accounts: AccountInfo[]
  refresh?: { enabled: boolean; minutes: number }
  lastQuotaRefresh?: number
  loopSafetyEnabled: boolean
  networkRetryEnabled: boolean
  syntheticAgentInitiatorEnabled?: boolean
  language?: MenuLanguage
}): MenuItem<MenuAction>[] {
  const copy = getMenuCopy(input.language)
  const quotaHint = input.lastQuotaRefresh ? `last ${formatRelativeTime(input.lastQuotaRefresh)}` : undefined

  return [
    { label: copy.actionsHeading, value: { type: "cancel" }, kind: "heading" },
    { label: copy.switchLanguageLabel, value: { type: "toggle-language" }, color: "cyan" },
    { label: copy.addAccount, value: { type: "add" }, color: "cyan", hint: copy.addAccountHint },
    { label: copy.importAuth, value: { type: "import" }, color: "cyan" },
    { label: copy.checkQuotas, value: { type: "quota" }, color: "cyan", hint: quotaHint },
    { label: copy.refreshIdentity, value: { type: "refresh-identity" }, color: "cyan" },
    { label: copy.checkModels, value: { type: "check-models" }, color: "cyan" },
    {
      label: input.refresh?.enabled ? copy.disableRefresh : copy.enableRefresh,
      value: { type: "toggle-refresh" },
      color: "cyan",
      hint: input.refresh ? `${input.refresh.minutes}m` : undefined,
    },
    { label: copy.setRefresh, value: { type: "set-interval" }, color: "cyan" },
    {
      label: input.loopSafetyEnabled ? copy.disableLoopSafety : copy.enableLoopSafety,
      value: { type: "toggle-loop-safety" },
      color: "cyan",
      hint: copy.loopSafetyHint,
    },
    {
      label: input.networkRetryEnabled ? copy.disableRetry : copy.enableRetry,
      value: { type: "toggle-network-retry" },
      color: "cyan",
      hint: copy.retryHint,
    },
    {
      label: input.syntheticAgentInitiatorEnabled ? copy.disableSyntheticInitiator : copy.enableSyntheticInitiator,
      value: { type: "toggle-synthetic-agent-initiator" },
      color: "cyan",
      hint: copy.syntheticInitiatorHint,
    },
    { label: "", value: { type: "cancel" }, separator: true },
    { label: copy.accountsHeading, value: { type: "cancel" }, kind: "heading" },
    ...input.accounts.map((account) => {
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
    { label: copy.dangerHeading, value: { type: "cancel" }, kind: "heading" },
    { label: copy.removeAll, value: { type: "remove-all" }, color: "red" },
  ]
}

export async function showMenu(
  accounts: AccountInfo[],
  input: {
    refresh?: { enabled: boolean; minutes: number }
    lastQuotaRefresh?: number
    loopSafetyEnabled?: boolean
    networkRetryEnabled?: boolean
    syntheticAgentInitiatorEnabled?: boolean
    language?: MenuLanguage
  } = {},
): Promise<MenuAction> {
  let currentLanguage = input.language ?? "zh"

  while (true) {
    const copy = getMenuCopy(currentLanguage)
    const items = buildMenuItems({
      accounts,
      refresh: input.refresh,
      lastQuotaRefresh: input.lastQuotaRefresh,
      loopSafetyEnabled: input.loopSafetyEnabled === true,
      networkRetryEnabled: input.networkRetryEnabled === true,
      syntheticAgentInitiatorEnabled: input.syntheticAgentInitiatorEnabled === true,
      language: currentLanguage,
    })
    const result = await select(items, {
      message: copy.menuTitle,
      subtitle: copy.menuSubtitle,
      clearScreen: true,
    })

    if (!result) return { type: "cancel" }
    if (result.type === "toggle-language") {
      currentLanguage = currentLanguage === "zh" ? "en" : "zh"
      continue
    }
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
