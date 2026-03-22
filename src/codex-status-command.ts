import { resolveCodexAuthSource, type OpenAIOAuthAuth } from "./codex-auth-source.js"
import { fetchCodexStatus, type CodexStatusFetcherResult, type CodexStatusSnapshot } from "./codex-status-fetcher.js"
import {
  getActiveCodexAccount,
  normalizeCodexStore,
  readCodexStore,
  writeCodexStore,
  type CodexStoreFile,
} from "./codex-store.js"
import { getCodexDisplayName, recoverInvalidCodexAccount } from "./codex-invalid-account.js"
import { readAuth, type AccountEntry } from "./store.js"

type ToastVariant = "info" | "success" | "warning" | "error"

type ToastClient = {
  tui?: {
    showToast?: (options: {
      body: {
        message: string
        variant: ToastVariant
      }
      query?: undefined
    }) => Promise<unknown>
  }
  auth?: {
    get?: (input: {
      path: {
        id: string
      }
      throwOnError?: boolean
    }) => Promise<unknown>
    set?: (input: {
      path: {
        id: string
      }
      body: {
        type: "oauth"
        refresh?: string
        access?: string
        expires?: number
        accountId?: string
      }
    }) => Promise<unknown>
  }
}

type AuthPayload = {
  openai?: OpenAIOAuthAuth
} & Record<string, unknown>

type AuthEntries = Record<string, AccountEntry>

export class CodexStatusCommandHandledError extends Error {
  constructor() {
    super("codex-status-command-handled")
    this.name = "CodexStatusCommandHandledError"
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

async function showToast(input: {
  client?: ToastClient
  message: string
  variant: ToastVariant
}) {
  const tui = input.client?.tui
  const show = input.client?.tui?.showToast
  if (!show) return
  try {
    await show.call(tui, {
      body: {
        message: input.message,
        variant: input.variant,
      },
    })
  } catch {
    // fail open for toast dispatch
  }
}

function ratio(remaining?: number, entitlement?: number) {
  if (remaining === undefined && entitlement === undefined) return "n/a"
  return `${remaining ?? "n/a"}/${entitlement ?? "n/a"}`
}

function value(value: string | number | undefined) {
  return value === undefined ? "n/a" : String(value)
}

function pickDisplayName(input: {
  workspaceName?: string
  name?: string
  email?: string
  accountId?: string
}) {
  return input.workspaceName
    ?? input.name
    ?? input.email
    ?? input.accountId
}

function pickWorkspaceLabel(input: {
  workspaceName?: string
  email?: string
  accountId?: string
  name?: string
}) {
  return input.workspaceName
    ?? input.email
    ?? input.accountId
    ?? input.name
}

function renderWindow(label: string, window: {
  remaining?: number
  entitlement?: number
}) {
  if (window.entitlement === 100 && window.remaining !== undefined) {
    return `${label}: ${window.remaining}% left`
  }
  return `${label}: ${ratio(window.remaining, window.entitlement)}`
}

function renderStatus(status: CodexStatusSnapshot) {
  const identity = status.identity as { accountId?: string; email?: string; workspaceName?: string }
  return [
    `账号: ${value(identity.accountId ?? identity.email)}`,
    `Workspace: ${value(pickWorkspaceLabel({
      workspaceName: identity.workspaceName,
      email: identity.email,
      accountId: identity.accountId,
    }))}`,
    renderWindow("5h", status.windows.primary),
    renderWindow("week", status.windows.secondary),
  ].join("\n")
}

function renderCachedStatus(store: CodexStoreFile) {
  const active = getActiveCodexAccount(store)
  const entry = active?.entry
  const snapshot = entry?.snapshot
  return [
    `账号: ${value(entry?.accountId ?? active?.name ?? entry?.email)}`,
    `Workspace: ${value(pickWorkspaceLabel({
      workspaceName: entry?.workspaceName,
      name: entry?.name ?? active?.name,
      email: entry?.email,
      accountId: entry?.accountId,
    }))}`,
    renderWindow("5h", snapshot?.usage5h ?? {}),
    renderWindow("week", snapshot?.usageWeek ?? {}),
  ].join("\n")
}

function getCachedAccountForSource(store: CodexStoreFile, input: {
  accountId?: string
}) {
  const accountId = input.accountId
  if (accountId) {
    const match = Object.entries(store.accounts).find(([, entry]) => entry.accountId === accountId)
    if (match) {
      return {
        name: match[0],
        entry: match[1],
      }
    }
  }
  return getActiveCodexAccount(store)
}

function renderCachedStatusForAccount(store: CodexStoreFile, input: {
  accountId?: string
}) {
  const active = getCachedAccountForSource(store, input)
  const entry = active?.entry
  const snapshot = entry?.snapshot
  return [
    `账号: ${value(entry?.accountId ?? active?.name ?? entry?.email)}`,
    `Workspace: ${value(pickWorkspaceLabel({
      workspaceName: entry?.workspaceName,
      name: entry?.name ?? active?.name,
      email: entry?.email,
      accountId: entry?.accountId,
    }))}`,
    renderWindow("5h", snapshot?.usage5h ?? {}),
    renderWindow("week", snapshot?.usageWeek ?? {}),
  ].join("\n")
}

function hasCachedStore(store: CodexStoreFile) {
  const active = getActiveCodexAccount(store)
  const entry = active?.entry
  const usage5h = entry?.snapshot?.usage5h
  return Boolean(
    active
    || entry?.accountId
    || entry?.email
    || entry?.snapshot?.plan
    || usage5h?.entitlement !== undefined
    || usage5h?.remaining !== undefined,
  )
}

async function defaultLoadAuth(client?: ToastClient): Promise<AuthPayload | undefined> {
  return defaultLoadAuthWithFallback({
    client,
    readAuthEntries: readAuth,
  })
}

function mapAuthEntryToOpenAI(entry: AccountEntry | undefined): OpenAIOAuthAuth | undefined {
  if (!entry) return undefined
  return {
    type: "oauth",
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
    accountId: entry.accountId,
  }
}

async function defaultLoadAuthWithFallback(input: {
  client?: ToastClient
  readAuthEntries: () => Promise<AuthEntries>
}): Promise<AuthPayload | undefined> {
  const client = input.client
  const authClient = client?.auth
  const getAuth = client?.auth?.get

  if (getAuth) {
    try {
      const result = await getAuth.call(authClient, { path: { id: "openai" }, throwOnError: true })
      const withData = asRecord(result)?.data
      const payload = asRecord(withData) ?? asRecord(result)
      if (payload) {
        return {
          openai: payload as OpenAIOAuthAuth,
        }
      }
    } catch {
      // fall through to auth.json fallback
    }
  }

  const authEntries = await input.readAuthEntries().catch(() => ({} as AuthEntries))
  const openai = mapAuthEntryToOpenAI(authEntries.openai)
  if (!openai) return undefined

  return {
    openai,
  }
}

async function defaultPersistAuth(client: ToastClient | undefined, auth: AuthPayload): Promise<void> {
  const authClient = client?.auth
  const setAuth = client?.auth?.set
  if (!setAuth) return

  const openai = asRecord(auth.openai)
  if (!openai) return

  await setAuth.call(authClient, {
    path: { id: "openai" },
    body: {
      type: "oauth",
      refresh: pickString(openai.refresh),
      access: pickString(openai.access),
      expires: pickNumber(openai.expires),
      accountId: pickString(openai.accountId),
    },
  })
}

function patchAuth(auth: AuthPayload | undefined, patch: {
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
}) {
  const base = asRecord(auth) ?? {}
  const openai = asRecord(base.openai) ?? { type: "oauth" }
  return {
    ...base,
    openai: {
      ...openai,
      type: "oauth",
      ...(patch.access !== undefined ? { access: patch.access } : {}),
      ...(patch.refresh !== undefined ? { refresh: patch.refresh } : {}),
      ...(patch.expires !== undefined ? { expires: patch.expires } : {}),
      ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
    },
  } as AuthPayload
}

export async function handleCodexStatusCommand(input: {
  client?: ToastClient
  loadAuth?: () => Promise<AuthPayload | undefined>
  readAuthEntries?: () => Promise<AuthEntries>
  persistAuth?: (auth: AuthPayload) => Promise<void>
  fetchStatus?: (input: {
    oauth: OpenAIOAuthAuth
    accountId?: string
  }) => Promise<CodexStatusFetcherResult>
  readStore?: () => Promise<CodexStoreFile>
  writeStore?: (store: CodexStoreFile) => Promise<void>
}): Promise<never> {
  const loadAuth = input.loadAuth ?? (() => defaultLoadAuthWithFallback({
    client: input.client,
    readAuthEntries: input.readAuthEntries ?? readAuth,
  }))
  const persistAuth = input.persistAuth ?? ((nextAuth) => defaultPersistAuth(input.client, nextAuth))
  const fetchStatus = input.fetchStatus ?? ((next) => fetchCodexStatus(next))
  const readStore = input.readStore ?? (() => readCodexStore())
  const writeStore = input.writeStore ?? ((store) => writeCodexStore(store))

  await showToast({
    client: input.client,
    message: "Fetching Codex status...",
    variant: "info",
  })

  const auth = await loadAuth().catch(() => undefined)
  const source = resolveCodexAuthSource(auth)
  if (!source) {
    await showToast({
      client: input.client,
      message: "OpenAI OAuth auth is missing for Codex status.",
      variant: "error",
    })
    throw new CodexStatusCommandHandledError()
  }

  const fetched = await fetchStatus({
    oauth: source.oauth,
    accountId: source.accountId,
  }).catch((error: unknown) => ({
    ok: false,
    error: {
      kind: "network_error",
      message: error instanceof Error ? error.message : String(error),
    },
  } as CodexStatusFetcherResult))

  if (!fetched.ok) {
    if (fetched.error.kind === "invalid_account") {
      const currentRaw = await readStore().catch(() => ({}))
      const currentStore = normalizeCodexStore(currentRaw)
      const invalid = getCachedAccountForSource(currentStore, { accountId: source.accountId })
      const invalidName = invalid?.name ?? currentStore.active
      if (invalidName && currentStore.accounts[invalidName]) {
        const recovered = await recoverInvalidCodexAccount({
          store: currentStore,
          invalidAccountName: invalidName,
          setAuth: input.client?.auth?.set
            ? async (next) => {
              const authClient = input.client?.auth
              const setAuth = input.client?.auth?.set
              if (!setAuth) return
              await setAuth.call(authClient, next)
            }
            : undefined,
        })
        await writeStore(recovered.store)

        const removedDisplay = getCodexDisplayName(invalid?.entry, recovered.removed)
        const messageLines = [`无效账号${removedDisplay}已移除，请及时检查核对`]
        if (recovered.replacement) {
          const replacementEntry = recovered.store.accounts[recovered.replacement]
          const replacementDisplay = getCodexDisplayName(replacementEntry, recovered.replacement)
          const replacementWeekRemaining = replacementEntry?.snapshot?.usageWeek?.remaining ?? 0
          const replacement5hRemaining = replacementEntry?.snapshot?.usage5h?.remaining ?? 0
          messageLines.push(`已切换到${replacementDisplay}`)
          if (recovered.weekRecoveryOnly || (replacementWeekRemaining > 0 && replacement5hRemaining <= 0)) {
            messageLines.push("请检查账号状态")
          }
        }
        await showToast({
          client: input.client,
          message: messageLines.join("\n"),
          variant: "warning",
        })
        throw new CodexStatusCommandHandledError()
      }
    }

    const cachedRaw = await readStore().catch(() => ({}))
    const cached = normalizeCodexStore(cachedRaw)
    if (hasCachedStore(cached)) {
      await showToast({
        client: input.client,
        message: `Codex status fetch failed: ${fetched.error.message}`,
        variant: "warning",
      })
      await showToast({
        client: input.client,
        message: renderCachedStatusForAccount(cached, { accountId: source.accountId }),
        variant: "warning",
      })
    } else {
      await showToast({
        client: input.client,
        message: `Codex status fetch failed: ${fetched.error.message}`,
        variant: "error",
      })
    }
    throw new CodexStatusCommandHandledError()
  }

  if (fetched.authPatch) {
    const nextAuth = patchAuth(auth, fetched.authPatch)
    await persistAuth(nextAuth).catch(async (error) => {
      await showToast({
        client: input.client,
        message: `Codex auth refresh succeeded but auth persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        variant: "warning",
      })
    })
  }

  const previousRaw = await readStore().catch(() => ({} as CodexStoreFile))
  const previousStore = normalizeCodexStore(previousRaw)
  const previousActive = getActiveCodexAccount(previousStore)
  const nextActive = fetched.status.identity.accountId
    ?? source.accountId
    ?? previousActive?.entry.accountId
    ?? previousActive?.name
    ?? "default"
  const previousEntry = previousStore.accounts[nextActive] ?? {}

  const nextStore: CodexStoreFile = {
    ...previousStore,
    active: nextActive,
    lastSnapshotRefresh: fetched.status.updatedAt,
    accounts: {
      ...previousStore.accounts,
      [nextActive]: {
        ...previousEntry,
        name: previousEntry.name ?? nextActive,
        providerId: previousEntry.providerId ?? "codex",
        accountId: fetched.status.identity.accountId ?? previousEntry.accountId ?? source.accountId,
        email: fetched.status.identity.email ?? previousEntry.email,
        workspaceName: (fetched.status.identity as { workspaceName?: string }).workspaceName ?? previousEntry.workspaceName,
        lastUsed: fetched.status.updatedAt,
        snapshot: {
          ...(previousEntry.snapshot ?? {}),
          plan: fetched.status.identity.plan ?? previousEntry.snapshot?.plan,
          usage5h: {
            entitlement: fetched.status.windows.primary.entitlement,
            remaining: fetched.status.windows.primary.remaining,
            used: fetched.status.windows.primary.used,
            resetAt: fetched.status.windows.primary.resetAt,
          },
          usageWeek: {
            entitlement: fetched.status.windows.secondary.entitlement,
            remaining: fetched.status.windows.secondary.remaining,
            used: fetched.status.windows.secondary.used,
            resetAt: fetched.status.windows.secondary.resetAt,
          },
          updatedAt: fetched.status.updatedAt,
        },
      },
    },
  }
  await writeStore(nextStore)

  await showToast({
    client: input.client,
    message: renderStatus(fetched.status),
    variant: "success",
  })
  throw new CodexStatusCommandHandledError()
}
