import test from "node:test"
import assert from "node:assert/strict"

async function loadCodexInvalidAccountOrFail() {
  try {
    return await import("../dist/codex-invalid-account.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("codex invalid account helper module is missing: ../dist/codex-invalid-account.js")
    }
    throw error
  }
}

function entry(input = {}) {
  return {
    providerId: "codex",
    ...input,
  }
}

test("getCodexDisplayName follows workspace/name/email/accountId/fallback priority", async () => {
  const { getCodexDisplayName } = await loadCodexInvalidAccountOrFail()

  assert.equal(
    getCodexDisplayName(
      entry({ workspaceName: "workspace-a", name: "name-a", email: "a@example.com", accountId: "acct_a" }),
      "fallback-a",
    ),
    "workspace-a",
  )
  assert.equal(getCodexDisplayName(entry({ name: "name-b", email: "b@example.com" }), "fallback-b"), "name-b")
  assert.equal(getCodexDisplayName(entry({ email: "c@example.com", accountId: "acct_c" }), "fallback-c"), "c@example.com")
  assert.equal(getCodexDisplayName(entry({ accountId: "acct_d" }), "fallback-d"), "acct_d")
  assert.equal(getCodexDisplayName(entry({}), "fallback-e"), "fallback-e")
})

test("sortCodexRecoveryCandidates prioritizes week>0 and earliest 5h resetAt when any 5h remains", async () => {
  const { sortCodexRecoveryCandidates } = await loadCodexInvalidAccountOrFail()

  const sorted = sortCodexRecoveryCandidates([
    { name: "first", entry: entry({ snapshot: { usageWeek: { remaining: 8 }, usage5h: { remaining: 0, resetAt: 1 } } }) },
    { name: "second", entry: entry({ snapshot: { usageWeek: { remaining: 6 }, usage5h: { remaining: 2, resetAt: 30 } } }) },
    { name: "third", entry: entry({ snapshot: { usageWeek: { remaining: 4 }, usage5h: { remaining: 1, resetAt: 20 } } }) },
  ])

  assert.deepEqual(sorted.map((item) => item.name), ["third", "second", "first"])
})

test("sortCodexRecoveryCandidates falls back to earliest week resetAt when all week>0 candidates have no 5h quota", async () => {
  const { sortCodexRecoveryCandidates } = await loadCodexInvalidAccountOrFail()

  const sorted = sortCodexRecoveryCandidates([
    { name: "a", entry: entry({ snapshot: { usageWeek: { remaining: 6, resetAt: 500 }, usage5h: { remaining: 0, resetAt: 5 } } }) },
    { name: "b", entry: entry({ snapshot: { usageWeek: { remaining: 2, resetAt: 200 }, usage5h: { remaining: 0, resetAt: 4 } } }) },
    { name: "c", entry: entry({ snapshot: { usageWeek: { remaining: 1, resetAt: 300 }, usage5h: { remaining: 0, resetAt: 3 } } }) },
  ])

  assert.deepEqual(sorted.map((item) => item.name), ["b", "c", "a"])
})

test("sortCodexRecoveryCandidates keeps missing resetAt at lower priority and preserves order for complete ties", async () => {
  const { sortCodexRecoveryCandidates } = await loadCodexInvalidAccountOrFail()

  const sorted = sortCodexRecoveryCandidates([
    { name: "with-missing", entry: entry({ snapshot: { usageWeek: { remaining: 3 }, usage5h: { remaining: 2 } } }) },
    { name: "with-reset", entry: entry({ snapshot: { usageWeek: { remaining: 3 }, usage5h: { remaining: 2, resetAt: 999 } } }) },
    { name: "tie-a", entry: entry({ snapshot: { usageWeek: { remaining: 3 }, usage5h: { remaining: 2, resetAt: 1000 } } }) },
    { name: "tie-b", entry: entry({ snapshot: { usageWeek: { remaining: 3 }, usage5h: { remaining: 2, resetAt: 1000 } } }) },
  ])

  assert.deepEqual(sorted.map((item) => item.name), ["with-reset", "tie-a", "tie-b", "with-missing"])
})

test("recoverInvalidCodexAccount removes invalid account, switches to replacement, and persists openai auth only when replacement exists", async () => {
  const { recoverInvalidCodexAccount } = await loadCodexInvalidAccountOrFail()

  const setAuthCalls = []
  const result = await recoverInvalidCodexAccount({
    store: {
      active: "invalid",
      accounts: {
        invalid: entry({ name: "invalid", accountId: "acct_invalid", access: "bad_access", refresh: "bad_refresh" }),
        low: entry({ name: "low", accountId: "acct_low", access: "low_access", refresh: "low_refresh", snapshot: { usageWeek: { remaining: 0, resetAt: 100 } } }),
        high: entry({ name: "high", accountId: "acct_high", access: "high_access", refresh: "high_refresh", expires: 321, snapshot: { usageWeek: { remaining: 5, resetAt: 400 }, usage5h: { remaining: 2, resetAt: 200 } } }),
      },
    },
    invalidAccountName: "invalid",
    setAuth: async (payload) => {
      setAuthCalls.push(payload)
    },
  })

  assert.equal(result.removed, "invalid")
  assert.equal(result.replacement, "high")
  assert.equal(result.switched, true)
  assert.equal(result.weekRecoveryOnly, false)
  assert.equal(result.noCandidates, false)
  assert.equal(result.store.active, "high")
  assert.equal(Object.hasOwn(result.store.accounts, "invalid"), false)
  assert.equal(setAuthCalls.length, 1)
  assert.deepEqual(setAuthCalls[0], {
    path: { id: "openai" },
    body: {
      type: "oauth",
      refresh: "high_refresh",
      access: "high_access",
      expires: 321,
      accountId: "acct_high",
    },
  })
})

test("recoverInvalidCodexAccount marks weekRecoveryOnly when all week quotas are exhausted and avoids auth persistence without replacement", async () => {
  const { recoverInvalidCodexAccount } = await loadCodexInvalidAccountOrFail()

  const setAuthCalls = []
  const weekOnly = await recoverInvalidCodexAccount({
    store: {
      active: "invalid",
      accounts: {
        invalid: entry({ name: "invalid" }),
        a: entry({ name: "a", snapshot: { usageWeek: { remaining: 0, resetAt: 2000 } } }),
        b: entry({ name: "b", snapshot: { usageWeek: { remaining: 0, resetAt: 1000 } } }),
      },
    },
    invalidAccountName: "invalid",
    setAuth: async (payload) => {
      setAuthCalls.push(payload)
    },
  })

  assert.equal(weekOnly.replacement, "b")
  assert.equal(weekOnly.switched, true)
  assert.equal(weekOnly.weekRecoveryOnly, true)
  assert.equal(weekOnly.noCandidates, false)
  assert.equal(setAuthCalls.length, 1)

  const noCandidate = await recoverInvalidCodexAccount({
    store: {
      active: "invalid",
      accounts: {
        invalid: entry({ name: "invalid" }),
      },
    },
    invalidAccountName: "invalid",
    setAuth: async (payload) => {
      setAuthCalls.push(payload)
    },
  })

  assert.equal(noCandidate.replacement, undefined)
  assert.equal(noCandidate.switched, false)
  assert.equal(noCandidate.weekRecoveryOnly, false)
  assert.equal(noCandidate.noCandidates, true)
  assert.equal(setAuthCalls.length, 1)
})
