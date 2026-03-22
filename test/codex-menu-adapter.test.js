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

async function loadCodexOAuthOrFail() {
  try {
    return await import("../dist/codex-oauth.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("codex oauth module is missing: ../dist/codex-oauth.js")
    }
    throw error
  }
}

function createTestJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
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
  assert.deepEqual(menuInfo[0].quota?.premium, { remaining: 42, entitlement: 100 })
  assert.deepEqual(menuInfo[0].quota?.chat, { remaining: 6, entitlement: 100 })
  assert.equal(store.accounts.acct_plan.snapshot?.usage5h?.remaining, 42)
  assert.equal(store.accounts.acct_plan.snapshot?.usageWeek?.remaining, 6)
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

test("codex adapter authorizeNewAccount normalizes oauth result into openai entry", async () => {
  const { createCodexMenuAdapter } = await loadCodexMenuAdapterOrFail()
  const setCalls = []
  let oauthCalls = 0
  const store = {
    accounts: {},
    active: undefined,
    autoRefresh: false,
    refreshMinutes: 15,
  }

  const adapter = createCodexMenuAdapter({
    client: createClient(setCalls),
    now: () => 1700000000666,
    runCodexOAuth: async () => {
      oauthCalls += 1
      return {
        refresh: "refresh_new",
        access: "access_new",
        expires: 1700003600000,
        accountId: "acct_new",
        email: "new@example.com",
      }
    },
  })

  const entry = await adapter.authorizeNewAccount(store)

  assert.equal(oauthCalls, 1)
  assert.equal(entry?.providerId, "openai")
  assert.equal(entry?.refresh, "refresh_new")
  assert.equal(entry?.access, "access_new")
  assert.equal(entry?.accountId, "acct_new")
  assert.equal(entry?.email, "new@example.com")
  assert.equal(entry?.addedAt, 1700000000666)
  assert.equal(setCalls.length, 1)
  assert.equal(setCalls[0]?.path?.id, "openai")
})

test("runCodexOAuth normalizes browser tokens with upstream account-id claims", async () => {
  const { runCodexOAuth } = await loadCodexOAuthOrFail()

  const result = await runCodexOAuth({
    now: () => 1700000001000,
    selectMode: async () => "browser",
    runBrowserAuth: async () => ({
      id_token: createTestJwt({
        email: "browser@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_browser" },
      }),
      access_token: "access_browser",
      refresh_token: "refresh_browser",
      expires_in: 3600,
    }),
  })

  assert.deepEqual(result, {
    refresh: "refresh_browser",
    access: "access_browser",
    expires: 1700003601000,
    accountId: "acct_browser",
    email: "browser@example.com",
  })
})

test("runCodexOAuth normalizes headless device tokens with organization fallback", async () => {
  const { runCodexOAuth } = await loadCodexOAuthOrFail()

  const result = await runCodexOAuth({
    now: () => 1700000002000,
    selectMode: async () => "headless",
    runDeviceAuth: async () => ({
      id_token: createTestJwt({
        email: "device@example.com",
        organizations: [{ id: "acct_device" }],
      }),
      access_token: "access_device",
      refresh_token: "refresh_device",
      expires_in: 7200,
    }),
  })

  assert.deepEqual(result, {
    refresh: "refresh_device",
    access: "access_device",
    expires: 1700007202000,
    accountId: "acct_device",
    email: "device@example.com",
  })
})

test("runCodexOAuth headless mode honors timeout instead of polling forever", async () => {
  const { runCodexOAuth } = await loadCodexOAuthOrFail()

  await assert.rejects(
    runCodexOAuth({
      now: () => 1700000002500,
      timeoutMs: 1,
      selectMode: async () => "headless",
      fetchImpl: async (url) => {
        const target = String(url)
        if (target.includes("/usercode")) {
          return new Response(JSON.stringify({
            device_auth_id: "device_1",
            user_code: "ABCD-EFGH",
            interval: "0",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      },
      log: () => {},
    }),
    /timeout/i,
  )
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
