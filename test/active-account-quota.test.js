import test from "node:test"
import assert from "node:assert/strict"

test("refreshActiveAccountQuota returns missing-active when store has no active account", async () => {
  const { refreshActiveAccountQuota } = await import("../dist/active-account-quota.js")
  const store = { accounts: {} }

  const result = await refreshActiveAccountQuota({
    store,
    fetchQuotaImpl: async () => {
      throw new Error("should not run")
    },
    now: () => 123,
  })

  assert.deepEqual(result, { type: "missing-active" })
  assert.equal(store.lastQuotaRefresh, undefined)
})

test("refreshActiveAccountQuota does not call fetchQuotaImpl when store has no active account", async () => {
  const { refreshActiveAccountQuota } = await import("../dist/active-account-quota.js")
  let called = 0
  const store = { accounts: {} }

  await refreshActiveAccountQuota({
    store,
    fetchQuotaImpl: async () => {
      called += 1
      throw new Error("should not run")
    },
    now: () => 123,
  })

  assert.equal(called, 0)
})

test("refreshActiveAccountQuota returns missing-active when active key is stale", async () => {
  const { refreshActiveAccountQuota } = await import("../dist/active-account-quota.js")
  const store = { active: "ghost", accounts: {} }

  const result = await refreshActiveAccountQuota({
    store,
    fetchQuotaImpl: async () => {
      throw new Error("should not run")
    },
    now: () => 123,
  })

  assert.deepEqual(result, { type: "missing-active" })
  assert.equal(store.lastQuotaRefresh, undefined)
})

test("refreshActiveAccountQuota returns refresh-failed and preserves previous quota", async () => {
  const { refreshActiveAccountQuota } = await import("../dist/active-account-quota.js")
  const previousQuota = { snapshots: { premium: { remaining: 5, entitlement: 50 } } }
  const store = {
    active: "alice",
    accounts: {
      alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0, quota: previousQuota },
    },
  }

  const result = await refreshActiveAccountQuota({
    store,
    fetchQuotaImpl: async () => ({ error: "quota failed" }),
    now: () => 123,
  })

  assert.deepEqual(result, {
    type: "refresh-failed",
    name: "alice",
    error: "quota failed",
    previousQuota,
  })
  assert.equal(store.accounts.alice.quota, previousQuota)
  assert.equal(store.lastQuotaRefresh, undefined)
})

test("refreshActiveAccountQuota writes refreshed quota into active account", async () => {
  const { refreshActiveAccountQuota } = await import("../dist/active-account-quota.js")
  const store = {
    active: "alice",
    accounts: {
      alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
    },
  }

  const result = await refreshActiveAccountQuota({
    store,
    fetchQuotaImpl: async () => ({
      updatedAt: 999,
      snapshots: { premium: { remaining: 10, entitlement: 50 } },
    }),
    now: () => 123,
  })

  assert.equal(result.type, "success")
  assert.equal(store.accounts.alice.quota?.snapshots?.premium?.remaining, 10)
  assert.equal(store.accounts.alice.quota?.updatedAt, 999)
})

test("refreshActiveAccountQuota updates lastQuotaRefresh from injected clock", async () => {
  const { refreshActiveAccountQuota } = await import("../dist/active-account-quota.js")
  const store = {
    active: "alice",
    accounts: {
      alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
    },
  }

  await refreshActiveAccountQuota({
    store,
    fetchQuotaImpl: async () => ({ snapshots: {} }),
    now: () => 456,
  })

  assert.equal(store.lastQuotaRefresh, 456)
})
