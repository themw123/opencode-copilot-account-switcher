import { resolveCodexAuthSource, type OpenAIOAuthAuth } from "./codex-auth-source.js"
import { fetchCodexStatus, type CodexStatusFetcherResult, type CodexStatusSnapshot } from "./codex-status-fetcher.js"
import { readCodexStore, writeCodexStore, type CodexStoreFile } from "./codex-store.js"

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
  const show = input.client?.tui?.showToast
  if (!show) return
  try {
    await show({
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

function renderStatus(status: CodexStatusSnapshot) {
  return [
    "Codex status updated.",
    "[identity]",
    `account: ${value(status.identity.accountId)}`,
    `email: ${value(status.identity.email)}`,
    `plan: ${value(status.identity.plan)}`,
    "[usage]",
    `primary: ${ratio(status.windows.primary.remaining, status.windows.primary.entitlement)}`,
    `secondary: ${ratio(status.windows.secondary.remaining, status.windows.secondary.entitlement)}`,
    `credits: ${ratio(status.credits.remaining, status.credits.total)}`,
  ].join("\n")
}

function renderCachedStatus(store: CodexStoreFile) {
  return [
    "[identity]",
    `account: ${value(store.account?.id ?? store.activeAccountId)}`,
    `email: ${value(store.account?.email ?? store.activeEmail)}`,
    `plan: ${value(store.account?.plan)}`,
    "[usage]",
    `primary: ${ratio(store.status?.premium?.remaining, store.status?.premium?.entitlement)}`,
    "secondary: n/a",
    "credits: n/a",
  ].join("\n")
}

function hasCachedStore(store: CodexStoreFile) {
  return Boolean(
    store.activeAccountId
    || store.activeEmail
    || store.account?.id
    || store.account?.email
    || store.account?.plan
    || store.status?.premium?.entitlement !== undefined
    || store.status?.premium?.remaining !== undefined,
  )
}

async function defaultLoadAuth(client?: ToastClient): Promise<AuthPayload | undefined> {
  const getAuth = client?.auth?.get
  if (!getAuth) return undefined

  try {
    const result = await getAuth({ path: { id: "openai" }, throwOnError: true })
    const withData = asRecord(result)?.data
    const payload = asRecord(withData) ?? asRecord(result)
    if (!payload) return undefined
    return {
      openai: payload as OpenAIOAuthAuth,
    }
  } catch {
    return undefined
  }
}

async function defaultPersistAuth(client: ToastClient | undefined, auth: AuthPayload): Promise<void> {
  const setAuth = client?.auth?.set
  if (!setAuth) return

  const openai = asRecord(auth.openai)
  if (!openai) return

  await setAuth({
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
  persistAuth?: (auth: AuthPayload) => Promise<void>
  fetchStatus?: (input: {
    oauth: OpenAIOAuthAuth
    accountId?: string
  }) => Promise<CodexStatusFetcherResult>
  readStore?: () => Promise<CodexStoreFile>
  writeStore?: (store: CodexStoreFile) => Promise<void>
}): Promise<never> {
  const loadAuth = input.loadAuth ?? (() => defaultLoadAuth(input.client))
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
    const cached = await readStore().catch(() => ({}))
    if (hasCachedStore(cached)) {
      await showToast({
        client: input.client,
        message: `Codex status fetch failed (${fetched.error.message}); showing cached snapshot.\n${renderCachedStatus(cached)}`,
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

  const previousStore = await readStore().catch(() => ({} as CodexStoreFile))
  const nextStore: CodexStoreFile = {
    ...previousStore,
    activeProvider: "codex",
    activeAccountId: fetched.status.identity.accountId ?? source.accountId ?? previousStore.activeAccountId,
    activeEmail: fetched.status.identity.email ?? previousStore.activeEmail,
    lastStatusRefresh: fetched.status.updatedAt,
    account: {
      id: fetched.status.identity.accountId ?? previousStore.account?.id,
      email: fetched.status.identity.email ?? previousStore.account?.email,
      plan: fetched.status.identity.plan ?? previousStore.account?.plan,
    },
    status: {
      premium: {
        entitlement: fetched.status.windows.primary.entitlement,
        remaining: fetched.status.windows.primary.remaining,
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
