import { createRequire } from "node:module"
import { loadJiti, type JitiLoader } from "./jiti-loader.js"

export type WeixinAccountHelpers = {
  listAccountIds: () => Promise<string[]>
  resolveAccount: (accountId: string) => Promise<{
    accountId: string
    enabled: boolean
    configured: boolean
    name?: string
    userId?: string
  }>
  describeAccount: (accountIdOrInput: string | { accountId: string }) => Promise<{
    accountId: string
    enabled: boolean
    configured: boolean
    name?: string
    userId?: string
  }>
}

type OpenClawAccountSourceHelpers = {
  listAccountIds: () => string[] | Promise<string[]>
  loadAccount: (accountId: string) => unknown | Promise<unknown>
  resolveAccount: (accountId: string) => unknown | Promise<unknown>
}

type OpenClawWeixinAccountsModule = {
  listIndexedWeixinAccountIds?: () => string[]
  loadWeixinAccount?: (accountId: string) => unknown
}

const OPENCLAW_WEIXIN_ACCOUNTS_MODULE = "@tencent-weixin/openclaw-weixin/src/auth/accounts.ts"

let accountJitiLoader: JitiLoader | null = null

async function getAccountJiti() {
  if (accountJitiLoader) {
    return accountJitiLoader
  }
  accountJitiLoader = (await loadJiti()).createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
  })
  return accountJitiLoader
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function deriveEnabled(resolved: Record<string, unknown>): boolean {
  return resolved.enabled === true
}

function isConfigured(resolved: Record<string, unknown>): boolean {
  return resolved.configured === true
}

function toAccountId(input: string | { accountId: string }): string {
  return typeof input === "string" ? input : input.accountId
}

export function createOpenClawAccountHelpers(input: OpenClawAccountSourceHelpers): WeixinAccountHelpers {
  const resolveStableAccount = async (accountId: string) => {
    const resolved = asObject(await input.resolveAccount(accountId))
    const stored = asObject(await input.loadAccount(accountId))
    return {
      accountId,
      enabled: deriveEnabled(resolved),
      configured: isConfigured(resolved),
      name: typeof resolved.name === "string" ? resolved.name : undefined,
      userId: typeof stored.userId === "string" ? stored.userId : undefined,
    }
  }

  return {
    async listAccountIds() {
      const ids = await input.listAccountIds()
      return Array.isArray(ids) ? ids.filter((it): it is string => typeof it === "string" && it.length > 0) : []
    },
    async resolveAccount(accountId: string) {
      return resolveStableAccount(accountId)
    },
    async describeAccount(accountIdOrInput: string | { accountId: string }) {
      return resolveStableAccount(toAccountId(accountIdOrInput))
    },
  }
}

export async function loadOpenClawAccountHelpers(options: {
  accountsModulePath?: string
} = {}): Promise<WeixinAccountHelpers> {
  const require = createRequire(import.meta.url)
  const accountsModulePath = require.resolve(options.accountsModulePath ?? OPENCLAW_WEIXIN_ACCOUNTS_MODULE)
  const accountsModule = (await getAccountJiti())(accountsModulePath) as OpenClawWeixinAccountsModule

  if (typeof accountsModule.listIndexedWeixinAccountIds !== "function" || typeof accountsModule.loadWeixinAccount !== "function") {
    throw new Error("[wechat-compat] account source helper unavailable")
  }

  return createOpenClawAccountHelpers({
    listAccountIds: () => accountsModule.listIndexedWeixinAccountIds!(),
    loadAccount: (accountId) => accountsModule.loadWeixinAccount!(accountId),
    resolveAccount: async (accountId) => {
      const stored = asObject(await accountsModule.loadWeixinAccount!(accountId))
      return {
        accountId,
        enabled: stored.enabled === false ? false : true,
        configured: typeof stored.token === "string" && stored.token.trim().length > 0,
      }
    },
  })
}
