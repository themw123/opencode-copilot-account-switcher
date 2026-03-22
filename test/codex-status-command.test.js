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
    return variant === "success" && /^账号:\s*/.test(message)
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

test("codex status command falls back to auth.json-style openai auth when client auth lookup is unavailable", async () => {
  const calls = []
  const fetchCalls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
        auth: {
          get: async () => {
            throw new Error("client auth unavailable")
          },
        },
      },
      readAuthEntries: async () => ({
        openai: {
          access: "file_access",
          refresh: "file_refresh",
          expires: 1700000000000,
          accountId: "acct_from_file_header",
        },
      }),
      fetchStatus: async (input) => {
        fetchCalls.push(input)
        return {
          ok: true,
          status: {
            identity: {
              accountId: "acct_from_file",
              email: "codex@example.com",
              plan: "pro",
            },
            windows: {
              primary: {
                entitlement: 100,
                remaining: 75,
              },
              secondary: {},
            },
            credits: {},
            updatedAt: 1700000000000,
          },
        }
      },
      readStore: async () => ({}),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0]?.oauth?.access, "file_access")
  assert.equal(fetchCalls[0]?.oauth?.refresh, "file_refresh")
  assert.equal(fetchCalls[0]?.accountId, "acct_from_file_header")
  assert.equal(calls.at(-1)?.body?.variant, "success")
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
  assert.equal(persistedStores[0]?.active, "acct_123")
  assert.equal(persistedStores[0]?.lastSnapshotRefresh, 1700000000123)
  assert.equal(persistedStores[0]?.accounts?.acct_123?.providerId, "codex")
  assert.equal(persistedStores[0]?.accounts?.acct_123?.accountId, "acct_123")
  assert.equal(persistedStores[0]?.accounts?.acct_123?.email, "codex@example.com")
  assert.equal(persistedStores[0]?.accounts?.acct_123?.snapshot?.usage5h?.entitlement, 100)
  assert.equal(persistedStores[0]?.accounts?.acct_123?.snapshot?.usage5h?.remaining, 42)

  const infoToast = calls.find((item) => item?.body?.variant === "info")
  assert.match(String(infoToast?.body?.message ?? ""), /fetching|codex|status/i)

  const successToast = calls.find((item) => item?.body?.variant === "success")
  const successText = String(successToast?.body?.message ?? "")
  const successLines = successText.split("\n")
  assert.equal(successLines.length, 4)
  assert.match(successLines[0], /^账号:\s*acct_123/)
  assert.match(successLines[1], /^Workspace:\s*codex@example\.com/)
  assert.match(successLines[2], /^5h:\s*42% left/)
  assert.match(successLines[3], /^week:\s*3\/10/)
})

test("codex status command uses codex-store helper shape and writes snapshot into active account", async () => {
  const persistedStores = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "access",
          accountId: "acct_openai",
        },
      }),
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {
            accountId: "acct_new",
            email: "new@example.com",
            plan: "pro",
          },
          windows: {
            primary: {
              entitlement: 100,
              remaining: 90,
            },
            secondary: {
              entitlement: 100,
              remaining: 70,
            },
          },
          credits: {},
          updatedAt: 1700011111000,
        },
      }),
      readStore: async () => ({
        activeProvider: "codex",
        activeAccountId: "acct_legacy",
        activeEmail: "legacy@example.com",
        account: {
          id: "acct_legacy",
          email: "legacy@example.com",
          plan: "plus",
        },
        status: {
          premium: {
            entitlement: 100,
            remaining: 20,
          },
        },
      }),
      writeStore: async (nextStore) => {
        persistedStores.push(nextStore)
      },
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  assert.equal(persistedStores.length, 1)
  const written = persistedStores[0]
  assert.equal(written.active, "acct_new")
  assert.equal(written.lastSnapshotRefresh, 1700011111000)
  assert.equal(Object.hasOwn(written, "activeAccountId"), false)
  assert.equal(Object.hasOwn(written, "activeEmail"), false)
  assert.equal(Object.hasOwn(written, "account"), false)
  assert.equal(Object.hasOwn(written, "status"), false)
  assert.equal(written.accounts.acct_new.accountId, "acct_new")
  assert.equal(written.accounts.acct_new.email, "new@example.com")
  assert.equal(written.accounts.acct_new.snapshot.plan, "pro")
  assert.equal(written.accounts.acct_new.snapshot.usage5h.entitlement, 100)
  assert.equal(written.accounts.acct_new.snapshot.usage5h.remaining, 90)
  assert.equal(written.accounts.acct_new.snapshot.usageWeek.entitlement, 100)
  assert.equal(written.accounts.acct_new.snapshot.usageWeek.remaining, 70)
  assert.equal(written.accounts.acct_new.snapshot.updatedAt, 1700011111000)
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
  const warningToasts = calls.filter((item) => item?.body?.variant === "warning")
  assert.equal(warningToasts.length >= 2, true)
  const failureText = String(warningToasts[0]?.body?.message ?? "")
  assert.match(failureText, /fetch failed|network/i)
  const summaryText = String(warningToasts.at(-1)?.body?.message ?? "")
  assert.match(summaryText, /^账号:\s*acct_cached/)
  assert.match(summaryText, /^Workspace:\s*acct_cached/m)
  assert.match(summaryText, /^5h:\s*180\/200/m)
  assert.match(summaryText, /^week:\s*n\/a/m)
  assert.doesNotMatch(summaryText, /fetch failed|cached snapshot|Codex status updated|\[identity\]|credits/i)
})

test("codex status command fetch failure prefers cached snapshot for the requested account over store.active", async () => {
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
          accountId: "acct_requested",
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
        accounts: {
          activeAccount: {
            name: "activeAccount",
            providerId: "codex",
            accountId: "acct_active",
            email: "active@example.com",
            snapshot: {
              plan: "team",
              usage5h: {
                entitlement: 100,
                remaining: 33,
              },
            },
          },
          requestedAccount: {
            name: "requestedAccount",
            providerId: "codex",
            accountId: "acct_requested",
            email: "requested@example.com",
            snapshot: {
              plan: "plus",
              usage5h: {
                entitlement: 200,
                remaining: 155,
              },
            },
          },
        },
        active: "activeAccount",
        lastSnapshotRefresh: 1700004444555,
      }),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const warningToasts = calls.filter((item) => item?.body?.variant === "warning")
  assert.equal(warningToasts.length >= 2, true)
  const summaryText = String(warningToasts.at(-1)?.body?.message ?? "")
  assert.match(summaryText, /^账号:\s*acct_requested/m)
  assert.match(summaryText, /^Workspace:\s*requestedAccount/m)
  assert.match(summaryText, /^5h:\s*155\/200/m)
  assert.doesNotMatch(summaryText, /active@example.com|acct_active/)
  assert.doesNotMatch(summaryText, /fetch failed|cached snapshot|Codex status updated|\[identity\]|credits/i)
})

test("codex status command renders only account workspace 5h and week lines", async () => {
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
          accountId: "acct_summary",
        },
      }),
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {
            accountId: "acct_summary",
            email: "summary@example.com",
            plan: "team",
            workspaceName: "workspace-summary",
          },
          windows: {
            primary: {
              entitlement: 100,
              remaining: 42,
            },
            secondary: {
              entitlement: 100,
              remaining: 7,
            },
          },
          credits: {
            total: 100,
            remaining: 88,
          },
          updatedAt: 1700000007777,
        },
      }),
      readStore: async () => ({}),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const successToast = calls.find((item) => item?.body?.variant === "success")
  const successText = String(successToast?.body?.message ?? "")
  const lines = successText.split("\n")
  assert.equal(lines.length, 4)
  assert.match(lines[0], /^账号:\s*/)
  assert.match(lines[1], /^Workspace:\s*/)
  assert.match(lines[2], /^5h:\s*/)
  assert.match(lines[3], /^week:\s*/)
  assert.doesNotMatch(successText, /Codex status updated|\[identity\]|\[usage\]|credits|fetch failed|cached snapshot/i)
})

test("codex status command prefers workspace display name for Workspace label", async () => {
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
          accountId: "acct_summary",
        },
      }),
      fetchStatus: async () => ({
        ok: true,
        status: {
          identity: {
            accountId: "acct_summary",
            email: "summary@example.com",
            workspaceName: "workspace-visible",
          },
          windows: {
            primary: {
              entitlement: 100,
              remaining: 42,
            },
            secondary: {
              entitlement: 100,
              remaining: 7,
            },
          },
          credits: {},
          updatedAt: 1700000007877,
        },
      }),
      readStore: async () => ({}),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const successToast = calls.find((item) => item?.body?.variant === "success")
  const successText = String(successToast?.body?.message ?? "")
  assert.match(successText, /^Workspace:\s*workspace-visible/m)
  assert.doesNotMatch(successText, /^Workspace:\s*summary@example\.com/m)
  assert.doesNotMatch(successText, /^Workspace:\s*acct_summary/m)
})

test("codex status command removes invalid account on refresh-400 and switches to replacement", async () => {
  const calls = []
  const authSetCalls = []
  const persistedStores = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
        auth: {
          set: async (input) => {
            authSetCalls.push(input)
          },
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "invalid_access",
          accountId: "acct_invalid_id",
        },
      }),
      fetchStatus: async () => ({
        ok: false,
        error: {
          kind: "invalid_account",
          status: 400,
          message: "refresh token invalid",
        },
      }),
      readStore: async () => ({
        active: "acct_invalid",
        accounts: {
          acct_invalid: {
            name: "acct_invalid",
            providerId: "codex",
            accountId: "acct_invalid_id",
            email: "invalid@example.com",
            workspaceName: "workspace-invalid",
            refresh: "refresh-invalid",
            access: "access-invalid",
          },
          acct_replacement: {
            name: "acct_replacement",
            providerId: "codex",
            accountId: "acct_replacement_id",
            email: "replacement@example.com",
            workspaceName: "workspace-replacement",
            refresh: "refresh-replacement",
            access: "access-replacement",
            snapshot: {
              usage5h: { remaining: 10 },
              usageWeek: { remaining: 20 },
            },
          },
        },
      }),
      writeStore: async (nextStore) => {
        persistedStores.push(nextStore)
      },
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  assert.equal(persistedStores.length, 1)
  assert.equal(Object.hasOwn(persistedStores[0].accounts, "acct_invalid"), false)
  assert.equal(persistedStores[0].active, "acct_replacement")
  assert.equal(authSetCalls.length, 1)
  assert.equal(authSetCalls[0]?.body?.accountId, "acct_replacement_id")

  const warningToast = calls.find((item) => item?.body?.variant === "warning")
  const warningText = String(warningToast?.body?.message ?? "")
  assert.match(warningText, /无效账号workspace-invalid已移除，请及时检查核对/)
})

test("codex status command does not switch accounts on non-400 fetch errors", async () => {
  const calls = []
  const authSetCalls = []
  const persistedStores = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
        auth: {
          set: async (input) => {
            authSetCalls.push(input)
          },
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "access",
          accountId: "acct_cached",
        },
      }),
      fetchStatus: async () => ({
        ok: false,
        error: {
          kind: "network_error",
          message: "network temporary issue",
        },
      }),
      readStore: async () => ({
        active: "acct_cached",
        accounts: {
          acct_cached: {
            name: "acct_cached",
            providerId: "codex",
            accountId: "acct_cached",
            email: "cached@example.com",
            workspaceName: "workspace-cached",
            snapshot: {
              usage5h: { entitlement: 100, remaining: 50 },
              usageWeek: { entitlement: 100, remaining: 30 },
            },
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
  assert.equal(authSetCalls.length, 0)
  const summaryToast = calls.filter((item) => item?.body?.variant === "warning").at(-1)
  const summaryText = String(summaryToast?.body?.message ?? "")
  assert.match(summaryText, /^账号:\s*/)
  assert.doesNotMatch(summaryText, /fetch failed|cached snapshot|Codex status updated|\[identity\]|credits/i)
})

test("codex status command warns when replacement account only has week recovery", async () => {
  const calls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
        auth: {
          set: async () => {},
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "invalid_access",
          accountId: "acct_invalid_id",
        },
      }),
      fetchStatus: async () => ({
        ok: false,
        error: {
          kind: "invalid_account",
          status: 400,
          message: "refresh token invalid",
        },
      }),
      readStore: async () => ({
        active: "acct_invalid",
        accounts: {
          acct_invalid: {
            name: "acct_invalid",
            providerId: "codex",
            accountId: "acct_invalid_id",
            workspaceName: "workspace-invalid",
            refresh: "refresh-invalid",
            access: "access-invalid",
          },
          acct_week_only: {
            name: "acct_week_only",
            providerId: "codex",
            accountId: "acct_week_only_id",
            workspaceName: "workspace-week-only",
            refresh: "refresh-week",
            access: "access-week",
            snapshot: {
              usage5h: { entitlement: 100, remaining: 0 },
              usageWeek: { entitlement: 100, remaining: 8 },
            },
          },
        },
      }),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const warningToast = calls.filter((item) => item?.body?.variant === "warning").at(-1)
  const warningText = String(warningToast?.body?.message ?? "")
  assert.match(warningText, /请检查账号状态/)
})

test("codex status command does not append account-check hint when replacement week quota is exhausted", async () => {
  const calls = []
  const { handleCodexStatusCommand } = await loadCodexStatusCommandOrFail()

  await assert.rejects(
    handleCodexStatusCommand({
      client: {
        tui: {
          showToast: async (options) => calls.push(options),
        },
        auth: {
          set: async () => {},
        },
      },
      loadAuth: async () => ({
        openai: {
          type: "oauth",
          access: "invalid_access",
          accountId: "acct_invalid_id",
        },
      }),
      fetchStatus: async () => ({
        ok: false,
        error: {
          kind: "invalid_account",
          status: 400,
          message: "refresh token invalid",
        },
      }),
      readStore: async () => ({
        active: "acct_invalid",
        accounts: {
          acct_invalid: {
            name: "acct_invalid",
            providerId: "codex",
            accountId: "acct_invalid_id",
            workspaceName: "workspace-invalid",
            refresh: "refresh-invalid",
            access: "access-invalid",
          },
          acct_exhausted: {
            name: "acct_exhausted",
            providerId: "codex",
            accountId: "acct_exhausted_id",
            workspaceName: "workspace-exhausted",
            refresh: "refresh-exhausted",
            access: "access-exhausted",
            snapshot: {
              usage5h: { entitlement: 100, remaining: 0 },
              usageWeek: { entitlement: 100, remaining: 0 },
            },
          },
        },
      }),
      writeStore: async () => {},
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const warningToast = calls.filter((item) => item?.body?.variant === "warning").at(-1)
  const warningText = String(warningToast?.body?.message ?? "")
  assert.match(warningText, /无效账号workspace-invalid已移除，请及时检查核对/)
  assert.doesNotMatch(warningText, /请检查账号状态/)
})

test("codex status command renders cached snapshot when reading legacy store shape", async () => {
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
        ok: false,
        error: {
          kind: "network_error",
          message: "network unavailable",
        },
      }),
      readStore: async () => ({
        activeProvider: "codex",
        activeAccountId: "acct_legacy_cached",
        activeEmail: "legacy-cached@example.com",
        lastStatusRefresh: 1699990000000,
        account: {
          id: "acct_legacy_cached",
          email: "legacy-cached@example.com",
          plan: "plus",
        },
        status: {
          premium: {
            entitlement: 100,
            remaining: 44,
          },
        },
      }),
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const warningToasts = calls.filter((item) => item?.body?.variant === "warning")
  assert.equal(warningToasts.length >= 2, true)
  const summaryText = String(warningToasts.at(-1)?.body?.message ?? "")
  assert.match(summaryText, /^账号:\s*acct_legacy_cached/m)
  assert.match(summaryText, /^Workspace:\s*acct_legacy_cached/m)
  assert.match(summaryText, /^5h:\s*44% left/m)
  assert.match(summaryText, /^week:\s*n\/a/m)
  assert.doesNotMatch(summaryText, /fetch failed|cached snapshot|Codex status updated|\[identity\]|credits/i)
})

test("codex status command cached Workspace label follows display-name priority", async () => {
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
          accountId: "acct_named",
        },
      }),
      fetchStatus: async () => ({
        ok: false,
        error: {
          kind: "network_error",
          message: "network unavailable",
        },
      }),
      readStore: async () => ({
        active: "acct_named",
        accounts: {
          acct_named: {
            name: "human-friendly-name",
            providerId: "codex",
            accountId: "acct_named",
            email: "named@example.com",
            snapshot: {
              usage5h: { entitlement: 100, remaining: 12 },
            },
          },
        },
      }),
    }),
    (error) => error?.name === "CodexStatusCommandHandledError",
  )

  const warningToasts = calls.filter((item) => item?.body?.variant === "warning")
  const summaryText = String(warningToasts.at(-1)?.body?.message ?? "")
  assert.match(summaryText, /^Workspace:\s*human-friendly-name/m)
  assert.doesNotMatch(summaryText, /^Workspace:\s*named@example\.com/m)
  assert.doesNotMatch(summaryText, /^Workspace:\s*acct_named/m)
})

test("codex status command renders 5h and weekly percentage labels for percentage-based windows", async () => {
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
            email: "codex@example.com",
            plan: "team",
          },
          windows: {
            primary: {
              entitlement: 100,
              remaining: 42,
            },
            secondary: {
              entitlement: 100,
              remaining: 6,
            },
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
  assert.match(successText, /5h:\s*42% left/i)
  assert.match(successText, /week:\s*6% left/i)
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
