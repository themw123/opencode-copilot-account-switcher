import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, writeFile } from "node:fs/promises"

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

test("account helper wrapper keeps configured false when source omits it", async () => {
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
    configured: false,
    name: undefined,
    userId: "user-token",
  })
})

test("account helper wrapper only trusts explicit enabled boolean from resolveAccount", async () => {
  const mod = await import(DIST_ACCOUNT_HELPERS_MODULE)

  const helpers = mod.createOpenClawAccountHelpers({
    listAccountIds: () => ["acc-disabled", "acc-default"],
    loadAccount: (accountId) => (accountId === "acc-disabled" ? { userId: "u-a" } : { userId: "u-b" }),
    resolveAccount: (accountId) => (accountId === "acc-disabled" ? { enabled: false } : {}),
  })

  assert.deepEqual(await helpers.resolveAccount("acc-disabled"), {
    accountId: "acc-disabled",
    enabled: false,
    configured: false,
    name: undefined,
    userId: "u-a",
  })
  assert.deepEqual(await helpers.resolveAccount("acc-default"), {
    accountId: "acc-default",
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

test("account helper wrapper rejects non-boolean enabled/configured values", async () => {
  const mod = await import(DIST_ACCOUNT_HELPERS_MODULE)

  const helpers = mod.createOpenClawAccountHelpers({
    listAccountIds: () => ["acc-strict"],
    loadAccount: () => ({ token: "token-from-store", userId: "user-strict" }),
    resolveAccount: () => ({ accountId: "acc-strict", enabled: 1, configured: 1 }),
  })

  assert.deepEqual(await helpers.resolveAccount("acc-strict"), {
    accountId: "acc-strict",
    enabled: false,
    configured: false,
    name: undefined,
    userId: "user-strict",
  })
})

test("loadOpenClawAccountHelpers assembles stable enabled/configured for real module path", async () => {
  const mod = await import(DIST_ACCOUNT_HELPERS_MODULE)

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-account-helpers-"))
  const modulePath = path.join(tempDir, "accounts-module.mjs")
  await writeFile(
    modulePath,
    [
      "export function listIndexedWeixinAccountIds() { return ['acc-runtime'] }",
      "export function loadWeixinAccount(accountId) {",
      "  return { accountId, token: 'runtime-token', userId: 'runtime-user' }",
      "}",
    ].join("\n"),
    "utf8",
  )

  const helpers = await mod.loadOpenClawAccountHelpers({
    accountsModulePath: modulePath,
  })

  assert.deepEqual(await helpers.resolveAccount("acc-runtime"), {
    accountId: "acc-runtime",
    enabled: true,
    configured: true,
    name: undefined,
    userId: "runtime-user",
  })
})
