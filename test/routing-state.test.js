import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"

import {
  appendRoutingEvent,
  appendRouteDecisionEvent,
  appendSessionTouchEvent,
  buildCandidateAccountLoads,
  compactRoutingState,
  compactRoutingSnapshot,
  foldRoutingEvents,
  readRoutingState,
  rotateActiveLog,
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
          touchBuckets: {
            "0": 1,
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

    assert.equal(state.accounts.main.touchBuckets[0], 2)
    assert.equal(state.accounts.main.lastRateLimitedAt, 200)
    assert.deepEqual(state.appliedSegments, ["sealed-100.log", "sealed-200.log"])
  })
})

test("readRoutingState checkpoints newly consumed sealed segments and prevents reprocessing after snapshot update", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: {
          touchBuckets: {
            "0": 1,
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
    assert.equal(first.accounts.main.touchBuckets[0], 2)
    assert.deepEqual(first.appliedSegments, ["sealed-1.log"])

    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify(first), "utf8")
    await writeFile(path.join(dir, "sealed-1.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s1",
      at: 999,
    })}\n`, "utf8")

    const second = await readRoutingState(dir)
    assert.equal(second.accounts.main.touchBuckets[0], 2)
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

  assert.equal(next.accounts.main.touchBuckets[0], 1)
})

test("readRoutingState ignores sealed segments already listed in appliedSegments", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: {
          touchBuckets: {
            "0": 1,
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

    assert.equal(state.accounts.main.touchBuckets[0], 1)
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

    assert.equal(state.accounts.main.touchBuckets[0], 1)
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

test("compactRoutingSnapshot removes expired touch buckets and keeps rate-limit watermark", () => {
  const now = 1_000_000
  const state = compactRoutingSnapshot({
    accounts: {
      main: {
        touchBuckets: {
          [String(now - (30 * 60 * 1000) - 60_000)]: 2,
          [String(now - (30 * 60 * 1000) + 60_000)]: 3,
        },
        lastRateLimitedAt: 123,
      },
    },
    appliedSegments: ["sealed-1.log"],
  }, now)

  assert.equal(state.accounts.main.touchBuckets[String(now - (30 * 60 * 1000) - 60_000)], undefined)
  assert.equal(state.accounts.main.touchBuckets[String(now - (30 * 60 * 1000) + 60_000)], 3)
  assert.equal(state.accounts.main.lastRateLimitedAt, 123)
  assert.deepEqual(state.appliedSegments, ["sealed-1.log"])
})

test("appendRouteDecisionEvent writes to decisions.log and readRoutingState ignores decisions log entries", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "active.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s1",
      at: 120_000,
    })}\n`, "utf8")

    await writeFile(path.join(dir, "decisions.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "alt",
      sessionID: "from-decisions",
      at: 180_000,
    })}\n${JSON.stringify({
      type: "rate-limit-flagged",
      accountName: "alt",
      at: 181_000,
    })}\n`, "utf8")

    const decisions = await readFile(path.join(dir, "decisions.log"), "utf8")
    assert.match(decisions, /from-decisions/)

    const state = await readRoutingState(dir)
    assert.deepEqual(state.accounts.main?.touchBuckets, { "120000": 1 })
    assert.equal(state.accounts.main?.lastRateLimitedAt, undefined)
    assert.equal(state.accounts.alt, undefined)
  })
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

test("load comparison sums touch counts within 30 minutes", () => {
  const now = 2_000_000
  const loads = buildCandidateAccountLoads({
    snapshot: {
      accounts: {
        main: {
          touchBuckets: {
            [String(Math.floor((now - 10_000) / 60_000) * 60_000)]: 2,
            [String(Math.floor((now - (30 * 60 * 1000) - 1) / 60_000) * 60_000)]: 1,
          },
        },
        alt: {
          touchBuckets: {
            [String(Math.floor((now - 5_000) / 60_000) * 60_000)]: 1,
          },
        },
      },
      appliedSegments: [],
    },
    candidateAccountNames: ["main", "alt", "missing"],
    now,
  })

  assert.equal(loads.get("main"), 3)
  assert.equal(loads.get("alt"), 1)
  assert.equal(loads.get("missing"), 0)
})

test("buildCandidateAccountLoads sums touch buckets within the rolling window", async () => {
  const { buildCandidateAccountLoads } = await import("../dist/routing-state.js")

  const loads = buildCandidateAccountLoads({
    snapshot: {
      accounts: {
        main: { touchBuckets: { "1000": 2, "61000": 3 } },
        alt: { touchBuckets: { "1000": 1 } },
      },
      appliedSegments: [],
    },
    candidateAccountNames: ["main", "alt"],
    now: 61_000,
  })

  assert.equal(loads.get("main"), 5)
  assert.equal(loads.get("alt"), 1)
})

test("buildCandidateAccountLoads includes the bucket overlapping the rolling cutoff", () => {
  const now = (30 * 60 * 1000) + 60_001
  const loads = buildCandidateAccountLoads({
    snapshot: {
      accounts: {
        main: {
          touchBuckets: {
            "0": 2,
            "60000": 4,
          },
        },
      },
      appliedSegments: [],
    },
    candidateAccountNames: ["main"],
    now,
  })

  assert.equal(loads.get("main"), 4)
})

test("readRoutingState converts legacy sessions into touch buckets", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: { sessions: { s1: 60_000, s2: 61_000 } },
      },
      appliedSegments: [],
    }), "utf8")

    const state = await readRoutingState(dir)
    assert.equal(state.accounts.main.touchBuckets[60_000], 2)
  })
})

test("append and rotate racing together do not drop a session-touch event", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "active.log"), "", "utf8")

    const rotate = rotateActiveLog({
      directory: dir,
      now: 1_000,
      pid: 42,
      beforeCreateActiveLog: async () => {
        await appendRoutingEvent({
          directory: dir,
          event: {
            type: "session-touch",
            accountName: "main",
            sessionID: "s1",
            at: 100,
          },
        })
      },
    })

    await rotate

    const state = await readRoutingState(dir)
    assert.equal(state.accounts.main.touchBuckets[0], 1)
  })
})

test("compaction does not double-apply a sealed segment already recorded in appliedSegments", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: {
          touchBuckets: {
            "0": 1,
          },
        },
      },
      appliedSegments: ["sealed-1.log"],
    }), "utf8")

    await writeFile(path.join(dir, "sealed-1.log"), `${JSON.stringify({
      type: "session-touch",
      accountName: "main",
      sessionID: "s2",
      at: 200,
    })}\n`, "utf8")

    const compacted = await compactRoutingState({ directory: dir, now: 1_000_000 })
    assert.deepEqual(compacted.accounts.main.touchBuckets, { "0": 1 })

    const reread = await readRoutingState(dir)
    assert.deepEqual(reread.accounts.main.touchBuckets, { "0": 1 })
  })
})

test("compactRoutingState does not rotate, fold, or delete decisions log", async () => {
  await withRoutingStateDir(async (dir) => {
    const baseline = {
      accounts: {
        main: {
          touchBuckets: {
            "0": 1,
          },
          lastRateLimitedAt: 50,
        },
      },
      appliedSegments: [],
    }
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify(baseline), "utf8")

    const decisionsFile = path.join(dir, "decisions.log")
    await writeFile(decisionsFile, `${JSON.stringify({
      type: "session-touch",
      accountName: "alt",
      sessionID: "from-decisions-compaction",
      at: 100,
    })}\n${JSON.stringify({
      type: "rate-limit-flagged",
      accountName: "alt",
      at: 101,
    })}\n`, "utf8")

    const compacted = await compactRoutingState({ directory: dir, now: 200_000 })

    assert.deepEqual(compacted.accounts.main?.touchBuckets, { "0": 1 })
    assert.equal(compacted.accounts.main?.lastRateLimitedAt, 50)
    assert.equal(compacted.accounts.alt, undefined)
    assert.deepEqual(compacted.appliedSegments, [])

    const reread = await readRoutingState(dir)
    assert.deepEqual(reread.accounts.main?.touchBuckets, { "0": 1 })
    assert.equal(reread.accounts.main?.lastRateLimitedAt, 50)
    assert.equal(reread.accounts.alt, undefined)
    assert.deepEqual(reread.appliedSegments, [])

    const decisions = await readFile(decisionsFile, "utf8")
    assert.match(decisions, /from-decisions-compaction/)

    const entries = await readdir(dir)
    const sealedSegments = entries.filter((name) => /^sealed-.*\.log$/.test(name))
    assert.deepEqual(sealedSegments, [])
  })
})

test("rotate gracefully retries or skips when rename fails on Windows-like handle contention", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "active.log"), "", "utf8")

    let renameCalls = 0
    const result = await rotateActiveLog({
      directory: dir,
      now: 2_000,
      pid: 42,
      io: {
        mkdir: async (...args) => import("node:fs/promises").then((m) => m.mkdir(...args)),
        appendFile: async (...args) => import("node:fs/promises").then((m) => m.appendFile(...args)),
        readFile: async (...args) => import("node:fs/promises").then((m) => m.readFile(...args)),
        readdir: async (...args) => import("node:fs/promises").then((m) => m.readdir(...args)),
        rename: async (from, to) => {
          renameCalls += 1
          if (renameCalls <= 2) {
            const error = new Error("busy")
            error.code = "EBUSY"
            throw error
          }
          const mod = await import("node:fs/promises")
          await mod.rename(from, to)
        },
        writeFile: async (...args) => import("node:fs/promises").then((m) => m.writeFile(...args)),
        unlink: async (...args) => import("node:fs/promises").then((m) => m.unlink(...args)),
        open: async (...args) => import("node:fs/promises").then((m) => m.open(...args)),
      },
      maxRetries: 3,
      retryDelayMs: 0,
    })

    assert.equal(result.rotated, true)
    assert.equal(result.skipped, false)
    assert.equal(renameCalls, 3)
  })
})

test("append retries by reopening active.log after transient write failure", async () => {
  await withRoutingStateDir(async (dir) => {
    let openCalls = 0
    const io = {
      mkdir: async (...args) => import("node:fs/promises").then((m) => m.mkdir(...args)),
      appendFile: async (...args) => import("node:fs/promises").then((m) => m.appendFile(...args)),
      readFile: async (...args) => import("node:fs/promises").then((m) => m.readFile(...args)),
      readdir: async (...args) => import("node:fs/promises").then((m) => m.readdir(...args)),
      rename: async (...args) => import("node:fs/promises").then((m) => m.rename(...args)),
      writeFile: async (...args) => import("node:fs/promises").then((m) => m.writeFile(...args)),
      unlink: async (...args) => import("node:fs/promises").then((m) => m.unlink(...args)),
      open: async (filePath, flags) => {
        openCalls += 1
        const fileModule = await import("node:fs/promises")
        const handle = await fileModule.open(filePath, flags)
        if (openCalls === 1) {
          return {
            appendFile: async () => {
              const error = new Error("transient")
              error.code = "EIO"
              throw error
            },
            close: async () => {
              await handle.close()
            },
          }
        }
        return handle
      },
    }

    await appendRoutingEvent({
      directory: dir,
      event: {
        type: "session-touch",
        accountName: "main",
        sessionID: "s1",
        at: 100,
      },
      io,
      maxRetries: 3,
      retryDelayMs: 0,
    })

    const state = await readRoutingState(dir)
    assert.equal(state.accounts.main.touchBuckets[0], 1)
    assert.equal(openCalls >= 2, true)
  })
})

test("compactRoutingSnapshot keeps the bucket overlapping the rolling cutoff", () => {
  const now = (30 * 60 * 1000) + 60_001
  const state = compactRoutingSnapshot({
    accounts: {
      main: {
        touchBuckets: {
          "0": 2,
          "60000": 3,
        },
      },
    },
    appliedSegments: [],
  }, now)

  assert.equal(state.accounts.main.touchBuckets[0], undefined)
  assert.equal(state.accounts.main.touchBuckets[60000], 3)
})

test("snapshot.tmp residue is ignored during reads and cleaned on next compaction", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {},
      appliedSegments: [],
    }), "utf8")

    await writeFile(path.join(dir, "snapshot.tmp"), JSON.stringify({
      accounts: {
        ghost: {
          sessions: {
            shouldNotRead: 999,
          },
        },
      },
    }), "utf8")

    await writeFile(path.join(dir, "active.log"), `${JSON.stringify({
      type: "rate-limit-flagged",
      accountName: "main",
      at: 200,
    })}\n`, "utf8")

    const before = await readRoutingState(dir)
    assert.equal(before.accounts.ghost, undefined)
    assert.equal(before.accounts.main.lastRateLimitedAt, 200)

    await compactRoutingState({ directory: dir, now: 2_000_000 })

    await assert.rejects(
      () => readFile(path.join(dir, "snapshot.tmp"), "utf8"),
      (error) => error?.code === "ENOENT",
    )

    const after = await readRoutingState(dir)
    assert.equal(after.accounts.main.lastRateLimitedAt, 200)
  })
})

test("rotate generates collision-resistant sealed segment names within same millisecond and pid", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "active.log"), "first\n", "utf8")
    const first = await rotateActiveLog({
      directory: dir,
      now: 3_000,
      pid: 99,
    })

    await writeFile(path.join(dir, "active.log"), "second\n", "utf8")
    const second = await rotateActiveLog({
      directory: dir,
      now: 3_000,
      pid: 99,
    })

    assert.equal(first.rotated, true)
    assert.equal(second.rotated, true)
    assert.notEqual(first.segmentName, second.segmentName)

    const files = await readdir(dir)
    assert.equal(files.includes(first.segmentName), true)
    assert.equal(files.includes(second.segmentName), true)
  })
})

test("rotate surfaces EACCES rename failures instead of silently skipping", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "active.log"), "", "utf8")

    await assert.rejects(
      () => rotateActiveLog({
        directory: dir,
        now: 4_000,
        pid: 7,
        maxRetries: 3,
        retryDelayMs: 0,
        io: {
          mkdir: async (...args) => import("node:fs/promises").then((m) => m.mkdir(...args)),
          appendFile: async (...args) => import("node:fs/promises").then((m) => m.appendFile(...args)),
          readFile: async (...args) => import("node:fs/promises").then((m) => m.readFile(...args)),
          readdir: async (...args) => import("node:fs/promises").then((m) => m.readdir(...args)),
          rename: async () => {
            const error = new Error("denied")
            error.code = "EACCES"
            throw error
          },
          writeFile: async (...args) => import("node:fs/promises").then((m) => m.writeFile(...args)),
          unlink: async (...args) => import("node:fs/promises").then((m) => m.unlink(...args)),
          open: async (...args) => import("node:fs/promises").then((m) => m.open(...args)),
        },
      }),
      (error) => error?.code === "EACCES",
    )
  })
})
