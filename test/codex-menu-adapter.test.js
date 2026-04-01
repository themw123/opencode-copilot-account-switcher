import test from "node:test"
import assert from "node:assert/strict"

async function loadCodexMenuAdapterOrFail() {
  try {
    return await import("../dist/providers/codex-menu-adapter.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("codex menu adapter module is missing: ../dist/providers/codex-menu-adapter.js")
    }
    throw error
  }
}

function createClient(calls) {
  return {
    auth: {
      set: async (input) => {
        calls.push(input)
      },
    },
  }
}

function captureConsoleLog() {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(" "))
  }
  return {
    lines,
    restore() {
      console.log = original
    },
  }
}

test("codex adapter bootstraps openai auth from auth.json only once", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const authCalls = []
  let readAuthCalls = 0
  const now = () => 1700000000000
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient(authCalls),
    now,
    readAuthEntries: async () => {
      readAuthCalls += 1
      return {
        openai: {
          name: "auth:openai",
          refresh: "refresh_1",
          access: "access_1",
          expires: 1700001000000,
          accountId: "acct_bootstrap",
          email: "bootstrap@example.com",
          providerId: "openai",
        },
      }
    },
  })

  const first = await adapter.bootstrapAuthImport(store)
  const second = await adapter.bootstrapAuthImport(store)

  assert.equal(first, true)
  assert.equal(second, false)
  assert.equal(readAuthCalls, 1)
  assert.equal(store.bootstrapAuthImportTried, true)
  assert.equal(store.bootstrapAuthImportAt, 1700000000000)
  assert.equal(store.active, "acct_bootstrap")
  assert.equal(Object.keys(store.accounts).length, 1)
  assert.equal(store.accounts.acct_bootstrap.providerId, "openai")
  assert.equal(store.accounts.acct_bootstrap.refresh, "refresh_1")
  assert.equal(authCalls.length, 0)
})

test("codex adapter marks bootstrapAuthImportTried when no importable openai auth exists", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000000123,
    readAuthEntries: async () => ({
      "github-copilot": {
        name: "auth:github-copilot",
        refresh: "gh_refresh",
        access: "gh_access",
        expires: 0,
      },
    }),
  })

  const changed = await adapter.bootstrapAuthImport(store)

  assert.equal(changed, true)
  assert.equal(store.bootstrapAuthImportTried, true)
  assert.equal(store.bootstrapAuthImportAt, 1700000000123)
  assert.deepEqual(store.accounts, {})
})

test("codex adapter switchAccount writes only to openai provider", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const setCalls = []
  const store = {
    accounts: {
      acct_switch: {
        name: "acct_switch",
        providerId: "openai",
        refresh: "refresh_switch",
        access: "access_switch",
        expires: 1700001000000,
        accountId: "acct_switch",
      },
    },
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient(setCalls),
    now: () => 1700000000222,
  })

  await adapter.switchAccount(store, "acct_switch", store.accounts.acct_switch)

  assert.equal(setCalls.length, 1)
  assert.equal(setCalls[0]?.path?.id, "openai")
  assert.equal(setCalls.some((call) => call?.path?.id === "github-copilot"), false)
  assert.equal(setCalls.some((call) => call?.path?.id === "github-copilot-enterprise"), false)
  assert.equal(store.active, "acct_switch")
  assert.equal(store.accounts.acct_switch.lastUsed, 1700000000222)
})

test("codex adapter refreshSnapshots maps plan 5h and week into menu info", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_plan: {
        name: "acct_plan",
        providerId: "openai",
        refresh: "refresh_plan",
        access: "access_plan",
        accountId: "acct_plan",
        email: "plan@example.com",
      },
    },
    active: "acct_plan",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000000333,
    fetchStatus: async () => ({
      ok: true,
      status: {
        identity: {
          accountId: "acct_plan",
          email: "plan@example.com",
          plan: "team",
          workspaceName: "workspace-plan",
        },
        windows: {
          primary: {
            entitlement: 100,
            remaining: 42,
            used: 58,
            resetAt: 1700003600000,
          },
          secondary: {
            entitlement: 100,
            remaining: 6,
            used: 94,
            resetAt: 1700600000000,
          },
        },
        credits: {},
        updatedAt: 1700000000333,
      },
    }),
  })

  await adapter.refreshSnapshots(store)
  const menuInfo = await adapter.toMenuInfo(store)

  assert.equal(menuInfo.length, 1)
  assert.equal(menuInfo[0].plan, "team")
  assert.equal(menuInfo[0].workspaceName, "workspace-plan")
  assert.deepEqual(menuInfo[0].quota?.premium, { remaining: 42, entitlement: 100 })
  assert.deepEqual(menuInfo[0].quota?.chat, { remaining: 6, entitlement: 100 })
  assert.equal(store.accounts.acct_plan.snapshot?.usage5h?.remaining, 42)
  assert.equal(store.accounts.acct_plan.snapshot?.usageWeek?.remaining, 6)
})

test("codex adapter toMenuInfo carries workspaceName for menu rendering", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_workspace: {
        name: "acct_workspace",
        providerId: "openai",
        refresh: "refresh_workspace",
        access: "access_workspace",
        accountId: "acct_workspace",
        email: "workspace@example.com",
        workspaceName: "visible-workspace",
        snapshot: {
          plan: "team",
          usage5h: { entitlement: 100, remaining: 42 },
          usageWeek: { entitlement: 100, remaining: 6 },
          updatedAt: 1700000000333,
        },
      },
    },
    active: "acct_workspace",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000000333,
  })

  const menuInfo = await adapter.toMenuInfo(store)

  assert.equal(menuInfo.length, 1)
  assert.equal(menuInfo[0].name, "workspace@example.com")
  assert.equal(menuInfo[0].workspaceName, "visible-workspace")
})

test("codex adapter toMenuInfo returns stable account ids for runtime actions", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_stable: {
        name: "acct_stable",
        providerId: "openai",
        refresh: "refresh_stable",
        access: "access_stable",
        accountId: "acct_stable",
        email: "stable@example.com",
        snapshot: {
          plan: "pro",
          usage5h: { entitlement: 100, remaining: 80 },
          usageWeek: { entitlement: 100, remaining: 60 },
          updatedAt: 1700000000444,
        },
      },
    },
    active: "acct_stable",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000000444,
  })

  const first = await adapter.toMenuInfo(store)
  store.accounts.acct_stable.snapshot = {
    ...store.accounts.acct_stable.snapshot,
    usage5h: { entitlement: 100, remaining: 79 },
    usageWeek: { entitlement: 100, remaining: 59 },
    updatedAt: 1700000000555,
  }
  const second = await adapter.toMenuInfo(store)

  assert.equal(first[0]?.id, second[0]?.id)
  assert.equal(typeof first[0]?.id, "string")

  const resolvedById = adapter.getAccountByName(store, String(first[0]?.id))
  assert.equal(resolvedById?.name, "acct_stable")
})

test("codex adapter authorizeNewAccount uses official browser oauth method", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const setCalls = []
  let loadMethodsCalls = 0
  let browserAuthorizeCalls = 0
  let browserCallbackCalls = 0
  const consoleCapture = captureConsoleLog()
  let releaseCallback = () => {}
  let resolveCallbackStarted = () => {}
  const callbackStarted = new Promise((resolve) => {
    resolveCallbackStarted = resolve
  })
  const callbackGate = new Promise((resolve) => {
    releaseCallback = resolve
  })
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  try {
    const adapter = createCodexMenuAdapter({
      client: createClient(setCalls),
      now: () => 1700000000666,
      promptText: async () => "1",
      loadOfficialCodexAuthMethods: async () => {
        loadMethodsCalls += 1
        return [{
          label: "Browser OAuth",
          type: "oauth",
          authorize: async () => {
            browserAuthorizeCalls += 1
            return {
              url: "https://example.com/browser",
              instructions: "Complete authorization in your browser.",
              method: "auto",
              callback: async () => {
                browserCallbackCalls += 1
                resolveCallbackStarted()
                await callbackGate
                return {
                  type: "success",
                  refresh: "refresh_new",
                  access: "access_new",
                  expires: 1700003600000,
                  accountId: "acct_new",
                }
              },
            }
          },
        }]
      },
    })

    const entryPromise = adapter.authorizeNewAccount(store)

    await callbackStarted
    assert.ok(consoleCapture.lines.includes("Go to: https://example.com/browser"))
    assert.ok(consoleCapture.lines.includes("Complete authorization in your browser."))

    releaseCallback()
    const entry = await entryPromise

    assert.equal(loadMethodsCalls, 1)
    assert.equal(browserAuthorizeCalls, 1)
    assert.equal(browserCallbackCalls, 1)
    assert.equal(entry?.providerId, "openai")
    assert.equal(entry?.refresh, "refresh_new")
    assert.equal(entry?.access, "access_new")
    assert.equal(entry?.accountId, "acct_new")
    assert.equal(entry?.addedAt, 1700000000666)
    assert.equal(entry?.workspaceName, undefined)
    assert.equal(entry?.email, undefined)
    assert.equal(setCalls.length, 1)
    assert.equal(setCalls[0]?.path?.id, "openai")
  } finally {
    releaseCallback()
    consoleCapture.restore()
  }
})

test("codex adapter authorizeNewAccount supports official headless oauth method through same path", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const setCalls = []
  const consoleCapture = captureConsoleLog()
  let releaseCallback = () => {}
  let resolveCallbackStarted = () => {}
  const callbackStarted = new Promise((resolve) => {
    resolveCallbackStarted = resolve
  })
  const callbackGate = new Promise((resolve) => {
    releaseCallback = resolve
  })
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  try {
    const adapter = createCodexMenuAdapter({
      client: createClient(setCalls),
      now: () => 1700000000777,
      promptText: async () => "h",
      loadOfficialCodexAuthMethods: async () => [{
        label: "Headless Device OAuth",
        type: "oauth",
        authorize: async () => ({
          url: "https://example.com/device",
          instructions: "Enter code: ABCD-EFGH",
          method: "auto",
          callback: async () => {
            resolveCallbackStarted()
            await callbackGate
            return {
              type: "success",
              refresh: "refresh_device",
              access: "access_device",
              expires: 1700007200000,
              accountId: "acct_device",
            }
          },
        }),
      }],
    })

    const entryPromise = adapter.authorizeNewAccount(store)

    await callbackStarted
    assert.ok(consoleCapture.lines.includes("Go to: https://example.com/device"))
    assert.ok(consoleCapture.lines.includes("Enter code: ABCD-EFGH"))

    releaseCallback()
    const entry = await entryPromise

    assert.equal(entry?.providerId, "openai")
    assert.equal(entry?.refresh, "refresh_device")
    assert.equal(entry?.access, "access_device")
    assert.equal(entry?.accountId, "acct_device")
    assert.equal(entry?.addedAt, 1700000000777)
    assert.equal(setCalls.length, 1)
    assert.equal(setCalls[0]?.path?.id, "openai")
  } finally {
    releaseCallback()
    consoleCapture.restore()
  }
})

test("codex adapter authorizeNewAccount keeps metadata fields undefined when official result omits them", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const consoleCapture = captureConsoleLog()
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  try {
    const adapter = createCodexMenuAdapter({
      client: createClient([]),
      now: () => 1700000000788,
      promptText: async () => "1",
      loadOfficialCodexAuthMethods: async () => [{
        label: "Browser OAuth",
        type: "oauth",
        authorize: async () => ({
          url: "https://example.com",
          method: "auto",
          callback: async () => ({
            type: "success",
            refresh: "refresh_no_metadata",
            access: "access_no_metadata",
            expires: 1700008200000,
            accountId: "acct_no_metadata",
          }),
        }),
      }],
    })

    const entry = await adapter.authorizeNewAccount(store)

    assert.equal(entry?.accountId, "acct_no_metadata")
    assert.equal(entry?.workspaceName, undefined)
    assert.equal(entry?.email, undefined)
  } finally {
    consoleCapture.restore()
  }
})

test("codex adapter authorizeNewAccount throws when official authorization method is not auto", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const consoleCapture = captureConsoleLog()
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  try {
    const adapter = createCodexMenuAdapter({
      client: createClient([]),
      promptText: async () => "1",
      loadOfficialCodexAuthMethods: async () => [{
        label: "Browser OAuth",
        type: "oauth",
        authorize: async () => ({
          url: "https://example.com",
          method: "browser",
          callback: async () => ({
            type: "success",
            refresh: "refresh_new",
            access: "access_new",
            expires: 1700003600000,
            accountId: "acct_new",
          }),
        }),
      }],
    })

    await assert.rejects(
      () => adapter.authorizeNewAccount(store),
      /Unsupported official Codex auth method: browser/,
    )
  } finally {
    consoleCapture.restore()
  }
})

test("codex adapter refreshSnapshots keeps active account aligned after identity rename", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      pending: {
        name: "pending",
        providerId: "openai",
        refresh: "refresh_pending",
        access: "access_pending",
        email: "rename@example.com",
      },
    },
    active: "pending",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000003000,
    fetchStatus: async () => ({
      ok: true,
      status: {
        identity: {
          accountId: "acct_renamed",
          email: "rename@example.com",
          plan: "pro",
        },
        windows: {
          primary: { entitlement: 100, remaining: 80, used: 20, resetAt: 1700003600000 },
          secondary: { entitlement: 100, remaining: 70, used: 30, resetAt: 1700600000000 },
        },
        credits: {},
        updatedAt: 1700000003000,
      },
    }),
  })

  await adapter.refreshSnapshots(store)

  assert.equal(store.active, "acct_renamed")
  assert.equal(Object.hasOwn(store.accounts, "pending"), false)
  assert.equal(Object.hasOwn(store.accounts, "acct_renamed"), true)
})

test("codex adapter refreshSnapshots removes invalid account on invalid_account and switches openai auth", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const setCalls = []
  const store = {
    accounts: {
      acct_invalid: {
        name: "acct_invalid",
        providerId: "openai",
        refresh: "refresh_invalid",
        access: "access_invalid",
        accountId: "acct_invalid",
      },
      acct_backup: {
        name: "acct_backup",
        providerId: "openai",
        refresh: "refresh_backup",
        access: "access_backup",
        accountId: "acct_backup",
        snapshot: {
          usage5h: { remaining: 10, resetAt: 1700003600000 },
          usageWeek: { remaining: 20, resetAt: 1700600000000 },
        },
      },
    },
    active: "acct_invalid",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient(setCalls),
    now: () => 1700000003500,
    fetchStatus: async ({ oauth }) => {
      if (oauth.access === "access_invalid") {
        return {
          ok: false,
          error: {
            kind: "invalid_account",
            status: 400,
            message: "refresh token invalid",
          },
        }
      }

      return {
        ok: true,
        status: {
          identity: {
            accountId: "acct_backup",
            email: "backup@example.com",
            plan: "pro",
            workspaceName: "backup-workspace",
          },
          windows: {
            primary: { entitlement: 100, remaining: 70, used: 30, resetAt: 1700003600000 },
            secondary: { entitlement: 100, remaining: 50, used: 50, resetAt: 1700600000000 },
          },
          credits: {},
          updatedAt: 1700000003500,
        },
      }
    },
  })

  await adapter.refreshSnapshots(store)

  assert.equal(Object.hasOwn(store.accounts, "acct_invalid"), false)
  assert.equal(store.active, "acct_backup")
  assert.equal(setCalls.length, 1)
  assert.equal(setCalls[0]?.path?.id, "openai")
  assert.equal(setCalls[0]?.body?.accountId, "acct_backup")
  assert.equal(store.accounts.acct_backup.workspaceName, "backup-workspace")
})

test("codex adapter refreshSnapshots exposes week-only replacement warning metadata", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_invalid: {
        name: "acct_invalid",
        providerId: "openai",
        refresh: "refresh_invalid",
        access: "access_invalid",
        accountId: "acct_invalid",
      },
      acct_week_only: {
        name: "acct_week_only",
        providerId: "openai",
        refresh: "refresh_week",
        access: "access_week",
        accountId: "acct_week_only",
        snapshot: {
          usage5h: { remaining: 0, resetAt: 1700005600000 },
          usageWeek: { remaining: 8, resetAt: 1700605600000 },
        },
      },
    },
    active: "acct_invalid",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000003600,
    fetchStatus: async ({ oauth }) => {
      if (oauth.access === "access_invalid") {
        return {
          ok: false,
          error: {
            kind: "invalid_account",
            status: 400,
            message: "invalid account",
          },
        }
      }

      return {
        ok: true,
        status: {
          identity: {
            accountId: "acct_week_only",
            email: "week@example.com",
            plan: "team",
          },
          windows: {
            primary: { entitlement: 100, remaining: 0, used: 100, resetAt: 1700005600000 },
            secondary: { entitlement: 100, remaining: 8, used: 92, resetAt: 1700605600000 },
          },
          credits: {},
          updatedAt: 1700000003600,
        },
      }
    },
  })

  await adapter.refreshSnapshots(store)

  assert.equal(store.active, "acct_week_only")
  assert.equal(Object.hasOwn(store.accounts, "acct_invalid"), false)
  assert.equal(store.accounts.acct_week_only.snapshot?.recoveryWarning?.code, "week_recovery_only")
  assert.equal(store.accounts.acct_week_only.snapshot?.recoveryWarning?.removed, "acct_invalid")
  assert.equal(store.accounts.acct_week_only.snapshot?.recoveryWarning?.replacement, "acct_week_only")
})

test("codex adapter refreshSnapshots does not set week-only warning when replacement week quota is also exhausted", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_invalid: {
        name: "acct_invalid",
        providerId: "openai",
        refresh: "refresh_invalid",
        access: "access_invalid",
        accountId: "acct_invalid",
      },
      acct_exhausted: {
        name: "acct_exhausted",
        providerId: "openai",
        refresh: "refresh_exhausted",
        access: "access_exhausted",
        accountId: "acct_exhausted",
        snapshot: {
          usage5h: { remaining: 0, resetAt: 1700005600000 },
          usageWeek: { remaining: 0, resetAt: 1700605600000 },
        },
      },
    },
    active: "acct_invalid",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000003620,
    fetchStatus: async ({ oauth }) => {
      if (oauth.access === "access_invalid") {
        return {
          ok: false,
          error: {
            kind: "invalid_account",
            status: 400,
            message: "invalid account",
          },
        }
      }

      return {
        ok: true,
        status: {
          identity: {
            accountId: "acct_exhausted",
            email: "exhausted@example.com",
            plan: "team",
          },
          windows: {
            primary: { entitlement: 100, remaining: 0, used: 100, resetAt: 1700005600000 },
            secondary: { entitlement: 100, remaining: 0, used: 100, resetAt: 1700605600000 },
          },
          credits: {},
          updatedAt: 1700000003620,
        },
      }
    },
  })

  await adapter.refreshSnapshots(store)

  assert.equal(store.active, "acct_exhausted")
  assert.equal(Object.hasOwn(store.accounts, "acct_invalid"), false)
  assert.equal(store.accounts.acct_exhausted.snapshot?.recoveryWarning, undefined)
})

test("codex adapter refreshSnapshots writes week-only warning even when replacement is refreshed before invalid account", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_week_first: {
        name: "acct_week_first",
        providerId: "openai",
        refresh: "refresh_week_first",
        access: "access_week_first",
        accountId: "acct_week_first",
      },
      acct_invalid_later: {
        name: "acct_invalid_later",
        providerId: "openai",
        refresh: "refresh_invalid_later",
        access: "access_invalid_later",
        accountId: "acct_invalid_later",
      },
    },
    active: "acct_invalid_later",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000003650,
    fetchStatus: async ({ oauth }) => {
      if (oauth.access === "access_week_first") {
        return {
          ok: true,
          status: {
            identity: {
              accountId: "acct_week_first",
              email: "week-first@example.com",
              plan: "team",
            },
            windows: {
              primary: { entitlement: 100, remaining: 0, used: 100, resetAt: 1700005600000 },
              secondary: { entitlement: 100, remaining: 12, used: 88, resetAt: 1700605600000 },
            },
            credits: {},
            updatedAt: 1700000003650,
          },
        }
      }

      return {
        ok: false,
        error: {
          kind: "invalid_account",
          status: 400,
          message: "invalid account",
        },
      }
    },
  })

  await adapter.refreshSnapshots(store)

  assert.equal(store.active, "acct_week_first")
  assert.equal(Object.hasOwn(store.accounts, "acct_invalid_later"), false)
  assert.equal(store.accounts.acct_week_first.snapshot?.recoveryWarning?.code, "week_recovery_only")
  assert.equal(store.accounts.acct_week_first.snapshot?.recoveryWarning?.removed, "acct_invalid_later")
  assert.equal(store.accounts.acct_week_first.snapshot?.recoveryWarning?.replacement, "acct_week_first")
})

test("codex adapter refreshSnapshots clears stale week-only recovery warning when no longer applicable", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_clear_warning: {
        name: "acct_clear_warning",
        providerId: "openai",
        refresh: "refresh_clear_warning",
        access: "access_clear_warning",
        accountId: "acct_clear_warning",
        snapshot: {
          recoveryWarning: {
            code: "week_recovery_only",
            removed: "acct_old",
            replacement: "acct_clear_warning",
          },
          usage5h: { entitlement: 100, remaining: 0, used: 100, resetAt: 1700005600000 },
          usageWeek: { entitlement: 100, remaining: 8, used: 92, resetAt: 1700605600000 },
          updatedAt: 1700000003600,
        },
      },
    },
    active: "acct_clear_warning",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000003660,
    fetchStatus: async () => ({
      ok: true,
      status: {
        identity: {
          accountId: "acct_clear_warning",
          email: "clear@example.com",
          plan: "team",
        },
        windows: {
          primary: { entitlement: 100, remaining: 7, used: 93, resetAt: 1700005600000 },
          secondary: { entitlement: 100, remaining: 12, used: 88, resetAt: 1700605600000 },
        },
        credits: {},
        updatedAt: 1700000003660,
      },
    }),
  })

  await adapter.refreshSnapshots(store)

  assert.equal(store.accounts.acct_clear_warning.snapshot?.recoveryWarning, undefined)
  assert.equal(store.accounts.acct_clear_warning.snapshot?.usage5h?.remaining, 7)
})

test("codex adapter refreshSnapshots keeps account on non-400 invalid fetch errors", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const setCalls = []
  const store = {
    accounts: {
      acct_error: {
        name: "acct_error",
        providerId: "openai",
        refresh: "refresh_error",
        access: "access_error",
        accountId: "acct_error",
      },
    },
    active: "acct_error",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient(setCalls),
    now: () => 1700000003700,
    fetchStatus: async () => ({
      ok: false,
      error: {
        kind: "network_error",
        message: "codex usage request failed with status 503",
      },
    }),
  })

  await adapter.refreshSnapshots(store)

  assert.equal(Object.hasOwn(store.accounts, "acct_error"), true)
  assert.equal(store.active, "acct_error")
  assert.equal(store.accounts.acct_error.snapshot?.error, "codex usage request failed with status 503")
  assert.equal(setCalls.length, 0)
})

test("codex adapter refreshSnapshots records fetch exceptions as snapshot errors", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_error: {
        name: "acct_error",
        providerId: "openai",
        refresh: "refresh_error",
        access: "access_error",
        accountId: "acct_error",
      },
    },
    active: "acct_error",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000004000,
    fetchStatus: async () => {
      throw new Error("fetch exploded")
    },
  })

  await assert.doesNotReject(adapter.refreshSnapshots(store))
  assert.equal(store.accounts.acct_error.snapshot?.error, "fetch exploded")
  assert.equal(store.accounts.acct_error.snapshot?.updatedAt, 1700000004000)
})

test("codex adapter refreshSnapshots keeps distinct accounts when rename target already exists", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {
      acct_existing: {
        name: "acct_existing",
        providerId: "openai",
        refresh: "refresh_existing",
        access: "access_existing",
        accountId: "acct_existing",
        email: "existing@example.com",
      },
      pending: {
        name: "pending",
        providerId: "openai",
        refresh: "refresh_pending",
        access: "access_pending",
        email: "pending@example.com",
      },
    },
    active: "pending",
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000004500,
    fetchStatus: async ({ oauth }) => {
      if (oauth.access === "access_existing") {
        return {
          ok: true,
          status: {
            identity: {
              accountId: "acct_existing",
              email: "existing@example.com",
              plan: "team",
            },
            windows: {
              primary: { entitlement: 100, remaining: 50, used: 50, resetAt: 1700003600000 },
              secondary: { entitlement: 100, remaining: 40, used: 60, resetAt: 1700600000000 },
            },
            credits: {},
            updatedAt: 1700000004500,
          },
        }
      }

      return {
        ok: true,
        status: {
          identity: {
            accountId: "acct_existing",
            email: "other@example.com",
            plan: "pro",
          },
          windows: {
            primary: { entitlement: 100, remaining: 80, used: 20, resetAt: 1700003600000 },
            secondary: { entitlement: 100, remaining: 70, used: 30, resetAt: 1700600000000 },
          },
          credits: {},
          updatedAt: 1700000004500,
        },
      }
    },
  })

  await adapter.refreshSnapshots(store)

  assert.equal(Object.keys(store.accounts).length, 2)
  assert.equal(store.accounts.acct_existing.email, "existing@example.com")
  assert.equal(store.accounts["acct_existing#2"]?.email, "other@example.com")
  assert.equal(store.active, "acct_existing#2")
})

test("codex adapter addAccount activates resolved fallback key when entry name is missing", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000005000,
  })

  const result = await adapter.addAccount(store, {
    providerId: "openai",
    refresh: "refresh_added",
    access: "access_added",
    accountId: "acct_added",
    email: "added@example.com",
    addedAt: 1700000005000,
  })

  assert.equal(result, true)
  assert.equal(store.active, "acct_added")
  assert.equal(store.accounts.acct_added.accountId, "acct_added")
})

test("codex adapter ignores empty accountId and email when deriving account name", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient([]),
    now: () => 1700000006000,
  })

  await adapter.addAccount(store, {
    providerId: "openai",
    refresh: "refresh_blank",
    access: "access_blank",
    accountId: "",
    email: "",
  })

  assert.equal(Object.hasOwn(store.accounts, ""), false)
  assert.equal(store.active, "openai")
})
