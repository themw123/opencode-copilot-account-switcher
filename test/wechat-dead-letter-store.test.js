import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-dead-letter-store-"))
const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = sandboxConfigHome

after(() => {
  if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
})

const statePaths = await import("../dist/wechat/state-paths.js")
const deadLetterStore = await import("../dist/wechat/dead-letter-store.js")

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("dead-letter store 可写入并列举记录", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-dead-1",
    requestID: "q-dead-1",
    handle: "qdead1",
    scopeKey: "instance-dead-a",
    finalStatus: "expired",
    reason: "instanceStale",
    createdAt: 1_700_100_000_000,
    finalizedAt: 1_700_100_001_000,
    wechatAccountId: "wx-dead",
    userId: "u-dead",
    instanceID: "instance-dead-a",
    sessionID: "session-dead-a",
  })

  const listed = await deadLetterStore.listDeadLetters("question")
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.routeKey, "question-dead-1")
  assert.equal(listed[0]?.reason, "instanceStale")

  const readBack = await deadLetterStore.readDeadLetter("question", "question-dead-1")
  assert.equal(readBack?.handle, "qdead1")
  assert.equal(readBack?.finalStatus, "expired")
})

test("purgeDeadLettersBefore() 返回被删除记录并保留窗口内记录", async () => {
  await deadLetterStore.writeDeadLetter({
    kind: "question",
    routeKey: "question-dead-old",
    requestID: "q-dead-old",
    handle: "qdeadold",
    finalStatus: "expired",
    reason: "startupCleanup",
    createdAt: 1_700_100_000_000,
    finalizedAt: 1_700_100_010_000,
  })
  await deadLetterStore.writeDeadLetter({
    kind: "permission",
    routeKey: "permission-dead-fresh",
    requestID: "p-dead-fresh",
    handle: "pdeadfresh",
    finalStatus: "cleaned",
    reason: "runtimeCleanup",
    createdAt: 1_700_100_000_000,
    finalizedAt: 1_700_200_000_000,
  })

  const purged = await deadLetterStore.purgeDeadLettersBefore(1_700_150_000_000)
  assert.equal(purged.length, 1)
  assert.equal(purged[0]?.routeKey, "question-dead-old")

  const remaining = await deadLetterStore.listDeadLetters()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.routeKey, "permission-dead-fresh")
})
