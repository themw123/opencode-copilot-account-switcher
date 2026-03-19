import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"

import {
  appendSessionTouchEvent,
  buildCandidateAccountLoads,
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

test("session-touch writes are throttled to once per minute per account-session pair", async () => {
  await withRoutingStateDir(async (dir) => {
    const lastTouchWrites = new Map()

    await appendSessionTouchEvent({
      directory: dir,
      accountName: "main",
      sessionID: "s1",
      at: 100_000,
      lastTouchWrites,
    })
    await appendSessionTouchEvent({
      directory: dir,
      accountName: "main",
      sessionID: "s1",
      at: 120_000,
      lastTouchWrites,
    })
    await appendSessionTouchEvent({
      directory: dir,
      accountName: "main",
      sessionID: "s1",
      at: 161_000,
      lastTouchWrites,
    })
    await appendSessionTouchEvent({
      directory: dir,
      accountName: "main",
      sessionID: "s2",
      at: 120_000,
      lastTouchWrites,
    })

    const activeLog = await readFile(path.join(dir, "active.log"), "utf8")
    const events = activeLog
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.equal(events.length, 3)
    assert.deepEqual(events.map((item) => item.sessionID), ["s1", "s1", "s2"])
    assert.equal(events[0].at, 100_000)
    assert.equal(events[1].at, 161_000)
  })
})

test("session-touch write path supports injected append handler", async () => {
  const captured = []
  const lastTouchWrites = new Map()

  const result = await appendSessionTouchEvent({
    directory: "C:/tmp/ignored-by-test",
    accountName: "main",
    sessionID: "s1",
    at: 100_000,
    lastTouchWrites,
    appendEvent: async (input) => {
      captured.push(input)
    },
  })

  assert.equal(result, true)
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.directory, "C:/tmp/ignored-by-test")
  assert.equal(captured[0]?.event?.type, "session-touch")
  assert.equal(captured[0]?.event?.accountName, "main")
  assert.equal(captured[0]?.event?.sessionID, "s1")
})

test("load comparison counts distinct sessions used within 30 minutes", () => {
  const now = 2_000_000
  const loads = buildCandidateAccountLoads({
    snapshot: {
      accounts: {
        main: {
          sessions: {
            s1: now - 10_000,
            s2: now - 20_000,
            stale: now - (30 * 60 * 1000) - 1,
          },
        },
        alt: {
          sessions: {
            s9: now - 5_000,
          },
        },
      },
      appliedSegments: [],
    },
    candidateAccountNames: ["main", "alt", "missing"],
    now,
  })

  assert.equal(loads.get("main"), 2)
  assert.equal(loads.get("alt"), 1)
  assert.equal(loads.get("missing"), 0)
})
