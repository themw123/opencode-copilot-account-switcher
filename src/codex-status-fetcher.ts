import type { OpenAIOAuthAuth } from "./codex-auth-source.js"

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"

type JsonRecord = Record<string, unknown>

export type CodexWindowSnapshot = {
  entitlement?: number
  remaining?: number
  used?: number
  resetAt?: number
}

export type CodexStatusSnapshot = {
  identity: {
    accountId?: string
    email?: string
    plan?: string
  }
  windows: {
    primary: CodexWindowSnapshot
    secondary: CodexWindowSnapshot
  }
  credits: {
    total?: number
    remaining?: number
    used?: number
  }
  updatedAt: number
}

export type CodexStatusError =
  | {
      kind: "rate_limited"
      status: 429
      message: string
    }
  | {
      kind: "timeout"
      message: string
    }
  | {
      kind: "server_error"
      status: number
      message: string
    }
  | {
      kind: "invalid_response"
      message: string
    }
  | {
      kind: "unauthorized"
      status: 401
      message: string
    }
  | {
      kind: "network_error"
      message: string
    }

export type CodexStatusFetcherResult =
  | {
      ok: true
      status: CodexStatusSnapshot
      authPatch?: {
        access?: string
        refresh?: string
        expires?: number
        accountId?: string
      }
    }
  | {
      ok: false
      error: CodexStatusError
    }

type AuthPatch = {
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
}

function asRecord(input: unknown): JsonRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  return input as JsonRecord
}

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function readNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function pickRecord(source: JsonRecord, keys: string[]): JsonRecord | undefined {
  for (const key of keys) {
    const value = asRecord(source[key])
    if (value) return value
  }
  return undefined
}

function pickWindow(source: JsonRecord, key: "primary" | "secondary"): CodexWindowSnapshot {
  const windows = pickRecord(source, ["windows", "usage_windows", "quota_windows"])
  const block = windows ? asRecord(windows[key]) : undefined
  const fallback = asRecord(source[key])
  const raw = block ?? fallback
  if (!raw) {
    return {
      entitlement: undefined,
      remaining: undefined,
      used: undefined,
      resetAt: undefined,
    }
  }

  return {
    entitlement: readNumber(raw.entitlement),
    remaining: readNumber(raw.remaining),
    used: readNumber(raw.used),
    resetAt: readNumber(raw.resetAt ?? raw.reset_at),
  }
}

function normalizeUsageStatus(payload: unknown, now: () => number): CodexStatusSnapshot {
  const source = asRecord(payload) ?? {}
  const account = pickRecord(source, ["account", "identity", "user"]) ?? {}
  const credits = pickRecord(source, ["credits", "credit_balance", "credit"]) ?? {}

  return {
    identity: {
      accountId: readString(account.id) ?? readString(source.account_id) ?? readString(source.accountId),
      email: readString(account.email) ?? readString(source.email),
      plan: readString(account.plan) ?? readString(source.plan),
    },
    windows: {
      primary: pickWindow(source, "primary"),
      secondary: pickWindow(source, "secondary"),
    },
    credits: {
      total: readNumber(credits.total),
      remaining: readNumber(credits.remaining),
      used: readNumber(credits.used),
    },
    updatedAt: now(),
  }
}

async function parseJsonResponse(response: Response): Promise<unknown | undefined> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/json")) return undefined
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const err = error as { name?: unknown; message?: unknown }
  if (err.name === "AbortError") return true
  const message = typeof err.message === "string" ? err.message.toLowerCase() : ""
  return message.includes("timeout")
}

function buildHeaders(input: { access?: string; accountId?: string }): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": "Codex CLI",
  })
  if (input.access) headers.set("Authorization", `Bearer ${input.access}`)
  if (input.accountId) headers.set("ChatGPT-Account-Id", input.accountId)
  return headers
}

async function requestUsage(input: {
  oauth: OpenAIOAuthAuth
  accountId?: string
  fetchImpl: typeof globalThis.fetch
}): Promise<Response> {
  return input.fetchImpl(CODEX_USAGE_URL, {
    method: "GET",
    headers: buildHeaders({
      access: input.oauth.access,
      accountId: input.accountId,
    }),
  })
}

export async function fetchCodexStatus(input: {
  oauth: OpenAIOAuthAuth
  accountId?: string
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
  refreshTokens?: (oauth: OpenAIOAuthAuth) => Promise<OpenAIOAuthAuth | undefined>
}): Promise<CodexStatusFetcherResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const now = input.now ?? Date.now
  const explicitAccountId = input.accountId

  let oauth = input.oauth
  let authPatch: AuthPatch | undefined

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response
    try {
      response = await requestUsage({
        oauth,
        accountId: explicitAccountId ?? oauth.accountId,
        fetchImpl,
      })
    } catch (error) {
      if (isTimeoutError(error)) {
        return {
          ok: false,
          error: {
            kind: "timeout",
            message: "codex usage request timed out",
          },
        }
      }

      return {
        ok: false,
        error: {
          kind: "network_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    if (response.status === 401 && attempt === 0 && input.refreshTokens) {
      let refreshed: OpenAIOAuthAuth | undefined
      try {
        refreshed = await input.refreshTokens(oauth)
      } catch (error) {
        return {
          ok: false,
          error: {
            kind: "network_error",
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
      if (!refreshed || !refreshed.access) {
        return {
          ok: false,
          error: {
            kind: "unauthorized",
            status: 401,
            message: "codex usage request unauthorized",
          },
        }
      }
      oauth = refreshed
      authPatch = {
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        accountId: refreshed.accountId,
      }
      continue
    }

    if (response.status === 429) {
      return {
        ok: false,
        error: {
          kind: "rate_limited",
          status: 429,
          message: "codex usage request was rate limited",
        },
      }
    }

    if (response.status >= 500 && response.status <= 599) {
      return {
        ok: false,
        error: {
          kind: "server_error",
          status: response.status,
          message: "codex usage request failed with server error",
        },
      }
    }

    if (response.status === 401) {
      return {
        ok: false,
        error: {
          kind: "unauthorized",
          status: 401,
          message: "codex usage request unauthorized",
        },
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: "network_error",
          message: `codex usage request failed with status ${response.status}`,
        },
      }
    }

    const payload = await parseJsonResponse(response)
    if (payload === undefined) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "codex usage response was not json",
        },
      }
    }

    return {
      ok: true,
      status: normalizeUsageStatus(payload, now),
      ...(authPatch ? { authPatch } : {}),
    }
  }

  return {
    ok: false,
    error: {
      kind: "unauthorized",
      status: 401,
      message: "codex usage request unauthorized",
    },
  }
}
