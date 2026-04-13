import { ANSI } from "./ansi.js"
import { select, type MenuItem } from "./select.js"
import { confirm } from "./confirm.js"
import { readCommonSettingsStore, type CommonSettingsStore } from "../common-settings-store.js"
import { readOperatorBinding, type OperatorBinding } from "../wechat/operator-store.js"

export type AccountStatus = "active" | "expired" | "unknown"

export interface AccountInfo {
  name: string
  workspaceName?: string
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
  | { type: "assign-models" }
  | { type: "toggle-refresh" }
  | { type: "set-interval" }
  | { type: "toggle-loop-safety" }
  | { type: "toggle-loop-safety-provider-scope" }
  | { type: "toggle-experimental-slash-commands" }
  | { type: "toggle-network-retry" }
  | { type: "wechat-menu" }
  | { type: "wechat-bind" }
  | { type: "wechat-rebind" }
  | { type: "wechat-export-debug-bundle-menu" }
  | { type: "wechat-export-debug-bundle"; mode: "sanitized" | "full" }
  | { type: "toggle-wechat-notifications" }
  | { type: "toggle-wechat-question-notify" }
  | { type: "toggle-wechat-permission-notify" }
  | { type: "toggle-wechat-session-error-notify" }
  | { type: "toggle-synthetic-agent-initiator" }
  | { type: "switch"; account: AccountInfo }
  | { type: "remove"; account: AccountInfo }
  | { type: "remove-all" }
  | { type: "cancel" }

export type MenuLanguage = "en"

export type MenuProvider = "copilot" | "codex"

export type MenuWechatPrimaryBinding = {
  accountId: string
  userId?: string
  name?: string
  enabled?: boolean
  configured?: boolean
  boundAt?: number
}

export type MenuWechatOperatorBinding = {
  wechatAccountId: string
  userId: string
  boundAt: number
}

export type ShowMenuInput = {
  provider?: MenuProvider
  refresh?: { enabled: boolean; minutes: number }
  lastQuotaRefresh?: number
  modelAccountAssignmentCount?: number
  loopSafetyEnabled?: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
  networkRetryEnabled?: boolean
  wechatNotificationsEnabled?: boolean
  wechatQuestionNotifyEnabled?: boolean
  wechatPermissionNotifyEnabled?: boolean
  wechatSessionErrorNotifyEnabled?: boolean
  wechatPrimaryBinding?: MenuWechatPrimaryBinding
  wechatOperatorBinding?: MenuWechatOperatorBinding
  syntheticAgentInitiatorEnabled?: boolean
  experimentalSlashCommandsEnabled?: boolean
  capabilities?: Partial<MenuCapabilities>
  language?: MenuLanguage
}

type MenuCapabilities = {
  importAuth: boolean
  quota: boolean
  refreshIdentity: boolean
  checkModels: boolean
  assignModels: boolean
  loopSafety: boolean
  policyScope: boolean
  experimentalSlashCommands: boolean
  networkRetry: boolean
  syntheticAgentInitiator: boolean
  wechatNotificationsMenu: boolean
}

function defaultMenuCapabilities(provider: MenuProvider): MenuCapabilities {
  if (provider === "codex") {
    return {
        importAuth: false,
        quota: true,
        refreshIdentity: false,
        checkModels: false,
        assignModels: false,
      loopSafety: true,
      policyScope: true,
      experimentalSlashCommands: true,
      networkRetry: true,
      syntheticAgentInitiator: false,
      wechatNotificationsMenu: true,
    }
  }
  return {
    importAuth: true,
    quota: true,
    refreshIdentity: true,
    checkModels: true,
    assignModels: true,
    loopSafety: true,
    policyScope: true,
    experimentalSlashCommands: true,
    networkRetry: true,
    syntheticAgentInitiator: true,
    wechatNotificationsMenu: true,
  }
}

export function getMenuCopy(provider: MenuProvider = "copilot") {
  if (provider === "codex") {
    return {
      menuTitle: "OpenAI Codex accounts",
      menuSubtitle: "Select an action or account",
      actionsHeading: "Actions",
      commonSettingsHeading: "Common settings",
      providerSettingsHeading: "Provider settings",
      addAccount: "Add account",
      addAccountHint: "OpenAI OAuth login",
      importAuth: "Import from auth.json",
      checkQuotas: "Refresh snapshots",
      refreshIdentity: "Sync account identity",
      checkModels: "Sync available models",
      assignModels: "Assign one account per model",
      autoRefreshOn: "Auto refresh: On",
      autoRefreshOff: "Auto refresh: Off",
      setRefresh: "Set refresh interval",
      loopSafetyOn: "Guided Loop Safety: On",
      loopSafetyOff: "Guided Loop Safety: Off",
      loopSafetyHint: "Reduce unnecessary handoff replies while work can continue",
      policyScopeCopilotOnly: "Policy default scope: Current provider only",
      policyScopeAllModels: "Policy default scope: All models",
      policyScopeHint: "Choose whether Guided Loop Safety applies only to Codex by default or to all models",
      experimentalSlashCommandsOn: "Experimental slash commands: On",
      experimentalSlashCommandsOff: "Experimental slash commands: Off",
      experimentalSlashCommandsHint: "Controls whether /codex-status is registered",
      retryOn: "Network Retry: On",
      retryOff: "Network Retry: Off",
      retryHint: "Helps recover some requests after retries or malformed responses",
      syntheticInitiatorOn: "Send synthetic messages as agent: On",
      syntheticInitiatorOff: "Send synthetic messages as agent: Off",
      syntheticInitiatorHint: "Changes upstream behavior; misuse may increase billing risk or trigger abuse signals",
      wechatNotificationsHeading: "WeChat notifications",
      wechatBind: "Bind / Rebind WeChat",
      wechatExportDebugBundle: "Export WeChat debug bundle",
      wechatDebugBundleModeTitle: "Choose debug bundle type",
      wechatDebugBundleSanitized: "Sanitized bundle",
      wechatDebugBundleFull: "Full bundle",
      wechatNotificationsOn: "WeChat notifications: On",
      wechatNotificationsOff: "WeChat notifications: Off",
      wechatQuestionNotifyOn: "Question notifications: On",
      wechatQuestionNotifyOff: "Question notifications: Off",
      wechatPermissionNotifyOn: "Permission notifications: On",
      wechatPermissionNotifyOff: "Permission notifications: Off",
      wechatSessionErrorNotifyOn: "Session error notifications: On",
      wechatSessionErrorNotifyOff: "Session error notifications: Off",
      accountsHeading: "Accounts",
      dangerHeading: "Danger zone",
      removeAll: "Remove all accounts",
    }
  }
  
  return {
    menuTitle: "GitHub Copilot accounts",
    menuSubtitle: "Select an action or account",
    actionsHeading: "Actions",
    commonSettingsHeading: "Common settings",
    providerSettingsHeading: "Provider settings",
    addAccount: "Add account",
    addAccountHint: "device login or manual",
    importAuth: "Import from auth.json",
    checkQuotas: "Refresh quota info",
    refreshIdentity: "Sync account identity",
    checkModels: "Sync available models",
    assignModels: "Assign one account per model",
    autoRefreshOn: "Auto refresh: On",
    autoRefreshOff: "Auto refresh: Off",
    setRefresh: "Set refresh interval",
    loopSafetyOn: "Guided Loop Safety: On",
    loopSafetyOff: "Guided Loop Safety: Off",
    loopSafetyHint: "Reduce unnecessary handoff replies while work can continue",
    policyScopeCopilotOnly: "Policy default scope: Copilot only",
    policyScopeAllModels: "Policy default scope: All models",
    policyScopeHint: "Choose whether Guided Loop Safety applies only to Copilot by default or to all models",
    experimentalSlashCommandsOn: "Experimental slash commands: On",
    experimentalSlashCommandsOff: "Experimental slash commands: Off",
    experimentalSlashCommandsHint:
      "Controls whether /copilot-status, /copilot-compact, /copilot-stop-tool, /copilot-inject, and /copilot-policy-all-models are registered",
    retryOn: "Network Retry: On",
    retryOff: "Network Retry: Off",
    retryHint: "Helps recover some requests after retries or malformed responses",
    syntheticInitiatorOn: "Send synthetic messages as agent: On",
    syntheticInitiatorOff: "Send synthetic messages as agent: Off",
    syntheticInitiatorHint: "Changes upstream behavior; misuse may increase billing risk or trigger abuse signals",
     wechatNotificationsHeading: "WeChat notifications",
     wechatBind: "Bind / Rebind WeChat",
     wechatExportDebugBundle: "Export WeChat debug bundle",
     wechatDebugBundleModeTitle: "Choose debug bundle type",
     wechatDebugBundleSanitized: "Sanitized bundle",
     wechatDebugBundleFull: "Full bundle",
     wechatNotificationsOn: "WeChat notifications: On",
     wechatNotificationsOff: "WeChat notifications: Off",
     wechatQuestionNotifyOn: "Question notifications: On",
    wechatQuestionNotifyOff: "Question notifications: Off",
    wechatPermissionNotifyOn: "Permission notifications: On",
    wechatPermissionNotifyOff: "Permission notifications: Off",
    wechatSessionErrorNotifyOn: "Session error notifications: On",
    wechatSessionErrorNotifyOff: "Session error notifications: Off",
    accountsHeading: "Accounts",
    dangerHeading: "Danger zone",
    removeAll: "Remove all accounts",
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
  provider?: MenuProvider
  accounts: AccountInfo[]
  refresh?: { enabled: boolean; minutes: number }
  lastQuotaRefresh?: number
  modelAccountAssignmentCount?: number
  loopSafetyEnabled: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
  networkRetryEnabled: boolean
  wechatNotificationsEnabled?: boolean
  wechatQuestionNotifyEnabled?: boolean
  wechatPermissionNotifyEnabled?: boolean
  wechatSessionErrorNotifyEnabled?: boolean
  wechatPrimaryBinding?: MenuWechatPrimaryBinding
  wechatOperatorBinding?: MenuWechatOperatorBinding
  syntheticAgentInitiatorEnabled?: boolean
  experimentalSlashCommandsEnabled?: boolean
  capabilities?: Partial<MenuCapabilities>
  language?: MenuLanguage
}): MenuItem<MenuAction>[] {
  const provider = input.provider ?? "copilot"
  const copy = getMenuCopy(provider)
  const capabilities = {
    ...defaultMenuCapabilities(provider),
    ...input.capabilities,
  }
  if (provider === "codex") {
    capabilities.refreshIdentity = false
    capabilities.checkModels = false
    capabilities.assignModels = false
    capabilities.syntheticAgentInitiator = false
  }
  const quotaHint = input.lastQuotaRefresh ? `last ${formatRelativeTime(input.lastQuotaRefresh)}` : undefined
  const loopSafetyProviderScope = input.loopSafetyProviderScope ?? "copilot-only"
  const experimentalSlashCommandsEnabled = input.experimentalSlashCommandsEnabled !== false
  const wechatNotificationsEnabled = input.wechatNotificationsEnabled !== false
  const wechatQuestionNotifyEnabled = input.wechatQuestionNotifyEnabled !== false
  const wechatPermissionNotifyEnabled = input.wechatPermissionNotifyEnabled !== false
  const wechatSessionErrorNotifyEnabled = input.wechatSessionErrorNotifyEnabled !== false

  const providerActions: MenuItem<MenuAction>[] = [
    { label: copy.actionsHeading, value: { type: "cancel" }, kind: "heading" },
    { label: copy.addAccount, value: { type: "add" }, color: "cyan", hint: copy.addAccountHint },
  ]

  if (capabilities.importAuth) {
    providerActions.push({ label: copy.importAuth, value: { type: "import" }, color: "cyan" })
  }
  if (capabilities.quota) {
    providerActions.push({ label: copy.checkQuotas, value: { type: "quota" }, color: "cyan", hint: quotaHint })
  }
  if (capabilities.refreshIdentity) {
    providerActions.push({ label: copy.refreshIdentity, value: { type: "refresh-identity" }, color: "cyan" })
  }
  if (capabilities.checkModels) {
    providerActions.push({ label: copy.checkModels, value: { type: "check-models" }, color: "cyan" })
  }
  if (capabilities.assignModels) {
    providerActions.push({
      label: copy.assignModels,
      value: { type: "assign-models" },
      color: "cyan",
      hint: input.modelAccountAssignmentCount ? `${input.modelAccountAssignmentCount} models` : undefined,
    })
  }

  const commonSettings: MenuItem<MenuAction>[] = [
    { label: copy.commonSettingsHeading, value: { type: "cancel" }, kind: "heading" },
    {
      label: input.loopSafetyEnabled ? copy.loopSafetyOn : copy.loopSafetyOff,
      value: { type: "toggle-loop-safety" },
      color: "cyan",
      hint: copy.loopSafetyHint,
      disabled: !capabilities.loopSafety,
    },
    {
      label: loopSafetyProviderScope === "all-models" ? copy.policyScopeAllModels : copy.policyScopeCopilotOnly,
      value: { type: "toggle-loop-safety-provider-scope" },
      color: "cyan",
      hint: copy.policyScopeHint,
      disabled: !capabilities.policyScope,
    },
    {
      label: experimentalSlashCommandsEnabled ? copy.experimentalSlashCommandsOn : copy.experimentalSlashCommandsOff,
      value: { type: "toggle-experimental-slash-commands" },
      color: "cyan",
      hint: copy.experimentalSlashCommandsHint,
      disabled: !capabilities.experimentalSlashCommands,
    },
    {
      label: input.networkRetryEnabled ? copy.retryOn : copy.retryOff,
      value: { type: "toggle-network-retry" },
      color: "cyan",
      hint: copy.retryHint,
      disabled: !capabilities.networkRetry,
    },
    {
      label: copy.wechatNotificationsHeading,
      value: { type: "wechat-menu" },
      color: "cyan",
      disabled: !capabilities.wechatNotificationsMenu,
    },
  ]

  const providerSettings: MenuItem<MenuAction>[] = [
    { label: copy.providerSettingsHeading, value: { type: "cancel" }, kind: "heading" },
  ]

  providerSettings.push({
    label: input.refresh?.enabled ? copy.autoRefreshOn : copy.autoRefreshOff,
    value: { type: "toggle-refresh" },
    color: "cyan",
    hint: input.refresh ? `${input.refresh.minutes}m` : undefined,
  })
  providerSettings.push({ label: copy.setRefresh, value: { type: "set-interval" }, color: "cyan" })
  if (capabilities.syntheticAgentInitiator) {
    providerSettings.push({
      label: input.syntheticAgentInitiatorEnabled ? copy.syntheticInitiatorOn : copy.syntheticInitiatorOff,
      value: { type: "toggle-synthetic-agent-initiator" },
      color: "cyan",
      hint: copy.syntheticInitiatorHint,
    })
  }

  return [
    ...providerActions,
    { label: "", value: { type: "cancel" }, separator: true },
    ...commonSettings,
    { label: "", value: { type: "cancel" }, separator: true },
    ...providerSettings,
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
        account.workspaceName,
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

function buildWechatSubmenuItems(copy: ReturnType<typeof getMenuCopy>, input: {
  wechatNotificationsEnabled: boolean
  wechatQuestionNotifyEnabled: boolean
  wechatPermissionNotifyEnabled: boolean
  wechatSessionErrorNotifyEnabled: boolean
  wechatPrimaryBinding?: MenuWechatPrimaryBinding
  wechatOperatorBinding?: MenuWechatOperatorBinding
  capabilities: MenuCapabilities
}): MenuItem<MenuAction>[] {
  const backLabel = "Back"
  const effectiveBinding = input.wechatPrimaryBinding
    ? {
        accountId: input.wechatPrimaryBinding.accountId,
        userId: input.wechatPrimaryBinding.userId,
        name: input.wechatPrimaryBinding.name,
        enabled: input.wechatPrimaryBinding.enabled,
        configured: input.wechatPrimaryBinding.configured,
        boundAt: input.wechatPrimaryBinding.boundAt,
      }
    : input.wechatOperatorBinding
    ? {
        accountId: input.wechatOperatorBinding.wechatAccountId,
        userId: input.wechatOperatorBinding.userId,
        boundAt: input.wechatOperatorBinding.boundAt,
      }
    : undefined
  const bindActionType = effectiveBinding ? "wechat-rebind" : "wechat-bind"
  const bindingRows: MenuItem<MenuAction>[] = []
  if (effectiveBinding) {
    const boundAtText = effectiveBinding.boundAt
      ? new Date(effectiveBinding.boundAt).toLocaleString()
      : "unknown"
    bindingRows.push(
      { label: "Current binding", value: { type: "cancel" }, kind: "heading" },
      {
        label: `accountId: ${effectiveBinding.accountId}`,
        value: { type: "cancel" },
        disabled: true,
      },
      ...(effectiveBinding.name
        ? [{ label: `name: ${effectiveBinding.name}`, value: { type: "cancel" }, disabled: true } as MenuItem<MenuAction>]
        : []),
      ...(effectiveBinding.userId
        ? [{ label: `userId: ${effectiveBinding.userId}`, value: { type: "cancel" }, disabled: true } as MenuItem<MenuAction>]
        : []),
      {
        label: `enabled: ${effectiveBinding.enabled === true ? "true" : "false"}`,
        value: { type: "cancel" },
        disabled: true,
      },
      {
        label: `configured: ${effectiveBinding.configured === true ? "true" : "false"}`,
        value: { type: "cancel" },
        disabled: true,
      },
      {
        label: `boundAt: ${boundAtText}`,
        value: { type: "cancel" },
        disabled: true,
      },
      { label: "", value: { type: "cancel" }, separator: true },
    )
  }
  return [
    { label: backLabel, value: { type: "cancel" } },
    { label: "", value: { type: "cancel" }, separator: true },
    ...bindingRows,
    { label: copy.wechatNotificationsHeading, value: { type: "cancel" }, kind: "heading" },
    {
      label: copy.wechatBind,
      value: { type: bindActionType },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
    {
      label: copy.wechatExportDebugBundle,
      value: { type: "wechat-export-debug-bundle-menu" },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
    {
      label: input.wechatNotificationsEnabled ? copy.wechatNotificationsOn : copy.wechatNotificationsOff,
      value: { type: "toggle-wechat-notifications" },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
    {
      label: input.wechatQuestionNotifyEnabled ? copy.wechatQuestionNotifyOn : copy.wechatQuestionNotifyOff,
      value: { type: "toggle-wechat-question-notify" },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
    {
      label: input.wechatPermissionNotifyEnabled ? copy.wechatPermissionNotifyOn : copy.wechatPermissionNotifyOff,
      value: { type: "toggle-wechat-permission-notify" },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
    {
      label: input.wechatSessionErrorNotifyEnabled ? copy.wechatSessionErrorNotifyOn : copy.wechatSessionErrorNotifyOff,
      value: { type: "toggle-wechat-session-error-notify" },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
  ]
}

function buildWechatDebugBundleModeItems(copy: ReturnType<typeof getMenuCopy>, input: {
  capabilities: MenuCapabilities
}): MenuItem<MenuAction>[] {
  const backLabel = "Back"
  return [
    { label: backLabel, value: { type: "cancel" } },
    { label: "", value: { type: "cancel" }, separator: true },
    {
      label: copy.wechatDebugBundleSanitized,
      value: { type: "wechat-export-debug-bundle", mode: "sanitized" },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
    {
      label: copy.wechatDebugBundleFull,
      value: { type: "wechat-export-debug-bundle", mode: "full" },
      color: "cyan",
      disabled: !input.capabilities.wechatNotificationsMenu,
    },
  ]
}

export async function showMenu(
  accounts: AccountInfo[],
  input: ShowMenuInput = {},
): Promise<MenuAction> {
  return showMenuWithDeps(accounts, input)
}

function pickPrimaryBindingFromSettings(settings: CommonSettingsStore | undefined): MenuWechatPrimaryBinding | undefined {
  const primary = settings?.wechat?.primaryBinding
  if (!primary?.accountId) return undefined
  return {
    accountId: primary.accountId,
    userId: primary.userId,
    name: primary.name,
    enabled: primary.enabled,
    configured: primary.configured,
    boundAt: primary.boundAt,
  }
}

function pickOperatorBinding(binding: OperatorBinding | undefined): MenuWechatOperatorBinding | undefined {
  if (!binding) return undefined
  return {
    wechatAccountId: binding.wechatAccountId,
    userId: binding.userId,
    boundAt: binding.boundAt,
  }
}

export async function showMenuWithDeps(
  accounts: AccountInfo[],
  input: ShowMenuInput = {},
  deps: {
    select?: typeof select
    confirm?: typeof confirm
    showAccountActions?: typeof showAccountActions
    readCommonSettings?: () => Promise<CommonSettingsStore>
    readOperatorBinding?: () => Promise<OperatorBinding | undefined>
  } = {},
): Promise<MenuAction> {
  const selectMenu = deps.select ?? select
  const confirmAction = deps.confirm ?? confirm
  const showAccountActionMenu = deps.showAccountActions ?? showAccountActions
  let currentLanguage = "en" as const

  while (true) {
    const provider = input.provider ?? "copilot"
    const copy = getMenuCopy(provider)
    const items = buildMenuItems({
      provider,
      accounts,
      refresh: input.refresh,
      lastQuotaRefresh: input.lastQuotaRefresh,
      modelAccountAssignmentCount: input.modelAccountAssignmentCount,
      loopSafetyEnabled: input.loopSafetyEnabled === true,
      loopSafetyProviderScope: input.loopSafetyProviderScope,
      networkRetryEnabled: input.networkRetryEnabled === true,
      wechatNotificationsEnabled: input.wechatNotificationsEnabled,
      wechatQuestionNotifyEnabled: input.wechatQuestionNotifyEnabled,
      wechatPermissionNotifyEnabled: input.wechatPermissionNotifyEnabled,
      wechatSessionErrorNotifyEnabled: input.wechatSessionErrorNotifyEnabled,
      syntheticAgentInitiatorEnabled: input.syntheticAgentInitiatorEnabled === true,
      experimentalSlashCommandsEnabled: input.experimentalSlashCommandsEnabled,
      capabilities: input.capabilities,
      language: currentLanguage,
    })
    const result = await selectMenu(items, {
      message: copy.menuTitle,
      subtitle: copy.menuSubtitle,
      clearScreen: true,
    })

    if (!result) return { type: "cancel" }
    if (result.type === "wechat-menu") {
      const [commonSettings, operatorBinding] = await Promise.all([
        input.wechatPrimaryBinding || input.wechatOperatorBinding
          ? Promise.resolve(undefined)
          : (deps.readCommonSettings ?? readCommonSettingsStore)().catch(() => undefined),
        input.wechatOperatorBinding
          ? Promise.resolve(undefined)
          : (deps.readOperatorBinding ?? readOperatorBinding)().catch(() => undefined),
      ])

      const capabilities = {
        ...defaultMenuCapabilities(provider),
        ...input.capabilities,
      }

      while (true) {
        const wechatItems = buildWechatSubmenuItems(copy, {
          wechatNotificationsEnabled: input.wechatNotificationsEnabled !== false,
          wechatQuestionNotifyEnabled: input.wechatQuestionNotifyEnabled !== false,
          wechatPermissionNotifyEnabled: input.wechatPermissionNotifyEnabled !== false,
          wechatSessionErrorNotifyEnabled: input.wechatSessionErrorNotifyEnabled !== false,
          wechatPrimaryBinding: input.wechatPrimaryBinding ?? pickPrimaryBindingFromSettings(commonSettings),
          wechatOperatorBinding: input.wechatOperatorBinding ?? pickOperatorBinding(operatorBinding),
          capabilities,
        })
        const wechatResult = await selectMenu(wechatItems, {
          message: copy.wechatNotificationsHeading,
          subtitle: copy.menuSubtitle,
          clearScreen: true,
        })
        if (!wechatResult || wechatResult.type === "cancel") {
          break
        }
        if (wechatResult.type === "wechat-export-debug-bundle-menu") {
          const debugBundleMode = await selectMenu(buildWechatDebugBundleModeItems(copy, {
            capabilities,
          }), {
            message: copy.wechatExportDebugBundle,
            subtitle: copy.wechatDebugBundleModeTitle,
            clearScreen: true,
          })
          if (!debugBundleMode || debugBundleMode.type === "cancel") {
            continue
          }
          return debugBundleMode
        }
        return wechatResult
      }
      continue
    }
    if (result.type === "switch") {
      const next = await showAccountActionMenu(result.account, { provider })
      if (next === "back") continue
      return { type: next, account: result.account }
    }
    if (result.type === "remove-all") {
      const ok = await confirmAction("Remove ALL accounts? This cannot be undone.")
      if (!ok) continue
    }
    return result
  }
}

export function buildAccountActionItems(account: AccountInfo, input: {
  provider?: MenuProvider
} = {}): MenuItem<"switch" | "remove" | "back" | "models">[] {
  const provider = input.provider ?? "copilot"
  const modelAction = provider === "copilot" && (account.modelList || account.modelsError)
    ? [{ label: "View models", value: "models" as const, color: "cyan" as const }]
    : []

  return [
    { label: "Back", value: "back" as const },
    ...modelAction,
    { label: "Switch to this account", value: "switch" as const, color: "cyan" as const },
    { label: "Remove this account", value: "remove" as const, color: "red" as const },
  ]
}

export async function showAccountActions(account: AccountInfo, input: {
  provider?: MenuProvider
} = {}): Promise<"switch" | "remove" | "back"> {
  const provider = input.provider ?? "copilot"
  const badge = getStatusBadge(account.status)
  const header = `${account.name}${badge ? " " + badge : ""}`
  const info = [
    `Added: ${formatDate(account.addedAt)} | Last used: ${formatRelativeTime(account.lastUsed)}`,
    account.plan ? `Plan: ${account.plan}` : undefined,
    account.sku ? `SKU: ${account.sku}` : undefined,
    account.reset ? `Reset: ${account.reset}` : undefined,
    provider === "copilot" && account.models ? `Models: ${account.models.enabled}/${account.models.enabled + account.models.disabled}` : undefined,
    account.orgs?.length ? `Orgs: ${account.orgs.slice(0, 2).join(",")}` : undefined,
    provider === "copilot" && account.modelsError ? `Models error: ${account.modelsError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
  const subtitle = info

  while (true) {
    const result = await select(
      buildAccountActionItems(account, { provider }),
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
