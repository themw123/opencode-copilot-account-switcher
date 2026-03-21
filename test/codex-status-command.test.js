import test from "node:test"
import assert from "node:assert/strict"

async function loadCodexStatusCommandOrFail() {
  try {
    return await import("../dist/codex-status-command.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("codex-status command module is missing: ../dist/codex-status-command.js")
    }
    throw error
  }
}

test("codex status command ends with controlled interrupt after success toast", async () => {
  const calls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "access",
        },
      }),
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {
            accountId: "acct_1",
            email: "user@example.com",
            plan: "pro",
          },
          windows: {
            primary: {
              entitlement: 100,
              remaining: 99,
            },
            secondary: {},
          },
          credits: {},
          updatedAt: 1700000000000,
        },
      }),
      readStore: async () => ({}),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const hasSuccessToast = calls.some((item) => {
    const variant = String(item?.body?.variant ?? "")
    const message = String(item?.body?.message ?? "")
    return variant === "success" && /codex|status|usage|updated|成功/i.test(message)
  })
  assert.equal(hasSuccessToast, true)
})

test("codex status command preserves tui showToast this binding", async () => {
  const calls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  const tui = {
    _client: { id: "toast-ok" },
    async showToast(options) {
      const marker = this?._client?.id
      if (!marker) throw new TypeError("undefined is not an object (evaluating 'this._client')")
      calls.push({ marker, options })
    },
  }

  await assert.rejects(
    handleCodexStatusCommand({
      client: { tui },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "access",
        },
      }),
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {
            accountId: "acct_1",
          },
          windows: {
            primary: {},
            secondary: {},
          },
          credits: {},
          updatedAt: 1700000000000,
        },
      }),
      readStore: async () => ({}),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.marker, "toast-ok")
  assert.equal(calls[0]?.options?.body?.variant, "info")
  assert.equal(calls[1]?.marker, "toast-ok")
  assert.equal(calls[1]?.options?.body?.variant, "success")
})

test("codex status command preserves auth get and set this binding", async () => {
  const calls = []
  const getCalls = []
  const setCalls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  const auth = {
    _client: { id: "auth-ok" },
    async get(input) {
      const marker = this?._client?.id
      if (!marker) throw new TypeError("undefined is not an object (evaluating 'this._client')")
      getCalls.push({ marker, input })
      return {
        data: {
          type: "oauth",
          access: "old_access",
          refresh: "old_refresh",
        },
      }
    },
    async set(input) {
      const marker = this?._client?.id
      if (!marker) throw new TypeError("undefined is not an object (evaluating 'this._client')")
      setCalls.push({ marker, input })
    },
  }

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
        auth,
      },
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {
            accountId: "acct_123",
            email: "codex@example.com",
            plan: "pro",
          },
          windows: {
            primary: {
              entitlement: 100,
              remaining: 42,
            },
            secondary: {},
          },
          credits: {},
          updatedAt: 1700000000123,
        },
        authPatch: {
          access: "new_access",
          refresh: "new_refresh",
          accountId: "acct_123",
        },
      }),
      readStore: async () => ({}),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  assert.equal(getCalls.length, 1)
  assert.equal(getCalls[0]?.marker, "auth-ok")
  assert.equal(setCalls.length, 1)
  assert.equal(setCalls[0]?.marker, "auth-ok")
  assert.equal(setCalls[0]?.input?.body?.access, "new_access")
  assert.equal(setCalls[0]?.input?.body?.refresh, "new_refresh")
  assert.equal(setCalls[0]?.input?.body?.accountId, "acct_123")
  assert.equal(calls.at(-1)?.body?.variant, "success")
})

test("codex status command shows auth-missing error and exits with controlled interrupt", async () => {
  const calls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadAuth: async () => undefined,
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const hasAuthMissingErrorToast = calls.some((item) => {
    const variant = String(item?.body?.variant ?? "")
    const message = String(item?.body?.message ?? "")
    return variant === "error" && /oauth|auth|登录|missing/i.test(message)
  })
  assert.equal(hasAuthMissingErrorToast, true)
})

test("codex status command writes auth patch and store on successful refresh", async () => {
  const calls = []
  const persistedAuth = []
  const persistedStores = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "old_access",
          refresh: "old_refresh",
        },
      }),
      persistAuth: async (nextAuth) => {
        persistedAuth.push(nextAuth)
      },
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {
            accountId: "acct_123",
            email: "codex@example.com",
            plan: "pro",
          },
          windows: {
            primary: {
              entitlement: 100,
              remaining: 42,
            },
            secondary: {
              entitlement: 10,
              remaining: 3,
            },
          },
          credits: {
            total: 50,
            remaining: 21,
            used: 29,
          },
          updatedAt: 1700000000123,
        },
        authPatch: {
          access: "new_access",
          refresh: "new_refresh",
          accountId: "acct_123",
        },
      }),
      readStore: async () => ({}),
      writeStore: async (nextStore) => {
        persistedStores.push(nextStore)
      },
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  assert.equal(persistedAuth.length, 1)
  assert.equal(persistedAuth[0]?.openai?.access, "new_access")
  assert.equal(persistedAuth[0]?.openai?.refresh, "new_refresh")
  assert.equal(persistedAuth[0]?.openai?.accountId, "acct_123")

  assert.equal(persistedStores.length, 1)
  assert.equal(persistedStores[0]?.activeProvider, "codex")
  assert.equal(persistedStores[0]?.activeAccountId, "acct_123")
  assert.equal(persistedStores[0]?.activeEmail, "codex@example.com")
  assert.equal(persistedStores[0]?.lastStatusRefresh, 1700000000123)
  assert.equal(persistedStores[0]?.status?.premium?.entitlement, 100)
  assert.equal(persistedStores[0]?.status?.premium?.remaining, 42)

  const infoToast = calls.find((item) => item?.body?.variant === "info")
  assert.match(String(infoToast?.body?.message ?? ""), /fetching|codex|status/i)

  const successToast = calls.find((item) => item?.body?.variant === "success")
  const successText = String(successToast?.body?.message ?? "")
  assert.match(successText, /identity|usage|account|plan|primary/i)
  assert.match(successText, /42|100|21|50/)
})

test("codex status command falls back to cached store when fetch fails", async () => {
  const calls = []
  const persistedStores = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "access",
        },
      }),
      fetchStatus: async () => ({
        ok: false,
        error: {
          kind: "network_error",
          message: "network temporarily unavailable",
        },
      }),
      readStore: async () => ({
        activeProvider: "codex",
        activeAccountId: "acct_cached",
        activeEmail: "cached@example.com",
        lastStatusRefresh: 1699999999000,
        account: {
          id: "acct_cached",
          email: "cached@example.com",
          plan: "plus",
        },
        status: {
          premium: {
            entitlement: 200,
            remaining: 180,
          },
        },
      }),
      writeStore: async (nextStore) => {
        persistedStores.push(nextStore)
      },
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  assert.equal(persistedStores.length, 0)
  const warningToast = calls.find((item) => item?.body?.variant === "warning")
  const warningText = String(warningToast?.body?.message ?? "")
  assert.match(warningText, /cache|cached|fallback|network/i)
  assert.match(warningText, /acct_cached|cached@example.com|180\/200|180|200/)
})

test("codex status command renders n/a for missing fields", async () => {
  const calls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "access",
        },
      }),
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {},
          windows: {
            primary: {},
            secondary: {},
          },
          credits: {},
          updatedAt: 1700000000000,
        },
      }),
      readStore: async () => ({}),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const successToast = calls.find((item) => item?.body?.variant === "success")
  const successText = String(successToast?.body?.message ?? "")
  assert.match(successText, /n\/a/i)
})
