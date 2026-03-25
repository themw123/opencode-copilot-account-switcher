import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { mkdtemp } from "node:fs/promises"

const DIST_BROKER_SERVER_MODULE = "../dist/wechat/broker-server.js"
const DIST_BROKER_CLIENT_MODULE = "../dist/wechat/broker-client.js"
const DIST_BRIDGE_MODULE = "../dist/wechat/bridge.js"

function createBrokerEndpoint(tempDir) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\wechat-broker-status-${process.pid}-${suffix}`
  }
  return path.join(tempDir, `wechat-broker-status-${suffix}.sock`)
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error("waitFor timeout")
}

test("collectStatus/statusSnapshot 往返：broker 广播，bridge 回包，broker 仅聚合 snapshot", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-roundtrip-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const snapshots = []
  const receivedRequestIds = []
  const server = await brokerServer.startBrokerServer(endpoint)
  let bridge = null

  try {
    bridge = await brokerClient.connect(endpoint, {
      onCollectStatus: async ({ requestId }) => {
        receivedRequestIds.push(requestId)
        return {
          instanceID: "status-instance-a",
          digest: {
            source: "bridge",
            value: "digest-from-bridge",
          },
        }
      },
    })

    await bridge.registerInstance({
      instanceID: "status-instance-a",
      pid: process.pid,
    })

    const result = await server.collectStatus()
    snapshots.push(...result.instances)

    assert.equal(receivedRequestIds.length, 1)
    assert.equal(typeof receivedRequestIds[0], "string")
    assert.equal(receivedRequestIds[0].length > 0, true)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].instanceID, "status-instance-a")
    assert.equal(snapshots[0].status, "ok")
    assert.deepEqual(snapshots[0].snapshot, {
      instanceID: "status-instance-a",
      digest: {
        source: "bridge",
        value: "digest-from-bridge",
      },
    })

  } finally {
    if (bridge) {
      await bridge.close().catch(() => {})
    }
    await server.close()
  }
})

test("collectStatus 聚合窗口固定 1.5s，未回包实例标记 timeout/unreachable", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-timeout-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let responsive = null
  let unresponsive = null

  try {
    responsive = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => ({ healthy: true }),
    })
    await responsive.registerInstance({ instanceID: "status-responsive", pid: process.pid })

    unresponsive = await brokerClient.connect(endpoint)
    await unresponsive.registerInstance({ instanceID: "status-unresponsive", pid: process.pid })

    const startedAt = Date.now()
    const result = await server.collectStatus()
    const elapsedMs = Date.now() - startedAt

    assert.equal(brokerServer.DEFAULT_STATUS_COLLECT_WINDOW_MS, 1500)
    assert.equal(elapsedMs >= 1400, true)

    const responsiveItem = result.instances.find((item) => item.instanceID === "status-responsive")
    const unresponsiveItem = result.instances.find((item) => item.instanceID === "status-unresponsive")

    assert.equal(responsiveItem.status, "ok")
    assert.deepEqual(responsiveItem.snapshot, { healthy: true })
    assert.equal(unresponsiveItem.status, "timeout/unreachable")
    assert.equal("snapshot" in unresponsiveItem, false)

  } finally {
    if (responsive) {
      await responsive.close().catch(() => {})
    }
    if (unresponsive) {
      await unresponsive.close().catch(() => {})
    }
    await server.close()
  }
})

test("broker-client.send 仅消费匹配 requestId 的响应，忽略串包帧", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-mismatch-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = net.createServer((socket) => {
    let buffer = ""
    const onData = (chunk) => {
      buffer += chunk.toString("utf8")
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      socket.off("data", onData)
      const line = buffer.slice(0, newlineIndex)
      const request = JSON.parse(line)
      const expectedResponseId = `pong-${request.id}`
      socket.write('{"id":"pong-not-the-request","type":"pong","payload":{"message":"wrong"}}\n')
      socket.write(
        `${JSON.stringify({ id: expectedResponseId, type: "pong", payload: { message: "pong" } })}\n`,
      )
    }

    socket.on("data", onData)
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => resolve())
  })

  let client = null
  try {
    client = await brokerClient.connect(endpoint)
    const pong = await client.ping()
    assert.equal(pong.id.startsWith("pong-ping-"), true)
    assert.equal(pong.payload.message, "pong")
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
    await new Promise((resolve) => server.close(() => resolve()))
  }
})

test("broker-server.close 会主动断开客户端连接，避免 close 卡住", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-close-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let client = null
  try {
    client = await brokerClient.connect(endpoint)
    await client.registerInstance({ instanceID: "status-close-a", pid: process.pid })

    const closePromise = server.close()
    await assert.doesNotReject(() =>
      Promise.race([
        closePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("broker close timeout")), 3000)),
      ]),
    )
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
  }
})

test("bridge live snapshot: 读取 session/status/question/permission/todo/messages 并只保留最近 3 个 session", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const calls = []

  const sessions = [
    { id: "s-older", title: "older", directory: "/repo", time: { updated: 10 } },
    { id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } },
    { id: "s-2", title: "s2", directory: "/repo", time: { updated: 300 } },
    { id: "s-3", title: "s3", directory: "/repo", time: { updated: 200 } },
  ]

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-a",
    instanceName: "Bridge A",
    projectName: "project-a",
    directory: "/repo",
    pid: 12345,
    client: {
      session: {
        list: async () => {
          calls.push("session.list")
          return sessions
        },
        status: async () => {
          calls.push("session.status")
          return {
            "s-1": { type: "busy" },
            "s-2": { type: "idle" },
            "s-3": { type: "retry" },
            "s-older": { type: "busy" },
          }
        },
        todo: async (sessionID) => {
          calls.push(`session.todo:${sessionID}`)
          return [{ id: `${sessionID}-todo-1`, status: "in_progress" }]
        },
        messages: async (sessionID) => {
          calls.push(`session.messages:${sessionID}`)
          return [{ info: { id: `${sessionID}-m1` }, parts: [] }]
        },
      },
      question: {
        list: async () => {
          calls.push("question.list")
          return [
            { id: "q-1", sessionID: "s-2", text: "Q1" },
            { id: "q-2", sessionID: "s-older", text: "Q-older" },
          ]
        },
      },
      permission: {
        list: async () => {
          calls.push("permission.list")
          return [
            { id: "p-1", sessionID: "s-1", tool: "bash", command: "ls" },
            { id: "p-2", sessionID: "s-3", tool: "edit", command: "write" },
          ]
        },
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const sessionIDs = snapshot.sessions.map((item) => item.sessionID)

  assert.deepEqual(sessionIDs, ["s-2", "s-3", "s-1"])
  assert.equal(calls.includes("session.list"), true)
  assert.equal(calls.includes("session.status"), true)
  assert.equal(calls.includes("question.list"), true)
  assert.equal(calls.includes("permission.list"), true)
  assert.equal(calls.includes("session.todo:s-2"), true)
  assert.equal(calls.includes("session.todo:s-3"), true)
  assert.equal(calls.includes("session.todo:s-1"), true)
  assert.equal(calls.includes("session.todo:s-older"), false)
  assert.equal(calls.includes("session.messages:s-2"), true)
  assert.equal(calls.includes("session.messages:s-3"), true)
  assert.equal(calls.includes("session.messages:s-1"), true)
  assert.equal(calls.includes("session.messages:s-older"), false)
  assert.equal(snapshot.sessions.find((item) => item.sessionID === "s-2")?.status, "idle")
  assert.equal(snapshot.sessions.find((item) => item.sessionID === "s-1")?.pendingPermissionCount, 1)
  assert.equal(snapshot.sessions.find((item) => item.sessionID === "s-2")?.pendingQuestionCount, 1)
})

test("bridge live snapshot: messages() 失败仅 session 级降级，permission.list() 失败仅实例级 unavailable", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-b",
    instanceName: "Bridge B",
    projectName: "project-b",
    directory: "/repo",
    pid: 12346,
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => {
          throw new Error("messages unavailable")
        },
      },
      question: {
        list: async () => [{ id: "q-1", sessionID: "s-1", text: "Q1" }],
      },
      permission: {
        list: async () => {
          throw new Error("permission unavailable")
        },
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const digest = snapshot.sessions[0]

  assert.equal(Array.isArray(snapshot.unavailable), true)
  assert.equal(snapshot.unavailable.includes("permissionList"), true)
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(digest.sessionID, "s-1")
  assert.equal(digest.status, "busy")
  assert.equal(digest.pendingQuestionCount, 1)
  assert.equal(digest.pendingPermissionCount, 0)
  assert.equal(Array.isArray(digest.unavailable), true)
  assert.equal(digest.unavailable.includes("messages"), true)
})

test("bridge live snapshot: permission.list() hang 触发实例级 timeout unavailable，不阻塞整体返回", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-timeout-instance",
    instanceName: "Bridge Timeout Instance",
    projectName: "project-timeout-instance",
    directory: "/repo",
    pid: 22346,
    liveReadTimeoutMs: 20,
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => [{ info: { id: "m-1" }, parts: [] }],
      },
      question: {
        list: async () => [{ id: "q-1", sessionID: "s-1", text: "Q1" }],
      },
      permission: {
        list: async () => new Promise(() => {}),
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()

  assert.equal(Array.isArray(snapshot.unavailable), true)
  assert.equal(snapshot.unavailable.includes("permissionList"), true)
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.sessions[0].status, "busy")
  assert.equal(snapshot.sessions[0].pendingQuestionCount, 1)
})

test("bridge live snapshot: session.messages() hang 触发 session 级 timeout unavailable，不阻塞实例返回", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-timeout-session",
    instanceName: "Bridge Timeout Session",
    projectName: "project-timeout-session",
    directory: "/repo",
    pid: 32346,
    liveReadTimeoutMs: 20,
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => new Promise(() => {}),
      },
      question: {
        list: async () => [{ id: "q-1", sessionID: "s-1", text: "Q1" }],
      },
      permission: {
        list: async () => [{ id: "p-1", sessionID: "s-1", tool: "bash", command: "ls" }],
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const digest = snapshot.sessions[0]

  assert.equal(snapshot.sessions.length, 1)
  assert.equal(Array.isArray(snapshot.unavailable), false)
  assert.equal(digest.status, "busy")
  assert.equal(digest.pendingQuestionCount, 1)
  assert.equal(digest.pendingPermissionCount, 1)
  assert.equal(Array.isArray(digest.unavailable), true)
  assert.equal(digest.unavailable.includes("messages"), true)
})

test("broker-client collectStatus handler: 仅在请求时触发 bridge live 读取，且同一 bridge 可重复响应", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-bridge-handler-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let bridgeClient = null
  let collectCalls = 0

  try {
    const bridge = {
      collectStatusSnapshot: async () => {
        collectCalls += 1
        return { instanceID: "status-bridge-handler", call: collectCalls }
      },
    }

    bridgeClient = await brokerClient.connect(endpoint, { bridge })
    await bridgeClient.registerInstance({ instanceID: "status-bridge-handler", pid: process.pid })

    assert.equal(collectCalls, 0)

    const first = await server.collectStatus()
    const second = await server.collectStatus()

    assert.equal(collectCalls, 2)
    const firstItem = first.instances.find((item) => item.instanceID === "status-bridge-handler")
    const secondItem = second.instances.find((item) => item.instanceID === "status-bridge-handler")
    assert.equal(firstItem.status, "ok")
    assert.equal(secondItem.status, "ok")
    assert.deepEqual(firstItem.snapshot, { instanceID: "status-bridge-handler", call: 1 })
    assert.deepEqual(secondItem.snapshot, { instanceID: "status-bridge-handler", call: 2 })

  } finally {
    if (bridgeClient) {
      await bridgeClient.close().catch(() => {})
    }
    await server.close()
  }
})

test("broker-client connect: 同时传入 bridge 和 onCollectStatus 会显式报错", async () => {
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-ambiguous-options-"))
  const endpoint = createBrokerEndpoint(tempDir)

  await assert.rejects(
    () =>
      brokerClient.connect(endpoint, {
        bridge: {
          collectStatusSnapshot: async () => ({ ok: true }),
        },
        onCollectStatus: async () => ({ ok: true }),
      }),
    /ambiguous/i,
  )
})

test("/status 文案边界：最多 3 个 session、并行 highlights、局部降级与 timeout 固定文案", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)

  const reply = statusFormat.formatAggregatedStatusReply({
    requestId: "req-format-1",
    instances: [
      {
        instanceID: "instance-rich",
        status: "ok",
        snapshot: {
          instanceID: "instance-rich",
          instanceName: "Rich",
          pid: 101,
          directory: "/repo",
          collectedAt: 123,
          unavailable: ["permissionList"],
          sessions: [
            {
              sessionID: "s-new-1",
              title: "new-1",
              directory: "/repo",
              updatedAt: 400,
              status: "busy",
              pendingQuestionCount: 1,
              pendingPermissionCount: 1,
              todoSummary: { total: 2, inProgress: 1, completed: 1 },
              highlights: [
                { kind: "permission", text: "pending permission: 1" },
                { kind: "question", text: "pending question: 1" },
                { kind: "running-tool", text: "running tool: bash" },
                { kind: "completed-tool", text: "completed tool: edit" },
                { kind: "todo", text: "todo: 1 in progress, 1 completed, 2 total" },
                { kind: "status", text: "status: busy" },
              ],
            },
            {
              sessionID: "s-new-2",
              title: "new-2",
              directory: "/repo",
              updatedAt: 300,
              status: "idle",
              pendingQuestionCount: 0,
              pendingPermissionCount: 0,
              todoSummary: { total: 0, inProgress: 0, completed: 0 },
              unavailable: ["messages"],
              highlights: [
                { kind: "question", text: "pending question: 0" },
                { kind: "status", text: "status: idle" },
              ],
            },
            {
              sessionID: "s-new-3",
              title: "new-3",
              directory: "/repo",
              updatedAt: 200,
              status: "retry",
              pendingQuestionCount: 0,
              pendingPermissionCount: 0,
              todoSummary: { total: 0, inProgress: 0, completed: 0 },
              highlights: [{ kind: "status", text: "status: retry" }],
            },
            {
              sessionID: "s-old-should-hide",
              title: "old-hide",
              directory: "/repo",
              updatedAt: 100,
              status: "idle",
              pendingQuestionCount: 0,
              pendingPermissionCount: 0,
              todoSummary: { total: 0, inProgress: 0, completed: 0 },
              highlights: [{ kind: "status", text: "status: idle" }],
            },
          ],
        },
      },
      {
        instanceID: "instance-timeout",
        status: "timeout/unreachable",
      },
    ],
  })

  assert.match(reply, /instance-rich/i)
  assert.match(reply, /pending permission: 1/i)
  assert.match(reply, /pending question: 1/i)
  assert.match(reply, /running tool: bash/i)
  assert.match(reply, /completed tool: edit/i)
  assert.match(reply, /todo: 1 in progress, 1 completed, 2 total/i)
  assert.match(reply, /status: busy/i)
  assert.match(reply, /session unavailable: messages/i)
  assert.match(reply, /instance unavailable: permissionList/i)
  assert.match(reply, /timeout\/unreachable/i)

  assert.match(reply, /s-new-1/)
  assert.match(reply, /s-new-2/)
  assert.match(reply, /s-new-3/)
  assert.doesNotMatch(reply, /s-old-should-hide/)
  assert.doesNotMatch(reply, /\/status|slash command|recent command/i)

  const permissionIndex = reply.indexOf("pending permission: 1")
  const questionIndex = reply.indexOf("pending question: 1")
  const runningIndex = reply.indexOf("running tool: bash")
  const completedIndex = reply.indexOf("completed tool: edit")
  const todoIndex = reply.indexOf("todo: 1 in progress, 1 completed, 2 total")
  const statusIndex = reply.indexOf("status: busy")
  assert.equal(permissionIndex >= 0, true)
  assert.equal(questionIndex > permissionIndex, true)
  assert.equal(runningIndex > questionIndex, true)
  assert.equal(completedIndex > runningIndex, true)
  assert.equal(todoIndex > completedIndex, true)
  assert.equal(statusIndex > todoIndex, true)
})

test("command parser: 仅识别 /status", async () => {
  const parser = await import(`../dist/wechat/command-parser.js?reload=${Date.now()}`)

  assert.deepEqual(parser.parseWechatSlashCommand("/status"), { type: "status" })
  assert.deepEqual(parser.parseWechatSlashCommand("/reply hi"), { type: "unimplemented", command: "reply" })
  assert.deepEqual(parser.parseWechatSlashCommand("/allow once"), { type: "unimplemented", command: "allow" })
  assert.equal(parser.parseWechatSlashCommand("status"), null)
})

test("broker slash handler: /status 走 collectStatus formatter，其它 slash 返回未实现", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-slash-handler-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let responsive = null
  let unresponsive = null

  try {
    responsive = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => ({
        instanceID: "slash-instance-ok",
        instanceName: "Slash OK",
        pid: 111,
        directory: "/repo",
        collectedAt: Date.now(),
        sessions: [
          {
            sessionID: "slash-s-1",
            title: "slash-s-1",
            directory: "/repo",
            updatedAt: 100,
            status: "busy",
            pendingQuestionCount: 1,
            pendingPermissionCount: 0,
            todoSummary: { total: 0, inProgress: 0, completed: 0 },
            highlights: [
              { kind: "question", text: "pending question: 1" },
              { kind: "status", text: "status: busy" },
            ],
          },
        ],
      }),
    })
    await responsive.registerInstance({ instanceID: "slash-instance-ok", pid: process.pid })

    unresponsive = await brokerClient.connect(endpoint)
    await unresponsive.registerInstance({ instanceID: "slash-instance-timeout", pid: process.pid })

    const statusReply = await server.handleWechatSlashCommand({ type: "status" })
    assert.match(statusReply, /slash-instance-ok/i)
    assert.match(statusReply, /pending question: 1/i)
    assert.match(statusReply, /timeout\/unreachable/i)

    assert.equal(
      await server.handleWechatSlashCommand({ type: "unimplemented", command: "reply" }),
      "命令暂未实现：/reply",
    )
    assert.equal(
      await server.handleWechatSlashCommand({ type: "unimplemented", command: "allow" }),
      "命令暂未实现：/allow",
    )
  } finally {
    if (responsive) {
      await responsive.close().catch(() => {})
    }
    if (unresponsive) {
      await unresponsive.close().catch(() => {})
    }
    await server.close()
  }
})

test("broker 聚合输出：collectStatus 返回格式化 /status reply", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-reply-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let responsive = null
  let unresponsive = null

  try {
    responsive = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => ({
        instanceID: "reply-instance-ok",
        instanceName: "Reply OK",
        pid: 111,
        directory: "/repo",
        collectedAt: Date.now(),
        sessions: [
          {
            sessionID: "reply-s-1",
            title: "reply-s-1",
            directory: "/repo",
            updatedAt: 100,
            status: "busy",
            pendingQuestionCount: 1,
            pendingPermissionCount: 0,
            todoSummary: { total: 0, inProgress: 0, completed: 0 },
            highlights: [
              { kind: "question", text: "pending question: 1" },
              { kind: "status", text: "status: busy" },
            ],
          },
        ],
      }),
    })
    await responsive.registerInstance({ instanceID: "reply-instance-ok", pid: process.pid })

    unresponsive = await brokerClient.connect(endpoint)
    await unresponsive.registerInstance({ instanceID: "reply-instance-timeout", pid: process.pid })

    const result = await server.collectStatus()

    assert.equal(typeof result.reply, "string")
    assert.match(result.reply, /reply-instance-ok/i)
    assert.match(result.reply, /pending question: 1/i)
    assert.match(result.reply, /timeout\/unreachable/i)
    assert.doesNotMatch(result.reply, /\/status|slash command|recent command/i)
  } finally {
    if (responsive) {
      await responsive.close().catch(() => {})
    }
    if (unresponsive) {
      await unresponsive.close().catch(() => {})
    }
    await server.close()
  }
})

test("status formatter: 过滤畸形 snapshot，避免输出 undefined 文案", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)

  const reply = statusFormat.formatAggregatedStatusReply({
    requestId: "req-malformed-1",
    instances: [
      {
        instanceID: "malformed-instance",
        status: "ok",
        snapshot: {
          instanceID: "malformed-instance",
          instanceName: "Malformed",
          sessions: [
            null,
            undefined,
            {},
            {
              sessionID: "ok-session",
              title: "ok",
              updatedAt: 1,
              unavailable: ["messages", "messages", "todo"],
              highlights: [
                { kind: "status", text: "status: idle" },
                { kind: "status" },
                { kind: "unknown-kind", text: "bad" },
                { kind: "question", text: "pending question: 1" },
              ],
            },
          ],
        },
      },
    ],
  })

  assert.match(reply, /ok-session/)
  assert.match(reply, /pending question: 1/)
  assert.match(reply, /status: idle/)
  assert.doesNotMatch(reply, /undefined|null/) 
})

test("status formatter: 同分 session 与 unavailable 列表输出稳定（排序+去重）", async () => {
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)

  const reply = statusFormat.formatAggregatedStatusReply({
    requestId: "req-stable-1",
    instances: [
      {
        instanceID: "stable-instance",
        status: "ok",
        snapshot: {
          instanceID: "stable-instance",
          instanceName: "Stable",
          unavailable: ["questionList", "permissionList", "questionList"],
          sessions: [
            {
              sessionID: "s-b",
              title: "b",
              updatedAt: 100,
              unavailable: ["todo", "messages", "todo"],
              highlights: [{ kind: "status", text: "status: idle" }],
            },
            {
              sessionID: "s-a",
              title: "a",
              updatedAt: 100,
              highlights: [{ kind: "status", text: "status: busy" }],
            },
          ],
        },
      },
    ],
  })

  assert.match(reply, /instance unavailable: permissionList, questionList/)
  assert.match(reply, /session unavailable: messages, todo/)

  const saIndex = reply.indexOf("- session s-a")
  const sbIndex = reply.indexOf("- session s-b")
  assert.equal(saIndex >= 0, true)
  assert.equal(sbIndex > saIndex, true)
})

test("wechat status runtime: 收到响应即推进 get_updates_buf，失败重试不回滚，slash 与非 slash 分别回复", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const getUpdatesCalls = []
  const sendCalls = []
  const slashCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    longPollTimeoutMs: 1234,
    loadPublicHelpers: async () => ({
      entry: {
        packageJsonPath: "/tmp/pkg.json",
        packageRoot: "/tmp",
        extensions: ["./index.js"],
        entryRelativePath: "./index.js",
        entryAbsolutePath: "/tmp/index.js",
      },
      pluginId: "test-plugin",
      qrGateway: {
        loginWithQrStart: () => ({}),
        loginWithQrWait: () => ({}),
      },
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-from-state",
      },
      getUpdates: async (input) => {
        pollCount += 1
        getUpdatesCalls.push(input)
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-after-poll-1",
            msgs: [
              {
                from_user_id: "user-slash",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: " /status " } }],
              },
              {
                from_user_id: "user-text",
                context_token: "ctx-2",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          }
        }
        if (pollCount === 2) {
          throw new Error("temporary getUpdates error")
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          get_updates_buf: "buf-after-poll-3",
          msgs: [],
        }
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
    }),
    onSlashCommand: async ({ command, text }) => {
      slashCalls.push({ command, text })
      return "status reply text"
    },
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 2 && getUpdatesCalls.length >= 3)
  } finally {
    await runtime.close()
  }

  assert.equal(getUpdatesCalls[0].get_updates_buf, "buf-from-state")
  assert.equal(getUpdatesCalls[0].timeoutMs, 1234)
  assert.equal(getUpdatesCalls[2].get_updates_buf, "buf-after-poll-1")

  assert.equal(slashCalls.length, 1)
  assert.deepEqual(slashCalls[0].command, { type: "status" })
  assert.equal(slashCalls[0].text.trim(), "/status")

  assert.equal(sendCalls.length, 2)
  assert.equal(sendCalls[0].to, "user-slash")
  assert.equal(sendCalls[0].text, "status reply text")
  assert.equal(sendCalls[0].opts.contextToken, "ctx-1")
  assert.equal(sendCalls[1].to, "user-text")
  assert.equal(sendCalls[1].text, runtimeModule.DEFAULT_NON_SLASH_REPLY_TEXT)
  assert.equal(sendCalls[1].opts.contextToken, "ctx-2")
})

test("wechat status runtime: get_updates_buf 推进后会持久化回写，重启可从最新 buf 继续", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const persistedBufWrites = []
  const getUpdatesCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-persist",
        token: "token-persist",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-initial",
      },
      getUpdates: async (input) => {
        pollCount += 1
        getUpdatesCalls.push(input)
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-new-1",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
      persistGetUpdatesBuf: async ({ accountId, getUpdatesBuf }) => {
        persistedBufWrites.push({ accountId, getUpdatesBuf })
      },
    }),
  })

  await runtime.start()
  try {
    await waitFor(() => getUpdatesCalls.length >= 2 && persistedBufWrites.length >= 1)
  } finally {
    await runtime.close()
  }

  assert.equal(getUpdatesCalls[0].get_updates_buf, "buf-initial")
  assert.equal(getUpdatesCalls[1].get_updates_buf, "buf-new-1")
  assert.deepEqual(persistedBufWrites, [{ accountId: "acc-persist", getUpdatesBuf: "buf-new-1" }])
})

test("wechat status runtime: get_updates_buf 回写失败仅记录错误，不拖死后续轮询", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const runtimeErrors = []
  const persistedBufWrites = []
  const getUpdatesCalls = []
  const sendCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    onRuntimeError: (error) => {
      runtimeErrors.push(error)
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-persist-error",
        token: "token-persist-error",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-initial",
      },
      getUpdates: async (input) => {
        pollCount += 1
        getUpdatesCalls.push(input)
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-new-1",
            msgs: [
              {
                from_user_id: "user-a",
                context_token: "ctx-a",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          }
        }
        if (pollCount === 2) {
          return {
            get_updates_buf: "buf-new-2",
            msgs: [],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
      persistGetUpdatesBuf: async ({ accountId, getUpdatesBuf }) => {
        persistedBufWrites.push({ accountId, getUpdatesBuf })
        if (getUpdatesBuf === "buf-new-1") {
          throw new Error("persist failed once")
        }
      },
    }),
  })

  await runtime.start()
  try {
    await waitFor(() => getUpdatesCalls.length >= 3 && sendCalls.length >= 1 && runtimeErrors.length >= 1)
  } finally {
    await runtime.close()
  }

  assert.equal(getUpdatesCalls[0].get_updates_buf, "buf-initial")
  assert.equal(getUpdatesCalls[1].get_updates_buf, "buf-new-1")
  assert.equal(getUpdatesCalls[2].get_updates_buf, "buf-new-2")
  assert.equal(sendCalls[0].text, runtimeModule.DEFAULT_NON_SLASH_REPLY_TEXT)
  assert.equal(runtimeErrors.length >= 1, true)
  assert.match(String(runtimeErrors[0]), /persist failed once/i)
  assert.deepEqual(persistedBufWrites, [
    { accountId: "acc-persist-error", getUpdatesBuf: "buf-new-1" },
    { accountId: "acc-persist-error", getUpdatesBuf: "buf-new-2" },
  ])
})

test("wechat status runtime: /status 走 slash handler，非 slash 不触发 collectStatus，/reply /allow 返回未实现", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const sendCalls = []
  const slashCalls = []
  let statusCollectCalls = 0
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-from-state",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-after-poll-1",
            msgs: [
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
              {
                from_user_id: "user-reply",
                context_token: "ctx-reply",
                item_list: [{ type: 1, text_item: { text: "/reply hi" } }],
              },
              {
                from_user_id: "user-allow",
                context_token: "ctx-allow",
                item_list: [{ type: 1, text_item: { text: "/allow once" } }],
              },
              {
                from_user_id: "user-text",
                context_token: "ctx-text",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
    }),
    onSlashCommand: async ({ command }) => {
      slashCalls.push(command)
      if (command.type === "status") {
        statusCollectCalls += 1
        return "formatted status reply from collectStatus"
      }
      return `命令暂未实现：/${command.command}`
    },
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 4)
  } finally {
    await runtime.close()
  }

  assert.equal(statusCollectCalls, 1)
  assert.deepEqual(slashCalls, [
    { type: "status" },
    { type: "unimplemented", command: "reply" },
    { type: "unimplemented", command: "allow" },
  ])
  assert.equal(sendCalls[0].text, "formatted status reply from collectStatus")
  assert.equal(sendCalls[1].text, "命令暂未实现：/reply")
  assert.equal(sendCalls[2].text, "命令暂未实现：/allow")
  assert.equal(sendCalls[3].text, runtimeModule.DEFAULT_NON_SLASH_REPLY_TEXT)
})

test("wechat status runtime: slash handler 抛错时返回稳定错误提示，不透出内部堆栈", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const sendCalls = []
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-after-poll-1",
            msgs: [
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async (input) => {
        sendCalls.push(input)
        return { messageId: `m-${sendCalls.length}` }
      },
    }),
    onSlashCommand: async () => {
      throw new Error("collectStatus internal stack: foo")
    },
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 1)
  } finally {
    await runtime.close()
  }

  assert.equal(sendCalls[0].text, runtimeModule.DEFAULT_SLASH_HANDLER_ERROR_REPLY_TEXT)
  assert.doesNotMatch(sendCalls[0].text, /collectStatus|stack|foo/i)
})

test("wechat status runtime: close 可中断进行中的 getUpdates 长轮询", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  let getUpdatesStarted = false
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 60_000,
    loadPublicHelpers: async () => ({
      entry: {
        packageJsonPath: "/tmp/pkg.json",
        packageRoot: "/tmp",
        extensions: ["./index.js"],
        entryRelativePath: "./index.js",
        entryAbsolutePath: "/tmp/index.js",
      },
      pluginId: "test-plugin",
      qrGateway: {
        loginWithQrStart: () => ({}),
        loginWithQrWait: () => ({}),
      },
      latestAccountState: {
        accountId: "acc-1",
        token: "token-1",
        baseUrl: "https://wx.example.com",
      },
      getUpdates: async () => {
        getUpdatesStarted = true
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => ({ messageId: "m-1" }),
    }),
  })

  await runtime.start()
  await waitFor(() => getUpdatesStarted)
  await assert.doesNotReject(() =>
    Promise.race([
      runtime.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout while getUpdates pending")), 200)),
    ]),
  )
})

test("wechat status runtime: 初始化阶段失败会持续重试并在成功后继续轮询", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  let loadCalls = 0
  const errors = []
  const sendCalls = []
  let getUpdatesCalls = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 10,
    onRuntimeError: (error) => {
      errors.push(error)
    },
    loadPublicHelpers: async () => {
      loadCalls += 1
      if (loadCalls < 3) {
        throw new Error(`init failed ${loadCalls}`)
      }
      return {
        entry: {
          packageJsonPath: "/tmp/pkg.json",
          packageRoot: "/tmp",
          extensions: ["./index.js"],
          entryRelativePath: "./index.js",
          entryAbsolutePath: "/tmp/index.js",
        },
        pluginId: "test-plugin",
        qrGateway: {
          loginWithQrStart: () => ({}),
          loginWithQrWait: () => ({}),
        },
        latestAccountState: {
          accountId: "acc-1",
          token: "token-1",
          baseUrl: "https://wx.example.com",
        },
        getUpdates: async () => {
          getUpdatesCalls += 1
          if (getUpdatesCalls === 1) {
            return {
              get_updates_buf: "buf-1",
              msgs: [
                {
                  from_user_id: "user-a",
                  context_token: "ctx-a",
                  item_list: [{ type: 1, text_item: { text: "hello" } }],
                },
              ],
            }
          }
          return new Promise(() => {})
        },
        sendMessageWeixin: async (input) => {
          sendCalls.push(input)
          return { messageId: "m-1" }
        },
      }
    },
  })

  await runtime.start()
  try {
    await waitFor(() => loadCalls >= 3 && sendCalls.length >= 1, 2000)
    assert.equal(errors.length >= 2, true)
  } finally {
    await assert.doesNotReject(() =>
      Promise.race([
        runtime.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout after init retry success")), 200)),
      ]),
    )
  }
})

test("wechat status runtime: 初始化失败后的重试 sleep 可被 close 立刻中断", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  let loadCalls = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 60_000,
    loadPublicHelpers: async () => {
      loadCalls += 1
      throw new Error("init failed always")
    },
  })

  await runtime.start()
  await waitFor(() => loadCalls >= 1)
  await assert.doesNotReject(() =>
    Promise.race([
      runtime.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout while retry sleep pending")), 200)),
    ]),
  )
})

test("broker-entry runtime lifecycle: start/close 绑定且启动失败不抛出", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const normalCalls = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: () => ({
      start: async () => {
        normalCalls.push("start")
      },
      close: async () => {
        normalCalls.push("close")
      },
    }),
  })

  await assert.doesNotReject(() => lifecycle.start())
  await assert.doesNotReject(() => lifecycle.close())
  assert.deepEqual(normalCalls, ["start", "close"])

  let errorCalls = 0
  const failedLifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: () => ({
      start: async () => {
        throw new Error("runtime startup failed")
      },
      close: async () => {},
    }),
    onRuntimeError: () => {
      errorCalls += 1
    },
  })

  await assert.doesNotReject(() => failedLifecycle.start())
  await assert.doesNotReject(() => failedLifecycle.close())
  assert.equal(errorCalls, 1)
})

test("broker-entry runtime lifecycle: start 部分失败后 close 仍会清理 runtime", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const calls = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: () => ({
      start: async () => {
        calls.push("start")
        throw new Error("partial startup failed")
      },
      close: async () => {
        calls.push("close")
      },
    }),
    onRuntimeError: () => {},
  })

  await assert.doesNotReject(() => lifecycle.start())
  await assert.doesNotReject(() => lifecycle.close())
  assert.deepEqual(calls, ["start", "close"])
})

test("broker-entry runtime lifecycle: 注入 broker slash handler，/status 复用 server.handleWechatSlashCommand", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const slashInputCalls = []
  const brokerSlashCalls = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: ({ onSlashCommand }) => {
      return {
        start: async () => {
          slashInputCalls.push(
            await onSlashCommand({
              command: { type: "status" },
              text: "/status",
              message: { from_user_id: "u-1" },
            }),
          )
          slashInputCalls.push(
            await onSlashCommand({
              command: { type: "unimplemented", command: "reply" },
              text: "/reply hi",
              message: { from_user_id: "u-2" },
            }),
          )
        },
        close: async () => {},
      }
    },
    handleWechatSlashCommand: async (command) => {
      brokerSlashCalls.push(command)
      if (command.type === "status") {
        return "from broker collectStatus"
      }
      return `命令暂未实现：/${command.command}`
    },
  })

  await lifecycle.start()
  await lifecycle.close()

  assert.deepEqual(brokerSlashCalls, [
    { type: "status" },
    { type: "unimplemented", command: "reply" },
  ])
  assert.deepEqual(slashInputCalls, ["from broker collectStatus", "命令暂未实现：/reply"])
})

test("broker-entry runtime lifecycle: 默认 slash handler 不再返回 /status 处理中 占位文案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}`)

  const slashReplies = []
  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    createStatusRuntime: ({ onSlashCommand }) => ({
      start: async () => {
        slashReplies.push(
          await onSlashCommand({
            command: { type: "status" },
            text: "/status",
            message: { from_user_id: "u-default" },
          }),
        )
      },
      close: async () => {},
    }),
  })

  await lifecycle.start()
  await lifecycle.close()

  assert.equal(slashReplies.length, 1)
  assert.notEqual(slashReplies[0], "/status 处理中")
  assert.equal(slashReplies[0], "命令暂未实现：/status")
})

test("broker-entry runtime autostart gate: 默认关闭，仅 WECHAT_BROKER_ENABLE_STATUS_RUNTIME=1 时开启", async () => {
  const envKey = "WECHAT_BROKER_ENABLE_STATUS_RUNTIME"
  const previous = process.env[envKey]

  delete process.env[envKey]
  const brokerEntryDefault = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-default`)
  assert.equal(brokerEntryDefault.shouldEnableBrokerWechatStatusRuntime(), false)

  process.env[envKey] = "0"
  const brokerEntryDisabled = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-disabled`)
  assert.equal(brokerEntryDisabled.shouldEnableBrokerWechatStatusRuntime(), false)

  process.env[envKey] = "1"
  const brokerEntryEnabled = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-enabled`)
  assert.equal(brokerEntryEnabled.shouldEnableBrokerWechatStatusRuntime(), true)

  if (typeof previous === "string") {
    process.env[envKey] = previous
  } else {
    delete process.env[envKey]
  }
})
