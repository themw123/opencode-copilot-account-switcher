import test, { after } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"

const DIST_BROKER_SERVER_MODULE = "../dist/wechat/broker-server.js"
const DIST_BROKER_CLIENT_MODULE = "../dist/wechat/broker-client.js"
const DIST_BRIDGE_MODULE = "../dist/wechat/bridge.js"

const sandboxConfigHome = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-config-"))
const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = sandboxConfigHome

after(async () => {
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome
  }
  await rm(sandboxConfigHome, { recursive: true, force: true })
})

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

test("collectStatus 可通过环境变量收紧聚合窗口，未回包实例标记 timeout/unreachable", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-timeout-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const previousWindow = process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS

  process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = "1500"

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

    assert.equal(brokerServer.DEFAULT_STATUS_COLLECT_WINDOW_MS, 5000)
    assert.equal(elapsedMs >= 1400, true)

    const responsiveItem = result.instances.find((item) => item.instanceID === "status-responsive")
    const unresponsiveItem = result.instances.find((item) => item.instanceID === "status-unresponsive")

    assert.equal(responsiveItem.status, "ok")
    assert.deepEqual(responsiveItem.snapshot, { healthy: true })
    assert.equal(unresponsiveItem.status, "timeout/unreachable")
    assert.equal("snapshot" in unresponsiveItem, false)

  } finally {
    if (previousWindow === undefined) {
      delete process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS
    } else {
      process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = previousWindow
    }
    if (responsive) {
      await responsive.close().catch(() => {})
    }
    if (unresponsive) {
      await unresponsive.close().catch(() => {})
    }
    await server.close()
  }
})

test("collectStatus 不应把 1.6s 内返回的 snapshot 误判为 timeout", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-slow-success-"))
  const endpoint = createBrokerEndpoint(tempDir)

  const server = await brokerServer.startBrokerServer(endpoint)
  let slow = null

  try {
    slow = await brokerClient.connect(endpoint, {
      onCollectStatus: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1600))
        return { healthy: true }
      },
    })
    await slow.registerInstance({ instanceID: "status-slow-success", pid: process.pid })

    const result = await server.collectStatus()
    const item = result.instances.find((entry) => entry.instanceID === "status-slow-success")

    assert.equal(item?.status, "ok")
    assert.deepEqual(item?.snapshot, { healthy: true })

  } finally {
    if (slow) {
      await slow.close().catch(() => {})
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
        todo: async (input) => {
          const sessionID = typeof input === "string" ? input : input.sessionID
          calls.push(`session.todo:${sessionID}`)
          return [{ id: `${sessionID}-todo-1`, status: "in_progress" }]
        },
        messages: async (input) => {
          const sessionID = typeof input === "string" ? input : input.sessionID
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

test("bridge live snapshot: 兼容 SDK 默认的 fields-style 返回结构", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const todoArgs = []
  const messageArgs = []
  const wrap = (data) => ({
    data,
    error: null,
    request: new Request("http://localhost"),
    response: new Response("{}", { status: 200 }),
  })

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-fields-style",
    instanceName: "Bridge Fields Style",
    projectName: "project-fields-style",
    directory: "/repo",
    pid: 42346,
    client: {
      session: {
        list: async () => wrap([{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }]),
        status: async () => wrap({ "s-1": { type: "busy" } }),
        todo: async (input) => {
          todoArgs.push(input)
          return wrap([{ id: "todo-1", status: "in_progress" }])
        },
        messages: async (input) => {
          messageArgs.push(input)
          return wrap([{ info: { id: "m-1" }, parts: [] }])
        },
      },
      question: {
        list: async () => wrap([{ id: "q-1", sessionID: "s-1", text: "Q1" }]),
      },
      permission: {
        list: async () => wrap([{ id: "p-1", sessionID: "s-1", tool: "bash", command: "ls" }]),
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const digest = snapshot.sessions[0]

  assert.equal(snapshot.sessions.length, 1)
  assert.equal(digest.sessionID, "s-1")
  assert.equal(digest.status, "busy")
  assert.equal(digest.pendingQuestionCount, 1)
  assert.equal(digest.pendingPermissionCount, 1)
  assert.deepEqual(todoArgs, [{ sessionID: "s-1" }])
  assert.deepEqual(messageArgs, [{ sessionID: "s-1", limit: 1 }])
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

test("bridge live snapshot diagnostics: 记录超时阶段与总耗时", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const events = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-diagnostics",
    instanceName: "Bridge Diagnostics",
    projectName: "project-diagnostics",
    directory: "/repo",
    pid: 42347,
    liveReadTimeoutMs: 20,
    onDiagnosticEvent: async (event) => {
      events.push(event)
    },
    client: {
      session: {
        list: async () => [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }],
        status: async () => ({ "s-1": { type: "busy" } }),
        todo: async () => [{ id: "todo-1", status: "in_progress" }],
        messages: async () => new Promise(() => {}),
      },
      question: {
        list: async () => [],
      },
      permission: {
        list: async () => [],
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(snapshot.sessions.length, 1)

  const stageEvent = events.find((event) => event.type === "collectStatusStage" && event.stage === "session.messages:s-1")
  assert.equal(stageEvent?.status, "rejected")
  assert.equal(stageEvent?.timeout, true)
  assert.equal(typeof stageEvent?.durationMs, "number")

  const completedEvent = events.find((event) => event.type === "collectStatusCompleted")
  assert.equal(completedEvent?.instanceID, "bridge-instance-diagnostics")
  assert.equal(completedEvent?.sessionCount, 1)
  assert.equal(typeof completedEvent?.durationMs, "number")
})

test("bridge recovery diagnostics: resync 会记录 started/completed", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const events = []
  const calls = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-resync",
    instanceName: "Bridge Resync",
    projectName: "project-resync",
    directory: "/repo",
    pid: 52347,
    onDiagnosticEvent: async (event) => {
      events.push(event)
    },
    client: {
      session: {
        list: async () => {
          calls.push("session.list")
          return [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }]
        },
        status: async () => {
          calls.push("session.status")
          return { "s-1": { type: "busy" } }
        },
        todo: async () => {
          calls.push("session.todo")
          return []
        },
        messages: async () => {
          calls.push("session.messages")
          return []
        },
      },
      question: {
        list: async () => {
          calls.push("question.list")
          return []
        },
      },
      permission: {
        list: async () => {
          calls.push("permission.list")
          return []
        },
      },
    },
  })

  const snapshot = await bridge.resyncBrokerState({ reason: "brokerReconnect" })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(snapshot.sessions.length, 1)
  assert.deepEqual(calls, ["session.list", "session.status", "question.list", "permission.list", "session.todo", "session.messages"])

  const startedEvent = events.find((event) => event.type === "bridgeResyncStarted")
  assert.equal(startedEvent?.instanceID, "bridge-instance-resync")
  assert.equal(startedEvent?.reason, "brokerReconnect")

  const completedEvent = events.find((event) => event.type === "bridgeResyncCompleted")
  assert.equal(completedEvent?.instanceID, "bridge-instance-resync")
  assert.equal(completedEvent?.sessionCount, 1)
  assert.equal(typeof completedEvent?.durationMs, "number")
})

test("bridge recovery diagnostics: resync 失败时会记录稳定 failed code", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const events = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-resync-failed",
    instanceName: "Bridge Resync Failed",
    projectName: "project-resync-failed",
    directory: "/repo",
    pid: 52348,
    onDiagnosticEvent: async (event) => {
      events.push(event)
    },
    client: {
      session: {
        list: async () => ({ data: 123 }),
        status: async () => ({ data: {} }),
        todo: async () => [],
        messages: async () => [],
      },
      question: {
        list: async () => [],
      },
      permission: {
        list: async () => [],
      },
    },
  })

  await assert.rejects(() => bridge.resyncBrokerState({ reason: "manual" }))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const failedEvent = events.find((event) => event.type === "bridgeResyncFailed")
  assert.equal(failedEvent?.instanceID, "bridge-instance-resync-failed")
  assert.equal(failedEvent?.reason, "manual")
  assert.equal(failedEvent?.code, "bridgeResyncFailed")
  assert.equal(typeof failedEvent?.durationMs, "number")
  assert.match(failedEvent?.error ?? "", /not iterable|sessions is not iterable|spread/i)
})

test("bridge live snapshot: 未知当前前台 session 时显式返回 no active sessions", async () => {
  const bridgeModule = await import(`${DIST_BRIDGE_MODULE}?reload=${Date.now()}`)
  const statusFormat = await import(`../dist/wechat/status-format.js?reload=${Date.now()}`)
  const calls = []

  const bridge = bridgeModule.createWechatBridge({
    instanceID: "bridge-instance-no-known-session",
    instanceName: "Bridge No Known Session",
    projectName: "project-no-known-session",
    directory: "/repo",
    pid: 42348,
    getActiveSessionID: () => undefined,
    client: {
      session: {
        list: async () => {
          calls.push("session.list")
          return [{ id: "s-1", title: "s1", directory: "/repo", time: { updated: 100 } }]
        },
        status: async () => {
          calls.push("session.status")
          return { "s-1": { type: "busy" } }
        },
        todo: async () => {
          calls.push("session.todo")
          return []
        },
        messages: async () => {
          calls.push("session.messages")
          return []
        },
      },
      question: {
        list: async () => {
          calls.push("question.list")
          return []
        },
      },
      permission: {
        list: async () => {
          calls.push("permission.list")
          return []
        },
      },
    },
  })

  const snapshot = await bridge.collectStatusSnapshot()
  const reply = statusFormat.formatInstanceStatusSnapshot(snapshot)

  assert.equal(snapshot.sessions.length, 0)
  assert.deepEqual(calls, [])
  assert.match(reply, /no active sessions/i)
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

test("command parser: 识别 /status /reply /allow", async () => {
  const parser = await import(`../dist/wechat/command-parser.js?reload=${Date.now()}`)

  assert.deepEqual(parser.parseWechatSlashCommand("/status"), { type: "status" })
  assert.deepEqual(parser.parseWechatSlashCommand("/reply q1 done"), { type: "reply", handle: "q1", text: "done" })
  assert.deepEqual(parser.parseWechatSlashCommand("/allow p1 once approved"), {
    type: "allow",
    handle: "p1",
    reply: "once",
    message: "approved",
  })
  assert.deepEqual(parser.parseWechatSlashCommand("/allow p1 always approved"), {
    type: "allow",
    handle: "p1",
    reply: "always",
    message: "approved",
  })
  assert.deepEqual(parser.parseWechatSlashCommand("/allow p1 reject no"), {
    type: "allow",
    handle: "p1",
    reply: "reject",
    message: "no",
  })
  assert.equal(parser.parseWechatSlashCommand("/replyq1 done"), null)
  assert.equal(parser.parseWechatSlashCommand("/allowp1 once ok"), null)
  assert.equal(parser.parseWechatSlashCommand("status"), null)
})

test("broker slash handler: /status 走 collectStatus formatter，其它 slash 透传结构化命令", async () => {
  const brokerServer = await import(`${DIST_BROKER_SERVER_MODULE}?reload=${Date.now()}`)
  const brokerClient = await import(`${DIST_BROKER_CLIENT_MODULE}?reload=${Date.now()}`)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wechat-status-flow-slash-handler-"))
  const endpoint = createBrokerEndpoint(tempDir)
  const previousWindow = process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS

  process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = "1500"

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
      await server.handleWechatSlashCommand({ type: "reply", handle: "q1", text: "hi" }),
      "命令暂未实现：/reply",
    )
    assert.equal(
      await server.handleWechatSlashCommand({ type: "allow", handle: "p1", reply: "once" }),
      "命令暂未实现：/allow",
    )
  } finally {
    if (previousWindow === undefined) {
      delete process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS
    } else {
      process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = previousWindow
    }
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
  const previousWindow = process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS

  process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = "1500"

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
    if (previousWindow === undefined) {
      delete process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS
    } else {
      process.env.WECHAT_BROKER_STATUS_COLLECT_WINDOW_MS = previousWindow
    }
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

test("wechat status runtime: /status /reply /allow 走各自 slash handler，非 slash 不触发 collectStatus", async () => {
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
                item_list: [{ type: 1, text_item: { text: "/reply q1 hi" } }],
              },
              {
                from_user_id: "user-allow",
                context_token: "ctx-allow",
                item_list: [{ type: 1, text_item: { text: "/allow p1 once" } }],
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
      if (command.type === "reply") {
        return "reply result"
      }
      return "allow result"
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
    { type: "reply", handle: "q1", text: "hi" },
    { type: "allow", handle: "p1", reply: "once" },
  ])
  assert.equal(sendCalls[0].text, "formatted status reply from collectStatus")
  assert.equal(sendCalls[1].text, "reply result")
  assert.equal(sendCalls[2].text, "allow result")
  assert.equal(sendCalls[3].text, runtimeModule.DEFAULT_NON_SLASH_REPLY_TEXT)
})

test("wechat status runtime diagnostics: 记录 skipped/slash/send-failed 三类断点事件", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const diagnostics = []
  let pollCount = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    onDiagnosticEvent: (event) => {
      diagnostics.push(event)
    },
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-diag",
        token: "token-diag",
        baseUrl: "https://wx.example.com",
        getUpdatesBuf: "buf-diag",
      },
      getUpdates: async () => {
        pollCount += 1
        if (pollCount === 1) {
          return {
            get_updates_buf: "buf-diag-next",
            msgs: [
              {
                item_list: [{ type: 1, text_item: { text: "/status" } }],
              },
              {
                from_user_id: "user-empty",
                item_list: [{ type: 1, text_item: { text: "   " } }],
              },
              {
                from_user_id: "user-status",
                context_token: "ctx-status",
                item_list: [{ type: 1, text_item: { text: " /status " } }],
              },
            ],
          }
        }
        return new Promise(() => {})
      },
      sendMessageWeixin: async () => {
        throw new Error("send failed for diagnostics")
      },
    }),
    onSlashCommand: async () => "status diagnostics reply",
  })

  await runtime.start()
  try {
    await waitFor(() => diagnostics.length >= 4)
  } finally {
    await runtime.close()
  }

  const skippedMissingFromUserId = diagnostics.find(
    (event) => event?.type === "messageSkipped" && event?.reason === "missingFromUserId",
  )
  const skippedMissingText = diagnostics.find(
    (event) => event?.type === "messageSkipped" && event?.reason === "missingText",
  )
  const recognizedStatus = diagnostics.find(
    (event) => event?.type === "slashCommandRecognized" && event?.command?.type === "status",
  )
  const sendFailed = diagnostics.find(
    (event) => event?.type === "replySendFailed" && event?.to === "user-status",
  )

  assert.ok(skippedMissingFromUserId)
  assert.ok(skippedMissingText)
  assert.ok(recognizedStatus)
  assert.ok(sendFailed)
})

test("wechat status runtime diagnostics: 诊断写入挂起不阻塞 slash 回复发送", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const sendCalls = []
  let pollCount = 0
  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    onDiagnosticEvent: async () => new Promise(() => {}),
    loadPublicHelpers: async () => ({
      latestAccountState: {
        accountId: "acc-diag-hang",
        token: "token-diag-hang",
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
        return { messageId: "m-1" }
      },
    }),
    onSlashCommand: async () => "status reply unaffected by diagnostics",
  })

  await runtime.start()
  try {
    await waitFor(() => sendCalls.length === 1, 300)
  } finally {
    await runtime.close()
  }

  assert.equal(sendCalls[0].to, "user-status")
  assert.equal(sendCalls[0].text, "status reply unaffected by diagnostics")
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

test("wechat status runtime: 后续轮询会重新加载最新账号状态而不是一直复用初始化快照", async () => {
  const runtimeModule = await import(`../dist/wechat/wechat-status-runtime.js?reload=${Date.now()}`)

  const getUpdatesCalls = []
  let loadCount = 0
  let pollCount = 0

  const runtime = runtimeModule.createWechatStatusRuntime({
    retryDelayMs: 0,
    loadPublicHelpers: async () => {
      loadCount += 1
      const accountId = loadCount === 1 ? "acc-old" : "acc-new"
      const token = loadCount === 1 ? "token-old" : "token-new"
      const baseUrl = loadCount === 1 ? "https://wx-old.example.com" : "https://wx-new.example.com"
      return {
        latestAccountState: {
          accountId,
          token,
          baseUrl,
          getUpdatesBuf: loadCount === 1 ? "buf-old" : "buf-new",
        },
        getUpdates: async (input) => {
          pollCount += 1
          getUpdatesCalls.push(input)
          if (pollCount === 1) {
            return {
              get_updates_buf: "buf-old-next",
              msgs: [],
            }
          }
          return new Promise(() => {})
        },
        sendMessageWeixin: async () => ({ messageId: "m-1" }),
      }
    },
    shouldReloadState: () => loadCount === 1,
  })

  await runtime.start()
  try {
    await waitFor(() => getUpdatesCalls.length >= 2)
  } finally {
    await runtime.close()
  }

  assert.equal(loadCount >= 2, true)
  assert.equal(getUpdatesCalls[0].baseUrl, "https://wx-old.example.com")
  assert.equal(getUpdatesCalls[0].token, "token-old")
  assert.equal(getUpdatesCalls[1].baseUrl, "https://wx-new.example.com")
  assert.equal(getUpdatesCalls[1].token, "token-new")
  assert.equal(getUpdatesCalls[1].get_updates_buf, "buf-new")
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
              command: { type: "reply", handle: "q1", text: "hi" },
              text: "/reply q1 hi",
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
      if (command.type === "reply") {
        return "from broker reply"
      }
      return "from broker allow"
    },
  })

  await lifecycle.start()
  await lifecycle.close()

  assert.deepEqual(brokerSlashCalls, [
    { type: "status" },
    { type: "reply", handle: "q1", text: "hi" },
  ])
  assert.deepEqual(slashInputCalls, ["from broker collectStatus", "from broker reply"])
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

test("broker-entry slash handler: /reply q1 done 命中 open question 并回写 request 与 notification", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-handler`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-handler-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-handler-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-reply-handler-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-reply-handler-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-handle-1" })
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-handle-1",
    routeKey,
    handle: "q1",
    wechatAccountId: "wx-reply",
    userId: "u-reply",
    createdAt: 1_700_300_000_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-reply-q1",
    kind: "question",
    routeKey,
    handle: "q1",
    wechatAccountId: "wx-reply",
    userId: "u-reply",
    createdAt: 1_700_300_000_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_000_200,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "q1", text: "done" })

  assert.equal(result, "已回复问题：q1")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, answers: [["done"]] }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "question", handle: "q1" })
  assert.equal(openAfterReply, undefined)

  const replyAgain = await handler({ type: "reply", handle: "q1", text: "done again" })
  assert.equal(replyAgain, "未找到待回复问题：q1")

  const resolvedRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
  assert.equal(typeof resolved.resolvedAt, "number")
})

test("broker-entry slash handler: /reply 文本题保持兼容并回写自由文本 answers", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-text-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-text-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-text-mode-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-text-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-text-1",
    routeKey,
    handle: "qtext1",
    wechatAccountId: "wx-reply-text",
    userId: "u-reply-text",
    createdAt: 1_700_600_200_000,
    prompt: {
      title: "补充说明",
      mode: "text",
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qtext1", text: "hello world" })
  assert.equal(result, "已回复问题：qtext1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-text-1", answers: [["hello world"]] }])
})

test("broker-entry slash handler: /reply 单选题把编号转成结构化答案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-single-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-single-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-single-mode-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-single-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-single-1",
    routeKey,
    handle: "qsingle1",
    wechatAccountId: "wx-reply-single",
    userId: "u-reply-single",
    createdAt: 1_700_600_210_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qsingle1", text: "2" })
  assert.equal(result, "已回复问题：qsingle1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-single-1", answers: [["production"]] }])
})

test("broker-entry slash handler: /reply 多选题把逗号编号转成结构化答案", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-multiple-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-multiple-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-multiple-mode-request-store`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-multiple-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-multiple-1",
    routeKey,
    handle: "qmulti1",
    wechatAccountId: "wx-reply-multi",
    userId: "u-reply-multi",
    createdAt: 1_700_600_220_000,
    prompt: {
      title: "请选择需要通知的环境",
      mode: "multiple",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
        { index: 3, label: "preview", value: "preview" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qmulti1", text: "1,3" })
  assert.equal(result, "已回复问题：qmulti1")
  assert.deepEqual(replyCalls, [{ requestID: "q-reply-multiple-1", answers: [["staging", "preview"]] }])
})

test("broker-entry slash handler: /reply 非法编号会返回稳定中文提示", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-invalid-mode`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-invalid-mode-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-invalid-mode-request-store`)

  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-reply-invalid-1" })
  await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-reply-invalid-1",
    routeKey,
    handle: "qinvalid1",
    wechatAccountId: "wx-reply-invalid",
    userId: "u-reply-invalid",
    createdAt: 1_700_600_230_000,
    prompt: {
      title: "请选择发布环境",
      mode: "single",
      options: [
        { index: 1, label: "staging", value: "staging" },
        { index: 2, label: "production", value: "production" },
      ],
    },
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async () => ({ data: true }),
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qinvalid1", text: "3" })
  assert.match(result, /选项编号超出范围|无效选项|编号/)
})

test("broker-entry slash handler: /allow p1 always safe 命中 open permission 并回写 answered + resolved", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-handler`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-handler-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-handler-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-handler-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-handler-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-allow-handle-1" })
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-allow-handle-1",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow",
    userId: "u-allow",
    createdAt: 1_700_300_100_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-p1",
    kind: "permission",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow",
    userId: "u-allow",
    createdAt: 1_700_300_100_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_100_200,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {},
      permission: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
    },
  })

  const result = await handler({ type: "allow", handle: "p1", reply: "always", message: "safe" })

  assert.equal(result, "已处理权限请求：p1 (always)")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, reply: "always", message: "safe" }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "p1" })
  assert.equal(openAfterReply, undefined)

  const resolvedRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
  assert.equal(typeof resolved.resolvedAt, "number")
})

test("broker-entry slash handler: /allow p1 reject no 会回写 rejected + resolved", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-reject-handler`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-reject-handler-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-reject-handler-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-reject-handler-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-reject-handler-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-allow-reject-1" })
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-allow-reject-1",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow-reject",
    userId: "u-allow-reject",
    createdAt: 1_700_300_200_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-reject-p1",
    kind: "permission",
    routeKey,
    handle: "p1",
    wechatAccountId: "wx-allow-reject",
    userId: "u-allow-reject",
    createdAt: 1_700_300_200_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_200_200,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {},
      permission: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
    },
  })

  const result = await handler({ type: "allow", handle: "p1", reply: "reject", message: "no" })

  assert.equal(result, "已处理权限请求：p1 (reject)")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, reply: "reject", message: "no" }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "p1" })
  assert.equal(openAfterReply, undefined)

  const resolvedRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const resolved = JSON.parse(resolvedRaw)
  assert.equal(resolved.status, "resolved")
  assert.equal(typeof resolved.resolvedAt, "number")
})

test("broker-entry slash handler: handle 不存在或非法时返回稳定中文提示", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-not-found-handler`)

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async () => ({ data: true }),
      },
      permission: {
        reply: async () => ({ data: true }),
      },
    },
  })

  assert.equal(
    await handler({ type: "reply", handle: "q404", text: "done" }),
    "未找到待回复问题：q404",
  )
  assert.equal(
    await handler({ type: "reply", handle: "req-raw-001", text: "done" }),
    "未找到待回复问题：req-raw-001",
  )
  assert.equal(
    await handler({ type: "allow", handle: "p404", reply: "once", message: "ok" }),
    "未找到待处理权限请求：p404",
  )
  assert.equal(
    await handler({ type: "allow", handle: "request-raw-001", reply: "always", message: "ok" }),
    "未找到待处理权限请求：request-raw-001",
  )
})

test("broker-entry slash handler: 仅有 pending notification 时 /allow 仍成功且静默跳过 resolve", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-allow-pending-notification`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-allow-pending-notification-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-allow-pending-notification-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-allow-pending-notification-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-allow-pending-notification-state-paths`)

  const replyCalls = []
  const routeKey = handle.createRouteKey({ kind: "permission", requestID: "p-no-sent-notification-1" })
  const created = await requestStore.upsertRequest({
    kind: "permission",
    requestID: "p-no-sent-notification-1",
    routeKey,
    handle: "pnosent1",
    wechatAccountId: "wx-no-sent",
    userId: "u-no-sent",
    createdAt: 1_700_300_300_000,
  })
  const pending = await notificationStore.upsertNotification({
    idempotencyKey: "notif-allow-pending-only",
    kind: "permission",
    routeKey,
    handle: "pnosent1",
    wechatAccountId: "wx-no-sent",
    userId: "u-no-sent",
    createdAt: 1_700_300_300_100,
  })

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {},
      permission: {
        reply: async (input) => {
          replyCalls.push(input)
          return { data: true }
        },
      },
    },
  })

  const result = await handler({ type: "allow", handle: "pnosent1", reply: "always", message: "safe" })

  assert.equal(result, "已处理权限请求：pnosent1 (always)")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, reply: "always", message: "safe" }])

  const openAfterReply = await requestStore.findOpenRequestByHandle({ kind: "permission", handle: "pnosent1" })
  assert.equal(openAfterReply, undefined)

  const pendingRaw = await readFile(statePaths.notificationStatePath(pending.idempotencyKey), "utf8")
  const pendingRecord = JSON.parse(pendingRaw)
  assert.equal(pendingRecord.status, "pending")
  assert.equal(pendingRecord.resolvedAt, undefined)
})

test("broker-entry slash handler: notification resolve 竞态失败时 /reply 仍返回成功", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-reply-resolve-race`)
  const handle = await import(`../dist/wechat/handle.js?reload=${Date.now()}-reply-resolve-race-handle`)
  const requestStore = await import(`../dist/wechat/request-store.js?reload=${Date.now()}-reply-resolve-race-request-store`)
  const notificationStore = await import(`../dist/wechat/notification-store.js?reload=${Date.now()}-reply-resolve-race-notification-store`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-reply-resolve-race-state-paths`)

  const routeKey = handle.createRouteKey({ kind: "question", requestID: "q-resolve-race-1" })
  const created = await requestStore.upsertRequest({
    kind: "question",
    requestID: "q-resolve-race-1",
    routeKey,
    handle: "qrace1",
    wechatAccountId: "wx-race",
    userId: "u-race",
    createdAt: 1_700_300_400_000,
  })
  const sent = await notificationStore.upsertNotification({
    idempotencyKey: "notif-reply-resolve-race",
    kind: "question",
    routeKey,
    handle: "qrace1",
    wechatAccountId: "wx-race",
    userId: "u-race",
    createdAt: 1_700_300_400_100,
  })
  await notificationStore.markNotificationSent({
    idempotencyKey: sent.idempotencyKey,
    sentAt: 1_700_300_400_200,
  })

  const replyCalls = []
  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async (input) => {
          replyCalls.push(input)
          await notificationStore.markNotificationResolved({
            idempotencyKey: sent.idempotencyKey,
            resolvedAt: 1_700_300_400_300,
          })
          return { data: true }
        },
      },
      permission: {},
    },
  })

  const result = await handler({ type: "reply", handle: "qrace1", text: "done" })

  assert.equal(result, "已回复问题：qrace1")
  assert.deepEqual(replyCalls, [{ requestID: created.requestID, answers: [["done"]] }])
  assert.equal(await requestStore.findOpenRequestByHandle({ kind: "question", handle: "qrace1" }), undefined)

  const notificationRaw = await readFile(statePaths.notificationStatePath(sent.idempotencyKey), "utf8")
  const notification = JSON.parse(notificationRaw)
  assert.equal(notification.status, "resolved")
})

test("broker-entry slash handler: request 查询存储异常不应被误报为 not-found", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-lookup-storage-error`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-lookup-storage-error-state-paths`)

  const brokenPath = statePaths.requestStatePath("question", "question-broken-json")
  await mkdir(path.dirname(brokenPath), { recursive: true })
  await writeFile(brokenPath, "{not-json")

  const handler = brokerEntry.createBrokerWechatSlashCommandHandler({
    handleStatusCommand: async () => "status reply",
    client: {
      question: {
        reply: async () => ({ data: true }),
      },
      permission: {},
    },
  })

  await assert.rejects(
    () => handler({ type: "reply", handle: "q1", text: "done" }),
    /invalid request record format/i,
  )
})

test("broker-entry runtime autostart gate: 默认始终开启，不再依赖环境变量", async () => {
  const envKey = "WECHAT_BROKER_ENABLE_STATUS_RUNTIME"
  const previous = process.env[envKey]

  delete process.env[envKey]
  const brokerEntryDefault = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-always-on-default`)
  assert.equal(brokerEntryDefault.shouldEnableBrokerWechatStatusRuntime(), true)

  process.env[envKey] = "0"
  const brokerEntryDisabled = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-always-on-disabled`)
  assert.equal(brokerEntryDisabled.shouldEnableBrokerWechatStatusRuntime(), true)

  process.env[envKey] = "1"
  const brokerEntryEnabled = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-always-on-enabled`)
  assert.equal(brokerEntryEnabled.shouldEnableBrokerWechatStatusRuntime(), true)

  if (typeof previous === "string") {
    process.env[envKey] = previous
  } else {
    delete process.env[envKey]
  }
})

test("broker-entry runtime lifecycle: 默认把诊断事件写入稳定文件路径", async () => {
  const brokerEntry = await import(`../dist/wechat/broker-entry.js?reload=${Date.now()}-diag-file`)
  const statePaths = await import(`../dist/wechat/state-paths.js?reload=${Date.now()}-diag-path`)
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wechat-status-runtime-diagnostics-"))

  const lifecycle = brokerEntry.createBrokerWechatStatusRuntimeLifecycle({
    stateRoot,
    createStatusRuntime: ({ onDiagnosticEvent }) => ({
      start: async () => {
        await onDiagnosticEvent?.({
          type: "slashCommandRecognized",
          command: { type: "status" },
          text: "/status",
          to: "u-diagnostic",
        })
      },
      close: async () => {},
    }),
  })

  await lifecycle.start()
  await lifecycle.close()

  const diagnosticsPath = statePaths.wechatStatusRuntimeDiagnosticsPath(stateRoot)
  const raw = await readFile(diagnosticsPath, "utf8")
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  assert.equal(lines.length, 1)

  const event = JSON.parse(lines[0])
  assert.equal(event.type, "slashCommandRecognized")
  assert.equal(event.command.type, "status")
  assert.equal(event.to, "u-diagnostic")
})
