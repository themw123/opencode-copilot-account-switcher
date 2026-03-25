import test from "node:test"
import assert from "node:assert/strict"

async function importPluginHooks() {
  return import(`../dist/plugin-hooks.js?reload=${Date.now()}-${Math.random()}`)
}

async function importBridgeModule() {
  return import(`../dist/wechat/bridge.js?reload=${Date.now()}-${Math.random()}`)
}

test("plugin-hooks 仅接入 /status bridge 生命周期", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const calls = []
  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
      todo: async () => [],
      messages: async () => [],
    },
    question: {
      list: async () => [],
    },
    permission: {
      list: async () => [],
    },
  }
  const project = { id: "project-id", name: "wechat-stage-a" }
  const directory = "/workspace/wechat-stage-a"
  const serverUrl = new URL("http://127.0.0.1:4096")

  const plugin = buildPluginHooksRaw({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    client,
    project,
    directory,
    serverUrl,
    createWechatBridgeLifecycleImpl: async (input) => {
      calls.push(input)
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].client, client)
  assert.equal(calls[0].project, project)
  assert.equal(calls[0].directory, directory)
  assert.equal(calls[0].serverUrl, serverUrl)
  assert.equal(calls[0].statusCollectionEnabled, true)

  assert.equal(typeof plugin["command.execute.before"], "function")
  assert.equal(Object.hasOwn(plugin, "wechat.event.notify"), false)
  assert.equal(Object.hasOwn(plugin, "wechat.question.reply"), false)
  assert.equal(Object.hasOwn(plugin, "wechat.permission.reply"), false)
})

test("plugin-hooks 重复 build 不应重复初始化 bridge lifecycle", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const calls = []
  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
      todo: async () => [],
      messages: async () => [],
    },
    question: {
      list: async () => [],
    },
    permission: {
      list: async () => [],
    },
  }

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    createWechatBridgeLifecycleImpl: async (input) => {
      calls.push(input)
      return {
        close: async () => {},
      }
    },
  })

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a",
    serverUrl: new URL("http://127.0.0.1:4096"),
    createWechatBridgeLifecycleImpl: async (input) => {
      calls.push(input)
      return {
        close: async () => {},
      }
    },
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(calls.length, 1)
})

test("plugin-hooks lifecycle key 变化时必须关闭旧实例，最终仅保留一个活跃 lifecycle", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const active = new Set()
  let closeCount = 0

  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
      todo: async () => [],
      messages: async () => [],
    },
    question: {
      list: async () => [],
    },
    permission: {
      list: async () => [],
    },
  }

  const createWechatBridgeLifecycleImpl = async () => {
    const handle = Symbol("lifecycle")
    active.add(handle)
    return {
      close: async () => {
        if (active.delete(handle)) {
          closeCount += 1
        }
      },
    }
  }

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a-A",
    serverUrl: new URL("http://127.0.0.1:4096"),
    createWechatBridgeLifecycleImpl,
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(active.size, 1)

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/wechat-stage-a-B",
    serverUrl: new URL("http://127.0.0.1:4096"),
    createWechatBridgeLifecycleImpl,
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(closeCount, 1)
  assert.equal(active.size, 1)
})

test("plugin-hooks 旧 lifecycle 仍在初始化中时切 key，旧 promise resolve 后也必须 close", async () => {
  const { buildPluginHooks: buildPluginHooksRaw } = await importPluginHooks()
  const active = new Set()
  let closeCount = 0
  let firstResolve
  const secondHandle = Symbol("second-lifecycle")

  const firstPromise = new Promise((resolve) => {
    firstResolve = resolve
  })

  let createCalls = 0
  const createWechatBridgeLifecycleImpl = async () => {
    createCalls += 1
    if (createCalls === 1) {
      return firstPromise
    }

    active.add(secondHandle)
    return {
      close: async () => {
        if (active.delete(secondHandle)) {
          closeCount += 1
        }
      },
    }
  }

  const client = {
    session: {
      list: async () => [],
      status: async () => ({}),
      todo: async () => [],
      messages: async () => [],
    },
    question: { list: async () => [] },
    permission: { list: async () => [] },
  }

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/pending-old-A",
    serverUrl: new URL("http://127.0.0.1:4096"),
    createWechatBridgeLifecycleImpl,
  })

  buildPluginHooksRaw({
    auth: { provider: "github-copilot", methods: [] },
    client,
    project: { name: "wechat-stage-a" },
    directory: "/workspace/pending-old-B",
    serverUrl: new URL("http://127.0.0.1:4096"),
    createWechatBridgeLifecycleImpl,
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(active.size, 1)
  assert.equal(closeCount, 0)

  firstResolve({
    close: async () => {
      closeCount += 1
    },
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(closeCount, 1)
  assert.equal(active.size, 1)
})

test("bridge lifecycle register 失败时会回收已建立 brokerClient", async () => {
  const { createWechatBridgeLifecycle } = await importBridgeModule()
  let closed = 0

  const deps = {
    connectOrSpawnBrokerImpl: async () => ({ endpoint: "fake-endpoint" }),
    connectImpl: async () => ({
      registerInstance: async () => {
        throw new Error("register failed")
      },
      heartbeat: async () => ({}),
      close: async () => {
        closed += 1
      },
    }),
    setIntervalImpl: globalThis.setInterval,
    clearIntervalImpl: globalThis.clearInterval,
  }

  await assert.rejects(
    () => createWechatBridgeLifecycle({
      statusCollectionEnabled: true,
      client: {
        session: {
          list: async () => [],
          status: async () => ({}),
          todo: async () => [],
          messages: async () => [],
        },
        question: { list: async () => [] },
        permission: { list: async () => [] },
      },
      directory: "/workspace/wechat-stage-a",
    }, deps),
    /register failed/i,
  )

  assert.equal(closed, 1)
})

test("bridge lifecycle heartbeat 与 close 边界：仅定时心跳，close 清理且幂等", async () => {
  const { createWechatBridgeLifecycle } = await importBridgeModule()
  let heartbeatCalls = 0
  let closeCalls = 0
  let timerCallback = null
  const activeTimers = new Set()

  const deps = {
    connectOrSpawnBrokerImpl: async () => ({ endpoint: "fake-endpoint" }),
    connectImpl: async () => ({
      registerInstance: async () => ({ sessionToken: "token", registeredAt: Date.now(), brokerPid: process.pid }),
      heartbeat: async () => {
        heartbeatCalls += 1
        return {}
      },
      close: async () => {
        closeCalls += 1
      },
    }),
    setIntervalImpl: (cb, _ms) => {
      const handle = { id: Symbol("timer") }
      timerCallback = cb
      activeTimers.add(handle)
      return handle
    },
    clearIntervalImpl: (handle) => {
      activeTimers.delete(handle)
    },
  }

  const lifecycle = await createWechatBridgeLifecycle({
    statusCollectionEnabled: true,
    heartbeatIntervalMs: 50,
    client: {
      session: {
        list: async () => [],
        status: async () => ({}),
        todo: async () => [],
        messages: async () => [],
      },
      question: { list: async () => [] },
      permission: { list: async () => [] },
    },
    directory: "/workspace/wechat-stage-a",
  }, deps)

  assert.equal(typeof timerCallback, "function")
  assert.equal(activeTimers.size, 1)

  await timerCallback()
  assert.equal(heartbeatCalls, 1)

  await lifecycle.close()
  assert.equal(activeTimers.size, 0)
  assert.equal(closeCalls, 1)

  await lifecycle.close()
  assert.equal(closeCalls, 1)
})
