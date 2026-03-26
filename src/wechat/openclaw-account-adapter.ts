type OpenClawAccountRaw = Record<string, unknown>

export type OpenClawWeixinAccountHelpers = {
  listAccountIds: () => Promise<string[]>
  resolveAccount: (accountId: string) => Promise<unknown>
  describeAccount: (accountIdOrInput: string | { accountId: string }) => Promise<unknown>
}

export type OpenClawLatestAccountState = {
  accountId: string
  token: string
  baseUrl: string
  getUpdatesBuf?: string
  userId?: string
  savedAt?: number
  boundAt?: number
}

export type OpenClawMenuAccount = {
  accountId: string
  name?: string
  enabled: boolean
  configured: boolean
  userId?: string
  boundAt?: number
}

type BuildOpenClawMenuAccountInput = {
  latestAccountState: OpenClawLatestAccountState | null
  accountHelpers: OpenClawWeixinAccountHelpers
}

function asObject(value: unknown): OpenClawAccountRaw {
  return value && typeof value === "object" ? (value as OpenClawAccountRaw) : {}
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value
  }
  return undefined
}

async function tryDescribeAccount(
  accountHelpers: OpenClawWeixinAccountHelpers,
  accountId: string,
): Promise<unknown> {
  try {
    const byString = await accountHelpers.describeAccount(accountId)
    if (byString !== undefined) {
      return byString
    }
  } catch {
    // fallback to object input
  }
  try {
    return await accountHelpers.describeAccount({ accountId })
  } catch {
    return undefined
  }
}

export async function buildOpenClawMenuAccount(input: BuildOpenClawMenuAccountInput): Promise<OpenClawMenuAccount | null> {
  const fallbackAccountId = firstNonEmptyString(input.latestAccountState?.accountId)
  const accountIds = await input.accountHelpers.listAccountIds()
  const accountId = firstNonEmptyString(fallbackAccountId, accountIds.at(-1))
  if (!accountId) {
    return null
  }

  const resolvedRaw = asObject(await input.accountHelpers.resolveAccount(accountId))
  const describedRaw = asObject(await tryDescribeAccount(input.accountHelpers, accountId))

  const enabled =
    toBoolean(resolvedRaw.enabled) ?? toBoolean(describedRaw.enabled) ?? false
  const configured =
    toBoolean(describedRaw.configured) ?? toBoolean(resolvedRaw.configured) ?? false

  const userId = firstNonEmptyString(
    input.latestAccountState?.userId,
    resolvedRaw.userId,
    describedRaw.userId,
  )
  const boundAt = [
    input.latestAccountState?.boundAt,
    resolvedRaw.boundAt,
    describedRaw.boundAt,
  ].find((value): value is number => typeof value === "number" && Number.isFinite(value))

  return {
    accountId,
    name: firstNonEmptyString(resolvedRaw.name, describedRaw.name),
    enabled,
    configured,
    userId,
    boundAt,
  }
}
