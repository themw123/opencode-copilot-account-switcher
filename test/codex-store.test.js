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

test("codex store read/write persists codex-only snapshots without copilot fields", async () => {
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
  })

  await writeCodexStore(
    {
      activeProvider: "codex",
      activeAccountId: "acct_2",
      activeEmail: "new@example.com",
      lastStatusRefresh: 456,
      account: {
        id: "acct_2",
        email: "new@example.com",
      },
      status: {
        premium: {
          entitlement: 200,
          remaining: 150,
        },
      },
    },
    { filePath: file },
  )

  const raw = JSON.parse(await readFile(file, "utf8"))
  assert.equal(Object.hasOwn(raw, "modelAccountAssignments"), false)
  assert.equal(Object.hasOwn(raw, "accounts"), false)
  assert.equal(Object.hasOwn(raw, "active"), false)
  assert.deepEqual(raw, {
    activeProvider: "codex",
    activeAccountId: "acct_2",
    activeEmail: "new@example.com",
    lastStatusRefresh: 456,
    account: {
      id: "acct_2",
      email: "new@example.com",
    },
    status: {
      premium: {
        entitlement: 200,
        remaining: 150,
      },
    },
  })
})
