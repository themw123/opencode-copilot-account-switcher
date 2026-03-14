import type { Plugin } from "@opencode-ai/plugin"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { applyMenuAction } from "./plugin-actions.js"
import { buildPluginHooks } from "./plugin-hooks.js"
import { isTTY } from "./ui/ansi.js"
import { showAccountActions, showMenu, type AccountInfo } from "./ui/menu.js"
import { authPath, readAuth, readStore, writeStore, type AccountEntry, type StoreFile } from "./store.js"

function now() {
  return Date.now()
}

function getGitHubToken(entry: AccountEntry): string {
  // Prefer access token if it looks like a GitHub access token
  if (entry.access && (entry.access.startsWith("ghu_") || entry.access.startsWith("gho_") || entry.access.startsWith("ghp_") || entry.access.startsWith("github_pat_"))) {
    return entry.access
  }
  // Fallback to refresh if it looks like a GitHub access token
  if (entry.refresh && (entry.refresh.startsWith("ghu_") || entry.refresh.startsWith("gho_") || entry.refresh.startsWith("ghp_") || entry.refresh.startsWith("github_pat_"))) {
    return entry.refresh
  }
  // If refresh is a refresh token (ghr_), and access is not, it's safer to try access
  if (entry.refresh?.startsWith("ghr_") && entry.access && !entry.access.startsWith("ghr_")) {
    return entry.access
  }
  // Fallback to refresh then access
  return entry.refresh || entry.access
}

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function toInfo(name: string, entry: AccountEntry, index: number, active?: string): AccountInfo {
  const status = entry.expires && entry.expires > 0 && entry.expires < now() ? "expired" : "active"
  const labelName = name.startsWith("github.com:") ? name.slice("github.com:".length) : name
  const hasUser = entry.user ? labelName.includes(entry.user) : false
  const hasEmail = entry.email ? labelName.includes(entry.email) : false
  const suffix = entry.user
    ? hasUser
      ? ""
      : ` (${entry.user})`
    : entry.email
    ? ` (${entry.email})`
    : ""
  const label = `${labelName}${suffix}`
  return {
    name: label,
    index,
    addedAt: entry.addedAt,
    lastUsed: entry.lastUsed,
    status,
    isCurrent: active === name,
  }
}

async function promptText(message: string): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(message)
    return answer.trim()
  } finally {
    rl.close()
  }
}

async function promptAccountName(existing: string[]): Promise<string> {
  while (true) {
    const name = await promptText("Account name: ")
    if (!name) continue
    if (!existing.includes(name)) return name
    console.log(`Name already exists: ${name}`)
  }
}

async function promptAccountEntry(existing: string[]): Promise<{ name: string; entry: AccountEntry }> {
  const name = await promptAccountName(existing)
  const refresh = await promptText("OAuth refresh/access token: ")
  const access = await promptText("Copilot access token (optional, press Enter to skip): ")
  const expiresRaw = await promptText("Access token expires (unix ms, optional): ")
  const enterpriseUrl = await promptText("Enterprise URL (optional): ")
  const expires = Number(expiresRaw)
  const entry: AccountEntry = {
    name,
    refresh,
    access: access || refresh,
    expires: Number.isFinite(expires) ? expires : 0,
    enterpriseUrl: enterpriseUrl || undefined,
    addedAt: now(),
    source: "manual",
  }
  return { name, entry }
}

async function loginOauth(deployment: "github.com" | "enterprise", enterpriseUrl?: string): Promise<AccountEntry> {
  const domain = deployment === "enterprise" ? normalizeDomain(enterpriseUrl ?? "") : "github.com"
  const urls = getUrls(domain)
  const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user user:email",
    }),
  })

  if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

  const deviceData = (await deviceResponse.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
  }

  console.log(`Go to: ${deviceData.verification_uri}`)
  console.log(`Enter code: ${deviceData.user_code}`)

  while (true) {
    const response = await fetch(urls.ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) throw new Error("Failed to poll token")

    const data = (await response.json()) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (data.access_token) {
      const entry = {
        name: deployment === "enterprise" ? `enterprise:${domain}` : "github.com",
        refresh: data.access_token,
        access: data.access_token,
        expires: 0,
        enterpriseUrl: deployment === "enterprise" ? domain : undefined,
        addedAt: now(),
        source: "auth",
      } as AccountEntry
      const user = await fetchUser(entry)
      if (user?.login) entry.user = user.login
      if (user?.email) entry.email = user.email
      if (user?.orgs?.length) entry.orgs = user.orgs
      return entry
    }

    if (data.error === "authorization_pending") {
      await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
      continue
    }

    if (data.error === "slow_down") {
      const serverInterval = data.interval
      const next = (serverInterval && serverInterval > 0 ? serverInterval : deviceData.interval + 5) * 1000
      await sleep(next + OAUTH_POLLING_SAFETY_MARGIN_MS)
      continue
    }

    throw new Error("Authorization failed")
  }
}

async function promptFilePath(message: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${message} (${defaultValue}): `)
    return answer.trim() || defaultValue
  } finally {
    rl.close()
  }
}

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

function buildName(entry: AccountEntry, login?: string) {
  const user = login ?? entry.user
  if (!user) return entry.name
  if (!entry.enterpriseUrl) return user
  const host = normalizeDomain(entry.enterpriseUrl)
  return `${host}:${user}`
}

function score(entry: AccountEntry) {
  return (entry.user ? 2 : 0) + (entry.email ? 2 : 0) + (entry.orgs?.length ? 1 : 0)
}

function key(entry: AccountEntry) {
  if (entry.refresh) return `refresh:${entry.refresh}`
  return undefined
}

function dedupe(store: StoreFile) {
  const seen = new Map<string, string>()
  for (const [name, entry] of Object.entries(store.accounts)) {
    const k = key(entry)
    if (!k) continue
    const current = seen.get(k)
    if (!current) {
      seen.set(k, name)
      continue
    }
    const currentEntry = store.accounts[current]
    if (score(entry) > score(currentEntry)) {
      delete store.accounts[current]
      seen.set(k, name)
      if (store.active === current) store.active = name
      continue
    }
    delete store.accounts[name]
    if (store.active === name) store.active = current
  }
}

function mergeAuth(store: StoreFile, imported: Array<[string, AccountEntry]>) {
  dedupe(store)
  const byRefresh = new Map<string, string>()
  for (const [name, entry] of Object.entries(store.accounts)) {
    if (entry.refresh) byRefresh.set(entry.refresh, name)
  }
  for (const [key, entry] of imported) {
    const match = byRefresh.get(entry.refresh)
    if (match) {
      store.accounts[match] = {
        ...store.accounts[match],
        ...entry,
        name: store.accounts[match].name,
        source: "auth",
        providerId: key,
      }
      if (!store.active) store.active = match
      continue
    }
    const name = entry.name || `auth:${key}`
    store.accounts[name] = {
      ...entry,
      name,
      source: "auth",
      providerId: key,
    }
    if (!store.active) store.active = name
  }
}

function renameAccounts(store: StoreFile, items: Array<{ oldName: string; base: string; entry: AccountEntry }>) {
  const counts = new Map<string, number>()
  const renamed = items.map((item) => {
    const count = (counts.get(item.base) ?? 0) + 1
    counts.set(item.base, count)
    const name = count === 1 ? item.base : `${item.base}#${count}`
    return { ...item, name, entry: { ...item.entry, name } }
  })
  store.accounts = renamed.reduce((acc, item) => {
    acc[item.name] = item.entry
    return acc
  }, {} as Record<string, AccountEntry>)
  const active = renamed.find((item) => item.oldName === store.active)
  if (active) store.active = active.name
}

async function refreshIdentity(store: StoreFile) {
  const items = await Promise.all(
    Object.entries(store.accounts).map(async ([name, entry]) => {
      const user = await fetchUser(entry)
      const base = buildName(entry, user?.login ?? entry.user)
      return {
        oldName: name,
        base,
        entry: {
          ...entry,
          user: user?.login ?? entry.user,
          email: user?.email ?? entry.email,
          orgs: user?.orgs ?? entry.orgs,
          name: base,
        },
      }
    }),
  )
  renameAccounts(store, items)
}

async function fetchQuota(entry: AccountEntry): Promise<AccountEntry["quota"]> {
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
      updatedAt: now(),
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

async function fetchModels(entry: AccountEntry): Promise<AccountEntry["models"]> {
  try {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${entry.access}`,
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot/1.159.0",
      "Copilot-Integration-Id": "vscode-chat",
      "X-Github-Api-Version": "2025-04-01",
    }
    const modelsUrl = entry.enterpriseUrl
      ? `https://copilot-api.${normalizeDomain(entry.enterpriseUrl)}/models`
      : "https://api.githubcopilot.com/models"
    const modelRes = await fetch(modelsUrl, { headers })
    if (!modelRes.ok) {
      const base = entry.enterpriseUrl ? `https://api.${normalizeDomain(entry.enterpriseUrl)}` : "https://api.github.com"
      const tokenRes = await fetch(`${base}/copilot_internal/v2/token`, {
        headers: {
          Accept: "application/json",
          Authorization: `token ${getGitHubToken(entry)}`,
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "Editor-Version": "vscode/1.96.2",
          "Editor-Plugin-Version": "copilot/1.159.0",
          "X-Github-Api-Version": "2025-04-01",
        },
      })
      if (!tokenRes.ok) return { available: [], disabled: [], error: `token ${tokenRes.status}` }
      const tokenData = (await tokenRes.json()) as { token?: string; expires_at?: number }
      if (!tokenData.token) return { available: [], disabled: [], error: "token missing" }
      
      // Update entry with new session token
      entry.access = tokenData.token
      if (tokenData.expires_at) entry.expires = tokenData.expires_at * 1000

      const fallbackRes = await fetch(modelsUrl, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${tokenData.token}`,
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "Editor-Version": "vscode/1.96.2",
          "Editor-Plugin-Version": "copilot/1.159.0",
          "Copilot-Integration-Id": "vscode-chat",
          "X-Github-Api-Version": "2025-04-01",
        },
      })
      if (!fallbackRes.ok) return { available: [], disabled: [], error: `models ${fallbackRes.status}` }
      return parseModels((await fallbackRes.json()) as { data?: Array<{ id?: string; model_picker_enabled?: boolean; policy?: { state?: string } }> })
    }
    return parseModels((await modelRes.json()) as { data?: Array<{ id?: string; model_picker_enabled?: boolean; policy?: { state?: string } }> })
  } catch (error) {
    return { available: [], disabled: [], error: error instanceof Error ? error.message : String(error) }
  }
}

function parseModels(modelData: {
  data?: Array<{ id?: string; model_picker_enabled?: boolean; policy?: { state?: string } }>
}): AccountEntry["models"] {
  const available: string[] = []
  const disabled: string[] = []
  for (const item of modelData.data ?? []) {
    if (!item.id) continue
    const enabled = item.model_picker_enabled === true && item.policy?.state !== "disabled"
    if (enabled) available.push(item.id)
    else disabled.push(item.id)
  }
  return { available, disabled, updatedAt: now() }
}

async function fetchUser(entry: AccountEntry): Promise<{ login?: string; email?: string; orgs?: string[] } | undefined> {
  try {
    const base = entry.enterpriseUrl ? `https://api.${normalizeDomain(entry.enterpriseUrl)}` : "https://api.github.com"
    const headers = {
      Accept: "application/json",
      Authorization: `token ${getGitHubToken(entry)}`,
      "User-Agent": "GitHubCopilotChat/0.26.7",
    }
    const userRes = await fetch(`${base}/user`, { headers })
    if (!userRes.ok) return undefined
    const user = (await userRes.json()) as { login?: string; email?: string }
    let email = user.email
    if (!email) {
      const emailRes = await fetch(`${base}/user/emails`, { headers })
      if (emailRes.ok) {
        const items = (await emailRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>
        const primary = items.find((item) => item.primary && item.verified)
        email = primary?.email ?? items[0]?.email
      }
    }
    const orgRes = await fetch(`${base}/user/orgs`, { headers })
    const orgs = orgRes.ok ? ((await orgRes.json()) as Array<{ login?: string }>).map((o) => o.login).filter(Boolean) as string[] : undefined
    return { login: user.login, email, orgs }
  } catch {
    return undefined
  }
}

type AuthClient = {
  auth: {
    set: (input: {
      path: { id: string }
      body: {
        type: "oauth"
        refresh: string
        access: string
        expires: number
        enterpriseUrl?: string
      }
    }) => Promise<unknown>
  }
}

async function switchAccount(client: AuthClient, entry: AccountEntry) {
  const payload = {
    type: "oauth" as const,
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
    ...(entry.enterpriseUrl ? { enterpriseUrl: entry.enterpriseUrl } : {}),
  }
  await client.auth.set({
    path: { id: entry.enterpriseUrl ? "github-copilot-enterprise" : "github-copilot" },
    body: payload,
  })
}

export const CopilotAccountSwitcher: Plugin = async (input) => {
  const client = input.client
  const directory = input.directory
  const serverUrl = (input as { serverUrl?: URL }).serverUrl
  const methods = [
    {
      type: "oauth" as const,
      label: "Manage GitHub Copilot accounts",
      async authorize() {
        const entry = await runMenu()
        return {
          url: "",
          instructions: "",
          method: "auto" as const,
          async callback() {
            if (!entry) return { type: "failed" as const }
            return {
              type: "success" as const,
              provider: entry.enterpriseUrl ? "github-copilot-enterprise" : "github-copilot",
              refresh: entry.refresh,
              access: entry.access,
              expires: entry.expires,
              ...(entry.enterpriseUrl ? { enterpriseUrl: entry.enterpriseUrl } : {}),
            }
          },
        }
      },
    },
  ]

  async function runMenu(): Promise<AccountEntry | undefined> {
    const store = await readStore()
    const auth = await readAuth().catch(() => ({}))
    const imported = Object.entries(auth).filter(
      ([key]) => key === "github-copilot" || key === "github-copilot-enterprise",
    )
    if (imported.length > 0) {
      mergeAuth(store, imported)
      const preferred = imported.find(([key]) => key === "github-copilot") ?? imported[0]
      if (!store.active) store.active = preferred?.[1].name
    }

    if (!Object.entries(store.accounts).length) {
      const { name, entry } = await promptAccountEntry([])
      store.accounts[name] = entry
      store.active = name
      await writeStore(store)
      await switchAccount(client, entry)
      // fallthrough to menu
    }

    if (!Object.values(store.accounts).some((entry) => entry.user || entry.email || (entry.orgs && entry.orgs.length > 0))) {
      await refreshIdentity(store)
      dedupe(store)
      await writeStore(store)
    }

    if (!isTTY()) {
      console.log("Interactive menu requires a TTY terminal")
      return
    }

    let nextRefresh = 0
    while (true) {
      if (store.autoRefresh === true && now() >= nextRefresh) {
        const updated = await Promise.all(
          Object.entries(store.accounts).map(async ([name, entry]) => ({
            name,
            entry: {
              ...entry,
              quota: await fetchQuota(entry),
            },
          })),
        )
        for (const item of updated) {
          store.accounts[item.name] = item.entry
        }
        store.lastQuotaRefresh = now()
        await writeStore(store)
        nextRefresh = now() + (store.refreshMinutes ?? 15) * 60_000
      }
    const entries = Object.entries(store.accounts)
      const refreshed = await Promise.all(
        entries.map(async ([name, entry]) => {
          if (entry.user || entry.email || (entry.orgs && entry.orgs.length > 0)) return { name, entry }
          const user = await fetchUser(entry)
          return {
            name,
            entry: {
              ...entry,
              user: user?.login ?? entry.user,
              email: user?.email ?? entry.email,
              orgs: user?.orgs ?? entry.orgs,
            },
          }
        }),
      )
      for (const item of refreshed) {
        store.accounts[item.name] = item.entry
      }
      const accounts = entries.map(([name, entry], index) => ({
        ...toInfo(name, entry, index, store.active),
        source: entry.source,
        orgs: entry.orgs,
        plan: entry.quota?.plan,
        sku: entry.quota?.sku,
        reset: entry.quota?.reset,
        models: entry.models
          ? {
              enabled: entry.models.available.length,
              disabled: entry.models.disabled.length,
            }
          : undefined,
        modelsError: entry.models?.error,
        modelList: entry.models
          ? {
              available: entry.models.available,
              disabled: entry.models.disabled,
            }
          : undefined,
        quota: entry.quota?.snapshots
          ? {
              premium: entry.quota.snapshots.premium,
              chat: entry.quota.snapshots.chat,
              completions: entry.quota.snapshots.completions,
            }
          : undefined,
      }))
      const refresh = { enabled: store.autoRefresh === true, minutes: store.refreshMinutes ?? 15 }
      const action = await showMenu(
        accounts,
        refresh,
        store.lastQuotaRefresh,
        store.loopSafetyEnabled === true,
        store.networkRetryEnabled === true,
      )
      if (action.type === "cancel") {
        const active = store.active ? store.accounts[store.active] : undefined
        return active
      }
      if (await applyMenuAction({ action, store, writeStore })) {
        continue
      }
      if (action.type === "add") {
        const mode = await promptText("Add via device login? (y/n): ")
        const useDevice = mode.toLowerCase() === "y" || mode.toLowerCase() === "yes"
        if (useDevice) {
          const dep = await promptText("Enterprise? (y/n): ")
          const isEnterprise = dep.toLowerCase() === "y" || dep.toLowerCase() === "yes"
          const domain = isEnterprise ? await promptText("Enterprise URL or domain: ") : undefined
        const entry = await loginOauth(isEnterprise ? "enterprise" : "github.com", domain)
        const user = await fetchUser(entry)
        if (user?.login) entry.user = user.login
        if (user?.email) entry.email = user.email
        if (user?.orgs?.length) entry.orgs = user.orgs
        entry.name = buildName(entry, user?.login)
        store.accounts[entry.name] = entry
          store.active = store.active ?? entry.name
          await writeStore(store)
          if (store.active === entry.name) await switchAccount(client, entry)
          continue
        }

        const manual = await promptAccountEntry(Object.keys(store.accounts))
        const user = await fetchUser(manual.entry)
        if (user?.login) manual.entry.user = user.login
        if (user?.email) manual.entry.email = user.email
        if (user?.orgs?.length) manual.entry.orgs = user.orgs
        manual.entry.name = buildName(manual.entry, user?.login)
        store.accounts[manual.entry.name] = manual.entry
        store.active = store.active ?? manual.entry.name
        await writeStore(store)
        if (store.active === manual.entry.name) await switchAccount(client, manual.entry)
        continue
      }

      if (action.type === "import") {
        const file = await promptFilePath("auth.json path", authPath())
        const auth = await readAuth(file).catch(() => ({}))
        const imported = Object.entries(auth).filter(([key]) => key === "github-copilot" || key === "github-copilot-enterprise")
        for (const [key, entry] of imported) {
          const user = await fetchUser(entry)
          if (user?.login) entry.user = user.login
          if (user?.email) entry.email = user.email
          if (user?.orgs?.length) entry.orgs = user.orgs
          entry.name = buildName(entry, user?.login)
        }
        mergeAuth(store, imported)
        await writeStore(store)
        continue
      }

      if (action.type === "refresh-identity") {
        await refreshIdentity(store)
        dedupe(store)
        await writeStore(store)
        continue
      }

      if (action.type === "toggle-refresh") {
        store.autoRefresh = !store.autoRefresh
        store.refreshMinutes = store.refreshMinutes ?? 15
        await writeStore(store)
        continue
      }

      if (action.type === "set-interval") {
        const value = await promptText("Refresh interval (minutes): ")
        const minutes = Math.max(1, Math.min(180, Number(value)))
        if (Number.isFinite(minutes)) store.refreshMinutes = minutes
        await writeStore(store)
        continue
      }

      if (action.type === "quota") {
        const updated = await Promise.all(
          entries.map(async ([name, entry]) => ({
            name,
            entry: {
              ...entry,
              quota: await fetchQuota(entry),
            },
          })),
        )
        for (const item of updated) {
          store.accounts[item.name] = item.entry
        }
        store.lastQuotaRefresh = now()
        await writeStore(store)
        continue
      }

      if (action.type === "check-models") {
        const updated = await Promise.all(
          entries.map(async ([name, entry]) => ({
            name,
            entry: {
              ...entry,
              models: await fetchModels(entry),
            },
          })),
        )
        for (const item of updated) {
          store.accounts[item.name] = item.entry
        }
        await writeStore(store)
        continue
      }

      if (action.type === "remove-all") {
        store.accounts = {}
        store.active = undefined
        await writeStore(store)
        continue
      }

      if (action.type === "switch") {
        const selected = entries[action.account.index]
        if (!selected) continue
        const [name, entry] = selected
        const decision = await showAccountActions(action.account)
        if (decision === "back") continue
        if (decision === "remove") {
          delete store.accounts[name]
          if (store.active === name) store.active = undefined
          await writeStore(store)
          continue
        }
        await switchAccount(client, entry)
        store.active = name
        store.accounts[name].lastUsed = now()
        await writeStore(store)
        continue
      }
    }
  }

  return buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods,
    },
    client,
    directory,
    serverUrl,
  })
}
