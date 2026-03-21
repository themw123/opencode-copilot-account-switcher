type JsonRecord = Record<string, unknown>

export type OpenAIOAuthAuth = {
  type: "oauth"
  refresh?: string
  access?: string
  expires?: number
  accountId?: string
}

export type CodexAuthSource = {
  providerId: "openai"
  oauth: OpenAIOAuthAuth
  accountId?: string
  suggestedWriteBack?: {
    accountId: string
  }
}

function asRecord(input: unknown): JsonRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  return input as JsonRecord
}

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function decodeJwtPayload(token: string): JsonRecord | undefined {
  const parts = token.split(".")
  if (parts.length < 2) return undefined
  const payloadPart = parts[1]
  if (!payloadPart) return undefined
  try {
    const json = Buffer.from(payloadPart, "base64url").toString("utf8")
    return asRecord(JSON.parse(json))
  } catch {
    return undefined
  }
}

function extractAccountIdFromClaims(access: string | undefined): string | undefined {
  if (!access) return undefined
  const claims = decodeJwtPayload(access)
  if (!claims) return undefined
  return readString(claims.accountId) ?? readString(claims.account_id)
}

export function resolveCodexAuthSource(auth: unknown): CodexAuthSource | undefined {
  const authRecord = asRecord(auth)
  if (!authRecord) return undefined

  const openai = asRecord(authRecord.openai)
  if (!openai || openai.type !== "oauth") return undefined

  const oauth = openai as OpenAIOAuthAuth
  const directAccountId = readString(oauth.accountId)
  if (directAccountId) {
    return {
      providerId: "openai",
      oauth,
      accountId: directAccountId,
    }
  }

  const accountIdFromClaims = extractAccountIdFromClaims(readString(oauth.access))
  if (!accountIdFromClaims) {
    return {
      providerId: "openai",
      oauth,
    }
  }

  return {
    providerId: "openai",
    oauth,
    accountId: accountIdFromClaims,
    suggestedWriteBack: {
      accountId: accountIdFromClaims,
    },
  }
}
