import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"

import {
  compactRoutingSnapshot,
  foldRoutingEvents,
  readRoutingState,
} from "../dist/routing-state.js"

async function withRoutingStateDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "routing-state-"))
  await mkdir(dir, { recursive: true })
  return run(dir)
}

test("readRoutingState merges snapshot active and unapplied sealed segments", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: {
          sessions: {
            s0: 50,
          },
        },
      },
      appliedSegments: ["sealed-100.log"],
    }), "utf8")

    await writeFile(path.join(dir, "active.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s1",
      at: 100,
    })}\n`, "utf8")

    await writeFile(path.join(dir, "sealed-100.log"), `${JSON.stringify({
      type: "rate-limit-flagged",
      accountName: "main",
      at: 300,
    })}\n`, "utf8")

    await writeFile(path.join(dir, "sealed-200.log"), `${JSON.stringify({
      type: "rate-limit-flagged",
      accountName: "main",
      at: 200,
    })}\n`, "utf8")

    const state = await readRoutingState(dir)

    assert.equal(state.accounts.main.sessions.s0, 50)
    assert.equal(state.accounts.main.sessions.s1, 100)
    assert.equal(state.accounts.main.lastRateLimitedAt, 200)
    assert.deepEqual(state.appliedSegments, ["sealed-100.log", "sealed-200.log"])
  })
})

test("readRoutingState checkpoints newly consumed sealed segments and prevents reprocessing after snapshot update", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: {
          sessions: {
            s1: 100,
          },
        },
      },
      appliedSegments: [],
    }), "utf8")

    await writeFile(path.join(dir, "sealed-1.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s1",
      at: 200,
    })}\n`, "utf8")

    const first = await readRoutingState(dir)
    assert.equal(first.accounts.main.sessions.s1, 200)
    assert.deepEqual(first.appliedSegments, ["sealed-1.log"])

    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify(first), "utf8")
    await writeFile(path.join(dir, "sealed-1.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s1",
      at: 999,
    })}\n`, "utf8")

    const second = await readRoutingState(dir)
    assert.equal(second.accounts.main.sessions.s1, 200)
    assert.deepEqual(second.appliedSegments, ["sealed-1.log"])
  })
})

test("foldRoutingEvents is idempotent for duplicate session-touch events", () => {
  const next = foldRoutingEvents({
    accounts: {},
    appliedSegments: [],
  }, [
    { type: "session-touch", accountName: "main", sessionID: "s1", at: 100 },
    { type: "session-touch", accountName: "main", sessionID: "s1", at: 100 },
    { type: "session-touch", accountName: "main", sessionID: "s1", at: 80 },
  ])

  assert.deepEqual(Object.keys(next.accounts.main.sessions), ["s1"])
  assert.equal(next.accounts.main.sessions.s1, 100)
})

test("readRoutingState ignores sealed segments already listed in appliedSegments", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: {
          sessions: {
            s1: 100,
          },
        },
      },
      appliedSegments: ["sealed-1.log"],
    }), "utf8")

    await writeFile(path.join(dir, "sealed-1.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s1",
      at: 999,
    })}\n`, "utf8")

    const state = await readRoutingState(dir)

    assert.equal(state.accounts.main.sessions.s1, 100)
  })
})

test("readRoutingState recovers from a broken snapshot by replaying logs", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), "{", "utf8")
    await writeFile(path.join(dir, "active.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s1",
      at: 100,
    })}\n`, "utf8")
    await writeFile(path.join(dir, "sealed-1.log"), `${JSON.stringify({
      type: "rate-limit-flagged",
      accountName: "main",
      at: 200,
    })}\n`, "utf8")

    const state = await readRoutingState(dir)

    assert.equal(state.accounts.main.sessions.s1, 100)
    assert.equal(state.accounts.main.lastRateLimitedAt, 200)
    assert.deepEqual(state.appliedSegments, ["sealed-1.log"])
  })
})

test("readRoutingState surfaces non-ENOENT filesystem read errors", async () => {
  await withRoutingStateDir(async (dir) => {
    await mkdir(path.join(dir, "snapshot.json"), { recursive: true })

    await assert.rejects(
      () => readRoutingState(dir),
      (error) => error?.code === "EISDIR",
    )
  })
})

test("compactRoutingSnapshot removes expired sessions and keeps rate-limit watermark", () => {
  const now = 1_000_000
  const state = compactRoutingSnapshot({
    accounts: {
      main: {
        sessions: {
          stale: now - (30 * 60 * 1000) - 1,
          fresh: now - (30 * 60 * 1000) + 1,
        },
        lastRateLimitedAt: 123,
      },
    },
    appliedSegments: ["sealed-1.log"],
  }, now)

  assert.equal(state.accounts.main.sessions.stale, undefined)
  assert.equal(state.accounts.main.sessions.fresh, now - (30 * 60 * 1000) + 1)
  assert.equal(state.accounts.main.lastRateLimitedAt, 123)
  assert.deepEqual(state.appliedSegments, ["sealed-1.log"])
})
