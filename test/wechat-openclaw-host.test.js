import test from "node:test"
import assert from "node:assert/strict"

const DIST_HOST_MODULE = "../dist/wechat/compat/openclaw-host.js"

function createApiStub(overrides = {}) {
  return {
    runtime: {
      channelRuntime: {
        kind: "slash-only",
      },
      gateway: {
        startAccount: {
          source: "wechat",
        },
      },
    },
    registerChannel() {},
    registerCli() {},
    ...overrides,
  }
}

test("must resolve plugin public entry from package.json openclaw.extensions[0]", async () => {
  const host = await import(DIST_HOST_MODULE)
  const entry = await host.resolveOpenClawWeixinPublicEntry()

  assert.equal(entry.extensions[0], "./index.ts")
  assert.match(entry.entryRelativePath, /^\.\/index\.ts$/)
  assert.match(entry.entryAbsolutePath, /openclaw-weixin[\\/]index\.ts$/)
  assert.match(entry.packageJsonPath, /openclaw-weixin[\\/]package\.json$/)
})

test("must load plugin default export through public index.ts and register(api)", async () => {
  const host = await import(DIST_HOST_MODULE)
  const entry = await host.resolveOpenClawWeixinPublicEntry()
  const compiledEntryPath = await host.resolveOpenClawWeixinCompatImportPath()

  assert.doesNotMatch(compiledEntryPath, /node_modules[\\/]@tencent-weixin[\\/]openclaw-weixin[\\/]/)
  assert.ok(!compiledEntryPath.startsWith(entry.packageRoot))

  const plugin = await host.loadOpenClawWeixinDefaultExport()
  assert.equal(plugin.id, "openclaw-weixin")

   const pluginAgain = await host.loadOpenClawWeixinDefaultExport()
   assert.equal(pluginAgain, plugin)

  const registerChannelCalls = []
  const registerCliCalls = []
  const api = createApiStub({
    registerChannel(input) {
      registerChannelCalls.push(input)
    },
    registerCli(handler, options) {
      registerCliCalls.push({ handler, options })
    },
  })

  await assert.doesNotReject(() => host.loadAndRegisterOpenClawWeixin(api))
  assert.equal(registerChannelCalls.length, 1)
  assert.equal(registerChannelCalls[0]?.plugin?.id, "openclaw-weixin")
  assert.equal(registerCliCalls.length, 1)
  assert.deepEqual(registerCliCalls[0]?.options?.commands, ["openclaw-weixin"])
})

test("missing runtime/registerChannel/gateway.startAccount must fail immediately", async () => {
  const host = await import(DIST_HOST_MODULE)

  await assert.rejects(() => host.loadAndRegisterOpenClawWeixin({}), /runtime|registerChannel|startAccount/i)
  await assert.rejects(
    () => host.loadAndRegisterOpenClawWeixin({ runtime: createApiStub().runtime }),
    /registerChannel/i,
  )
  await assert.rejects(
    () => host.loadAndRegisterOpenClawWeixin({ runtime: { channelRuntime: {}, gateway: {} }, registerChannel() {} }),
    /startAccount/i,
  )
})

test("empty channelRuntime must fail", async () => {
  const host = await import(DIST_HOST_MODULE)
  const api = createApiStub({ runtime: { channelRuntime: null, gateway: { startAccount: {} } } })

  await assert.rejects(() => host.loadAndRegisterOpenClawWeixin(api), /channelRuntime/i)
})

test("channelRuntime must be a non-empty object", async () => {
  const host = await import(DIST_HOST_MODULE)

  await assert.rejects(
    () => host.loadAndRegisterOpenClawWeixin(createApiStub({ runtime: { channelRuntime: {}, gateway: { startAccount: {} } } })),
    /channelRuntime/i,
  )
  await assert.rejects(
    () => host.loadAndRegisterOpenClawWeixin(createApiStub({ runtime: { channelRuntime: true, gateway: { startAccount: {} } } })),
    /channelRuntime/i,
  )
})

test("slash-only mode does not require full routing/session/reply host capabilities", async () => {
  const host = await import(DIST_HOST_MODULE)
  const api = createApiStub({
    runtime: {
      channelRuntime: {
        mode: "slash-only",
      },
      gateway: {
        startAccount: {
          source: "wechat",
        },
      },
    },
  })

  await assert.doesNotReject(() => host.loadAndRegisterOpenClawWeixin(api))
})
