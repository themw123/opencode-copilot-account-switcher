import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-request-store-"))
const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = sandboxConfigHome

after(() => {
  if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
})

const handle = await import("../dist/wechat/handle.js")
const requestStore = await import("../dist/wechat/request-store.js")
const statePaths = await import("../dist/wechat/state-paths.js")

beforeEach(async () => {
  await rm(statePaths.wechatStateRoot(), { recursive: true, force: true })
})

test("routeKey 与 handle 生成稳定，handle 大小写不敏感", () => {
  const routeKeyA = handle.createRouteKey({ kind: "question", requestID: "REQ-001" })
  const routeKeyB = handle.createRouteKey({ kind: "question", requestID: "req-001" })

  assert.equal(routeKeyA, routeKeyB)

  const existing = new Set(["q1"])
  const next = handle.createHandle("question", existing)
  assert.equal(next, "q2")

  assert.equal(handle.normalizeHandle("Q2"), "q2")
  assert.equal(handle.normalizeHandle("q2"), "q2")
})

test("原始 requestID 不能直接被接受为 handle", () => {
  assert.throws(() => handle.assertValidHandleInput("req-raw-001"), /requestid|raw/i)
})

test("request 状态机支持 open -> answered|rejected|expired -> cleaned", async () => {
  const questionOpen = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-open-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-open-1" }),
    handle: "q1",
    wechatAccountId: "wx-1",
    userId: "u-1",
    createdAt: 1_700_001_000_000,
  })
  assert.equal(questionOpen.status, "open")

  const questionAnswered = await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: questionOpen.routeKey,
    answeredAt: 1_700_001_010_000,
  })
  assert.equal(questionAnswered.status, "answered")

  const questionCleaned = await requestStore.markCleaned({
    kind: "question",
    routeKey: questionOpen.routeKey,
    cleanedAt: 1_700_001_020_000,
  })
  assert.equal(questionCleaned.status, "cleaned")

  const permissionOpen = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-open-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-open-1" }),
    handle: "p1",
    wechatAccountId: "wx-1",
    userId: "u-1",
    createdAt: 1_700_001_100_000,
  })
  const permissionRejected = await requestStore.markRequestRejected({
    kind: "permission",
    routeKey: permissionOpen.routeKey,
    rejectedAt: 1_700_001_110_000,
  })
  assert.equal(permissionRejected.status, "rejected")

  const questionOpen2 = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-open-2",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-open-2" }),
    handle: "q3",
    wechatAccountId: "wx-1",
    userId: "u-1",
    createdAt: 1_700_001_200_000,
  })
  const questionExpired = await requestStore.markRequestExpired({
    kind: "question",
    routeKey: questionOpen2.routeKey,
    expiredAt: 1_700_001_210_000,
  })
  assert.equal(questionExpired.status, "expired")

  const questionExpiredCleaned = await requestStore.markCleaned({
    kind: "question",
    routeKey: questionOpen2.routeKey,
    cleanedAt: 1_700_001_220_000,
  })
  assert.equal(questionExpiredCleaned.status, "cleaned")
})

test("markCleaned() 进入保留态", async () => {
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-retain-1",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-retain-1" }),
    handle: "p9",
    wechatAccountId: "wx-retain",
    userId: "u-retain",
    createdAt: 1_700_002_000_000,
  })

  await requestStore.markRequestAnswered({
    kind: "permission",
    routeKey: created.routeKey,
    answeredAt: 1_700_002_001_000,
  })

  await requestStore.markCleaned({
    kind: "permission",
    routeKey: created.routeKey,
    cleanedAt: 1_700_002_002_000,
  })

  const all = await requestStore.listActiveRequests()
  assert.equal(all.some((item) => item.routeKey === created.routeKey), false)

  const files = await readdir(statePaths.requestKindDir("permission"))
  assert.equal(files.includes(`${created.routeKey}.json`), true)
})

test("purgeCleanedBefore() 会物理删除超过 7 天窗口的 cleaned 文件", async () => {
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const now = 1_700_010_000_000

  const oldOne = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-old-cleaned",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-old-cleaned" }),
    handle: "q8",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    createdAt: now - weekMs - 10_000,
  })
  await requestStore.markRequestRejected({
    kind: "question",
    routeKey: oldOne.routeKey,
    rejectedAt: now - weekMs - 9_000,
  })
  await requestStore.markCleaned({
    kind: "question",
    routeKey: oldOne.routeKey,
    cleanedAt: now - weekMs - 8_000,
  })

  const freshOne = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-fresh-cleaned",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-fresh-cleaned" }),
    handle: "q9",
    wechatAccountId: "wx-purge",
    userId: "u-purge",
    createdAt: now - 5_000,
  })
  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: freshOne.routeKey,
    answeredAt: now - 4_000,
  })
  await requestStore.markCleaned({
    kind: "question",
    routeKey: freshOne.routeKey,
    cleanedAt: now - 3_000,
  })

  const purged = await requestStore.purgeCleanedBefore({ cutoffAt: now - weekMs })
  assert.equal(purged, 1)

  const files = await readdir(statePaths.requestKindDir("question"))
  assert.equal(files.includes(`${oldOne.routeKey}.json`), false)
  assert.equal(files.includes(`${freshOne.routeKey}.json`), true)
})

test("活动索引忽略 cleaned 记录", async () => {
  const openReq = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-active-open",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-active-open" }),
    handle: "q11",
    wechatAccountId: "wx-active",
    userId: "u-active",
    createdAt: 1_700_020_000_000,
  })

  const doneReq = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-active-cleaned",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-active-cleaned" }),
    handle: "p11",
    wechatAccountId: "wx-active",
    userId: "u-active",
    createdAt: 1_700_020_100_000,
  })
  await requestStore.markRequestExpired({
    kind: "permission",
    routeKey: doneReq.routeKey,
    expiredAt: 1_700_020_101_000,
  })
  await requestStore.markCleaned({
    kind: "permission",
    routeKey: doneReq.routeKey,
    cleanedAt: 1_700_020_102_000,
  })

  const active = await requestStore.listActiveRequests()

  assert.equal(active.some((item) => item.routeKey === openReq.routeKey), true)
  assert.equal(active.some((item) => item.routeKey === doneReq.routeKey), false)
})

test("终态 request 不允许被 upsert 复活", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-terminal-1",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-terminal-1" }),
    handle: "q21",
    wechatAccountId: "wx-terminal",
    userId: "u-terminal",
    createdAt: 1_700_030_000_000,
  })

  await requestStore.markRequestAnswered({
    kind: "question",
    routeKey: created.routeKey,
    answeredAt: 1_700_030_001_000,
  })

  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-terminal-1",
        routeKey: created.routeKey,
        handle: "q21",
        wechatAccountId: "wx-terminal",
        userId: "u-terminal",
        createdAt: 1_700_030_002_000,
      }),
    /terminal|cannot upsert|not open/i,
  )
})

test("损坏或缺字段 request JSON 会抛明确格式错误", async () => {
  const brokenRouteKey = handle.createRouteKey({ kind: "question", requestID: "q-broken-json" })
  const brokenPath = statePaths.requestStatePath("question", brokenRouteKey)
  await mkdir(path.dirname(brokenPath), { recursive: true })
  await writeFile(brokenPath, "{not-json")

  await assert.rejects(
    () => requestStore.listActiveRequests(),
    /invalid request.*format/i,
  )

  const missingFieldRouteKey = handle.createRouteKey({ kind: "question", requestID: "q-missing-field" })
  const missingFieldPath = statePaths.requestStatePath("question", missingFieldRouteKey)
  await mkdir(path.dirname(missingFieldPath), { recursive: true })
  await writeFile(
    missingFieldPath,
    JSON.stringify({
      kind: "question",
      requestID: "q-missing-field",
      routeKey: missingFieldRouteKey,
      handle: "q22",
      wechatAccountId: "wx-1",
      userId: "u-1",
      status: "open",
    }),
  )

  await assert.rejects(
    () => requestStore.listActiveRequests(),
    /invalid request.*format/i,
  )
})

test("磁盘 request kind 非法值时读取与状态迁移抛格式错误", async () => {
  const badRouteKey = handle.createRouteKey({ kind: "question", requestID: "q-bad-kind" })
  const badPath = statePaths.requestStatePath("question", badRouteKey)
  await mkdir(path.dirname(badPath), { recursive: true })
  await writeFile(
    badPath,
    JSON.stringify({
      kind: "bad-kind",
      requestID: "q-bad-kind",
      routeKey: badRouteKey,
      handle: "q31",
      wechatAccountId: "wx-bad",
      userId: "u-bad",
      status: "open",
      createdAt: 1_700_040_000_000,
    }),
  )

  await assert.rejects(
    () => requestStore.listActiveRequests(),
    /invalid request.*format/i,
  )

  await assert.rejects(
    () =>
      requestStore.markRequestAnswered({
        kind: "question",
        routeKey: badRouteKey,
        answeredAt: 1_700_040_010_000,
      }),
    /invalid request.*format/i,
  )
})

test("upsertRequest() 拒绝非法 routeKey", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-invalid-route",
        routeKey: "../escape",
        handle: "q41",
        wechatAccountId: "wx-route",
        userId: "u-route",
        createdAt: 1_700_050_000_000,
      }),
    /invalid routekey/i,
  )

  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-invalid-route-2",
        routeKey: "question/evil",
        handle: "q42",
        wechatAccountId: "wx-route",
        userId: "u-route",
        createdAt: 1_700_050_100_000,
      }),
    /invalid routekey/i,
  )
})

test("upsertRequest() 拒绝非法 handle", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "permission",
        requestID: "p-invalid-handle",
        routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-invalid-handle" }),
        handle: "REQ-RAW-777",
        wechatAccountId: "wx-handle",
        userId: "u-handle",
        createdAt: 1_700_060_000_000,
      }),
    /handle|requestid|raw/i,
  )
})

test("upsertRequest() 拒绝非法 kind，且不会写出非法 kind 目录", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "evil",
        requestID: "q-invalid-kind",
        routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-kind" }),
        handle: "q51",
        wechatAccountId: "wx-kind",
        userId: "u-kind",
        createdAt: 1_700_070_000_000,
      }),
    /invalid request record format/i,
  )

  await assert.rejects(
    () => readdir(path.join(statePaths.wechatStateRoot(), "requests", "evil")),
    (error) => error?.code === "ENOENT",
  )
})

test("upsertRequest() 拒绝非法 createdAt", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "q-invalid-created-at",
        routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-created-at" }),
        handle: "q52",
        wechatAccountId: "wx-created-at",
        userId: "u-created-at",
        createdAt: Number.NaN,
      }),
    /invalid request record format/i,
  )
})

test("upsertRequest() 拒绝空 requestID 或空 userId", async () => {
  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "question",
        requestID: "",
        routeKey: handle.createRouteKey({ kind: "question", requestID: "q-empty-requestid" }),
        handle: "q53",
        wechatAccountId: "wx-empty",
        userId: "u-empty",
        createdAt: 1_700_070_100_000,
      }),
    /invalid request record format/i,
  )

  await assert.rejects(
    () =>
      requestStore.upsertRequest({
        kind: "permission",
        requestID: "p-empty-user",
        routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-empty-user" }),
        handle: "p53",
        wechatAccountId: "wx-empty",
        userId: "",
        createdAt: 1_700_070_200_000,
      }),
    /invalid request record format/i,
  )
})

test("磁盘文件 kind 与目录不一致时，状态迁移被拒绝", async () => {
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-kind-drift" })
  const filePath = statePaths.requestStatePath("question", routeKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify({
      kind: "permission",
      requestID: "q-kind-drift",
      routeKey,
      handle: "q61",
      wechatAccountId: "wx-kind-drift",
      userId: "u-kind-drift",
      status: "open",
      createdAt: 1_700_090_000_000,
    }),
  )

  await assert.rejects(
    () =>
      requestStore.markRequestAnswered({
        kind: "question",
        routeKey,
        answeredAt: 1_700_090_010_000,
      }),
    /invalid request record format/i,
  )
})

test("markRequestAnswered() 拒绝 NaN 时间戳且不改写文件", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-invalid-answered-at",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-answered-at" }),
    handle: "q71",
    wechatAccountId: "wx-answer",
    userId: "u-answer",
    createdAt: 1_700_100_000_000,
  })

  const filePath = statePaths.requestStatePath("question", created.routeKey)
  const before = await readFile(filePath, "utf8")

  await assert.rejects(
    () =>
      requestStore.markRequestAnswered({
        kind: "question",
        routeKey: created.routeKey,
        answeredAt: Number.NaN,
      }),
    /invalid request record format/i,
  )

  const after = await readFile(filePath, "utf8")
  assert.equal(after, before)
})

test("markRequestRejected() 拒绝 Infinity 时间戳且不改写文件", async () => {
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-invalid-rejected-at",
    routeKey: handle.createRouteKey({ kind: "permission", requestID: "p-invalid-rejected-at" }),
    handle: "p71",
    wechatAccountId: "wx-reject",
    userId: "u-reject",
    createdAt: 1_700_100_100_000,
  })

  const filePath = statePaths.requestStatePath("permission", created.routeKey)
  const before = await readFile(filePath, "utf8")

  await assert.rejects(
    () =>
      requestStore.markRequestRejected({
        kind: "permission",
        routeKey: created.routeKey,
        rejectedAt: Number.POSITIVE_INFINITY,
      }),
    /invalid request record format/i,
  )

  const after = await readFile(filePath, "utf8")
  assert.equal(after, before)
})

test("markRequestExpired() 拒绝非法时间戳且不改写文件", async () => {
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-invalid-expired-at",
    routeKey: handle.createRouteKey({ kind: "question", requestID: "q-invalid-expired-at" }),
    handle: "q72",
    wechatAccountId: "wx-expire",
    userId: "u-expire",
    createdAt: 1_700_100_200_000,
  })

  const filePath = statePaths.requestStatePath("question", created.routeKey)
  const before = await readFile(filePath, "utf8")

  await assert.rejects(
    () =>
      requestStore.markRequestExpired({
        kind: "question",
        routeKey: created.routeKey,
        expiredAt: Number.NEGATIVE_INFINITY,
      }),
    /invalid request record format/i,
  )

  const after = await readFile(filePath, "utf8")
  assert.equal(after, before)
})
