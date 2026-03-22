import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function loadCodexStoreOrFail() {
  try {
    return await import("../dist/codex-store.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("codex store module is missing: ../dist/codex-store.js")
    }
    throw error
  }
}

test("codex store read/write upgrades legacy snapshot and persists multi-account shape", async () => {
  const { codexStorePath, readCodexStore, writeCodexStore } = await loadCodexStoreOrFail()

  assert.notEqual(path.basename(codexStorePath()), "copilot-accounts.json")

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-store-"))
  const file = path.join(dir, "codex-store.json")

  await writeFile(
    file,
    JSON.stringify(
      {
        activeProvider: "codex",
        activeAccountId: "acct_1",
        activeEmail: "codex@example.com",
        lastStatusRefresh: 123,
        account: {
          id: "acct_1",
          email: "codex@example.com",
          plan: "pro",
        },
        status: {
          premium: {
            entitlement: 100,
            remaining: 88,
          },
        },
        modelAccountAssignments: {
          "gpt-5": ["copilot-main"],
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = await readCodexStore(file)

  assert.deepEqual(store, {
    accounts: {
      acct_1: {
        name: "acct_1",
        providerId: "codex",
        accountId: "acct_1",
        email: "codex@example.com",
        snapshot: {
          plan: "pro",
          usage5h: {
            entitlement: 100,
            remaining: 88,
          },
          updatedAt: 123,
        },
      },
    },
    active: "acct_1",
    lastSnapshotRefresh: 123,
  })

  await writeCodexStore(
    {
      accounts: {
        acct_2: {
          name: "acct_2",
          providerId: "codex",
          accountId: "acct_2",
          email: "new@example.com",
          snapshot: {
            usage5h: {
              entitlement: 200,
              remaining: 150,
            },
            updatedAt: 456,
          },
        },
      },
      active: "acct_2",
      lastSnapshotRefresh: 456,
    },
    { filePath: file },
  )

  const raw = JSON.parse(await readFile(file, "utf8"))
  assert.equal(Object.hasOwn(raw, "modelAccountAssignments"), false)
  assert.equal(Object.hasOwn(raw, "activeProvider"), false)
  assert.equal(Object.hasOwn(raw, "activeAccountId"), false)
  assert.equal(Object.hasOwn(raw, "activeEmail"), false)
  assert.equal(Object.hasOwn(raw, "account"), false)
  assert.equal(Object.hasOwn(raw, "status"), false)
  assert.deepEqual(raw, {
    accounts: {
      acct_2: {
        name: "acct_2",
        providerId: "codex",
        accountId: "acct_2",
        email: "new@example.com",
        snapshot: {
          usage5h: {
            entitlement: 200,
            remaining: 150,
          },
          updatedAt: 456,
        },
      },
    },
    active: "acct_2",
    lastSnapshotRefresh: 456,
  })
})

test("codex store upgrades legacy single-snapshot data into default account entry", async () => {
  const { readCodexStore } = await loadCodexStoreOrFail()

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-store-legacy-"))
  const file = path.join(dir, "codex-store.json")

  await writeFile(
    file,
    JSON.stringify(
      {
        activeProvider: "codex",
        activeAccountId: "acct_legacy",
        activeEmail: "legacy@example.com",
        lastStatusRefresh: 1700000000000,
        account: {
          id: "acct_legacy",
          email: "legacy@example.com",
          plan: "plus",
        },
        status: {
          premium: {
            entitlement: 100,
            remaining: 66,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = await readCodexStore(file)

  assert.equal(store.active, "acct_legacy")
  assert.equal(store.lastSnapshotRefresh, 1700000000000)
  assert.deepEqual(Object.keys(store.accounts), ["acct_legacy"])
  assert.deepEqual(store.accounts.acct_legacy, {
    name: "acct_legacy",
    providerId: "codex",
    accountId: "acct_legacy",
    email: "legacy@example.com",
    snapshot: {
      plan: "plus",
      usage5h: {
        entitlement: 100,
        remaining: 66,
      },
      updatedAt: 1700000000000,
    },
  })
})

test("codex store preserves bootstrap import markers in multi-account shape", async () => {
  const { readCodexStore, writeCodexStore } = await loadCodexStoreOrFail()

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-store-bootstrap-"))
  const file = path.join(dir, "codex-store.json")

  await writeCodexStore(
    {
      active: "team-main",
      lastSnapshotRefresh: 1700000000999,
      bootstrapAuthImportTried: true,
      bootstrapAuthImportAt: 1700000000000,
      accounts: {
        "team-main": {
          name: "team-main",
          providerId: "codex",
          accountId: "acct_team",
          email: "team@example.com",
          snapshot: {
            plan: "team",
            usage5h: {
              entitlement: 100,
              remaining: 50,
            },
            usageWeek: {
              entitlement: 100,
              remaining: 25,
            },
            updatedAt: 1700000000999,
          },
        },
      },
    },
    { filePath: file },
  )

  const store = await readCodexStore(file)
  const raw = JSON.parse(await readFile(file, "utf8"))

  assert.equal(store.bootstrapAuthImportTried, true)
  assert.equal(store.bootstrapAuthImportAt, 1700000000000)
  assert.equal(store.active, "team-main")
  assert.equal(raw.bootstrapAuthImportTried, true)
  assert.equal(raw.bootstrapAuthImportAt, 1700000000000)
  assert.equal(Object.hasOwn(raw, "activeAccountId"), false)
  assert.equal(Object.hasOwn(raw, "activeEmail"), false)
  assert.equal(Object.hasOwn(raw, "account"), false)
  assert.equal(Object.hasOwn(raw, "status"), false)
})

test("codex store marks bootstrapAuthImportTried even when auth.json has no importable openai account", async () => {
  const { readCodexStore, writeCodexStore } = await loadCodexStoreOrFail()

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-store-bootstrap-empty-"))
  const file = path.join(dir, "codex-store.json")

  await writeCodexStore(
    {
      accounts: {},
      bootstrapAuthImportTried: true,
      bootstrapAuthImportAt: 1700001234567,
    },
    { filePath: file },
  )

  const store = await readCodexStore(file)

  assert.deepEqual(store.accounts, {})
  assert.equal(store.bootstrapAuthImportTried, true)
  assert.equal(store.bootstrapAuthImportAt, 1700001234567)
})

test("codex store upgrades legacy fields even when mixed with empty new-shape accounts", async () => {
  const { readCodexStore } = await loadCodexStoreOrFail()

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-store-mixed-legacy-"))
  const file = path.join(dir, "codex-store.json")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {},
        active: undefined,
        activeAccountId: "acct_mixed",
        activeEmail: "mixed@example.com",
        lastStatusRefresh: 1700002222333,
        account: {
          id: "acct_mixed",
          email: "mixed@example.com",
          plan: "team",
        },
        status: {
          premium: {
            entitlement: 100,
            remaining: 77,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = await readCodexStore(file)

  assert.equal(store.active, "acct_mixed")
  assert.equal(store.lastSnapshotRefresh, 1700002222333)
  assert.deepEqual(store.accounts.acct_mixed, {
    name: "acct_mixed",
    providerId: "codex",
    accountId: "acct_mixed",
    email: "mixed@example.com",
    snapshot: {
      plan: "team",
      usage5h: {
        entitlement: 100,
        remaining: 77,
      },
      updatedAt: 1700002222333,
    },
  })
})

test("codex store ignores legacy account injection when new-shape accounts already exist", async () => {
  const { readCodexStore } = await loadCodexStoreOrFail()

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-store-new-wins-"))
  const file = path.join(dir, "codex-store.json")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          current: {
            name: "current",
            providerId: "codex",
            accountId: "acct_current",
            email: "current@example.com",
            snapshot: {
              plan: "team",
              usage5h: {
                entitlement: 100,
                remaining: 81,
              },
            },
          },
        },
        active: "current",
        activeAccountId: "acct_legacy",
        activeEmail: "legacy@example.com",
        lastStatusRefresh: 1700003333444,
        account: {
          id: "acct_legacy",
          email: "legacy@example.com",
          plan: "plus",
        },
        status: {
          premium: {
            entitlement: 100,
            remaining: 12,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = await readCodexStore(file)

  assert.equal(store.active, "current")
  assert.deepEqual(Object.keys(store.accounts), ["current"])
  assert.equal(store.accounts.current.accountId, "acct_current")
  assert.equal(store.accounts.current.snapshot?.plan, "team")
  assert.equal(store.lastSnapshotRefresh, 1700003333444)
})

test("codex store keeps new-shape lastSnapshotRefresh when legacy metadata has no account to migrate", async () => {
  const { readCodexStore } = await loadCodexStoreOrFail()

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-store-last-refresh-"))
  const file = path.join(dir, "codex-store.json")

  await writeFile(
    file,
    JSON.stringify(
      {
        accounts: {
          current: {
            name: "current",
            providerId: "codex",
            accountId: "acct_current",
            email: "current@example.com",
          },
        },
        active: "current",
        lastSnapshotRefresh: 1700005555666,
        lastStatusRefresh: 1600000000000,
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = await readCodexStore(file)

  assert.equal(store.active, "current")
  assert.equal(store.lastSnapshotRefresh, 1700005555666)
})
