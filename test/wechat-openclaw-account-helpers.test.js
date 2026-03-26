import test from "node:test"
import assert from "node:assert/strict"

const DIST_ACCOUNT_HELPERS_MODULE = "../dist/wechat/compat/openclaw-account-helpers.js"

test("account helper wrapper reads account source helpers and returns stable account info", async () => {
  const mod = await import(DIST_ACCOUNT_HELPERS_MODULE)

  const helpers = mod.createOpenClawAccountHelpers({
    listAccountIds: () => ["acc-real"],
    loadAccount: () => ({ token: "token", baseUrl: "https://ilinkai.weixin.qq.com", userId: "user-real" }),
    resolveAccount: () => ({ accountId: "acc-real", enabled: true, configured: true, name: "Real" }),
  })

  assert.deepEqual(await helpers.listAccountIds(), ["acc-real"])
  assert.deepEqual(await helpers.resolveAccount("acc-real"), {
    accountId: "acc-real",
    enabled: true,
    configured: true,
    name: "Real",
    userId: "user-real",
  })
})

test("account helper wrapper derives configured from stored token when source omits it", async () => {
  const mod = await import(DIST_ACCOUNT_HELPERS_MODULE)

  const helpers = mod.createOpenClawAccountHelpers({
    listAccountIds: () => ["", "acc-token", 1, null],
    loadAccount: () => ({ token: "token-from-store", userId: "user-token" }),
    resolveAccount: () => ({ accountId: "acc-token", enabled: true }),
  })

  assert.deepEqual(await helpers.listAccountIds(), ["acc-token"])
  assert.deepEqual(await helpers.resolveAccount("acc-token"), {
    accountId: "acc-token",
    enabled: true,
    configured: true,
    name: undefined,
    userId: "user-token",
  })
})

test("account helper wrapper derives enabled from source/stored fields instead of hardcoded true", async () => {
  const mod = await import(DIST_ACCOUNT_HELPERS_MODULE)

  const helpers = mod.createOpenClawAccountHelpers({
    listAccountIds: () => ["acc-disabled", "acc-inactive"],
    loadAccount: (accountId) => (accountId === "acc-disabled" ? { userId: "u-a" } : { userId: "u-b", disabled: true }),
    resolveAccount: (accountId) => (accountId === "acc-disabled" ? { enabled: false } : {}),
  })

  assert.deepEqual(await helpers.resolveAccount("acc-disabled"), {
    accountId: "acc-disabled",
    enabled: false,
    configured: false,
    name: undefined,
    userId: "u-a",
  })
  assert.deepEqual(await helpers.resolveAccount("acc-inactive"), {
    accountId: "acc-inactive",
    enabled: false,
    configured: false,
    name: undefined,
    userId: "u-b",
  })
})

test("describeAccount works when extracted without this binding", async () => {
  const mod = await import(DIST_ACCOUNT_HELPERS_MODULE)

  const helpers = mod.createOpenClawAccountHelpers({
    listAccountIds: () => ["acc-free"],
    loadAccount: () => ({ token: "tok", userId: "user-free" }),
    resolveAccount: () => ({ accountId: "acc-free", enabled: true, configured: true, name: "Free" }),
  })

  const describeAccount = helpers.describeAccount
  assert.deepEqual(await describeAccount({ accountId: "acc-free" }), {
    accountId: "acc-free",
    enabled: true,
    configured: true,
    name: "Free",
    userId: "user-free",
  })
})
