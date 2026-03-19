import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"

import { ACCOUNT_SWITCH_TTL_MS } from "../dist/copilot-retry-notifier.js"
import { applyMenuAction } from "../dist/plugin-actions.js"
import { buildPluginHooks } from "../dist/plugin-hooks.js"
import { buildCandidateAccountLoads } from "../dist/routing-state.js"
import { LOOP_SAFETY_POLICY } from "../dist/loop-safety-plugin.js"

async function armInject(plugin, args = "") {
  await assert.rejects(
    async () => plugin["command.execute.before"]?.(
      { command: "copilot-inject", sessionID: "s1", arguments: args },
      { parts: [] },
    ),
    (error) => error?.name === "InjectCommandHandledError",
  )
}

async function toggleAllModelsPolicy(plugin) {
  await assert.rejects(
    async () => plugin["command.execute.before"]?.(
      { command: "copilot-policy-all-models", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    (error) => error?.name === "PolicyScopeCommandHandledError",
  )
}

test("plugin exposes auth and experimental chat system transform hooks", () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
    }),
  })

  assert.equal(plugin.auth?.provider, "github-copilot")
  assert.equal(typeof plugin.auth?.loader, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(typeof plugin["experimental.chat.system.transform"], "function")
})

test("status slash command is injected when experiment is enabled", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
  })

  const config = { command: {} }
  await plugin.config?.(config)

  assert.equal(typeof config.command["copilot-status"], "object")
  assert.match(config.command["copilot-status"].template, /quota|Copilot|status/i)
  assert.match(config.command["copilot-status"].description, /Copilot|status/i)
  assert.equal(typeof config.command["copilot-inject"], "object")
  assert.equal(typeof config.command["copilot-policy-all-models"], "object")
  assert.match(config.command["copilot-inject"].template, /tool|question|inject|intervene/i)
})

test("experimental slash commands are not injected when unified switch is disabled", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStoreSync: () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: false,
    }),
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: false,
    }),
  })

  const config = { command: {} }
  await plugin.config?.(config)

  assert.equal(Object.hasOwn(config.command, "copilot-status"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
})

test("slash commands are injected immediately without waiting for async store load", () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: () => new Promise(() => {}),
    loadStoreSync: () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
  })

  const config = { command: {} }
  plugin.config?.(config)

  assert.equal(typeof config.command["copilot-status"], "object")
  assert.equal(typeof config.command["copilot-inject"], "object")
  assert.equal(typeof config.command["copilot-policy-all-models"], "object")
})

test("disabled experimental slash switch is decided from sync store path without waiting for async store load", () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: () => new Promise(() => {}),
    loadStoreSync: () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: false,
    }),
  })

  const config = { command: {} }
  plugin.config?.(config)

  assert.equal(Object.hasOwn(config.command, "copilot-status"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-inject"), false)
  assert.equal(Object.hasOwn(config.command, "copilot-policy-all-models"), false)
})

test("policy all-models command toggles current instance policy injection scope for non-Copilot providers", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: true,
      experimentalSlashCommandsEnabled: true,
      loopSafetyProviderScope: "copilot-only",
    }),
    client: {
      tui: {
        showToast: async () => {},
      },
    },
  })
  const before = { system: ["base prompt"] }
  await plugin["experimental.chat.system.transform"]?.(
    { sessionID: "s1", model: { providerID: "google" } },
    before,
  )

  await toggleAllModelsPolicy(plugin)

  const afterEnable = { system: ["base prompt"] }
  await plugin["experimental.chat.system.transform"]?.(
    { sessionID: "s1", model: { providerID: "google" } },
    afterEnable,
  )

  await toggleAllModelsPolicy(plugin)

  const afterDisable = { system: ["base prompt"] }
  await plugin["experimental.chat.system.transform"]?.(
    { sessionID: "s1", model: { providerID: "google" } },
    afterDisable,
  )

  assert.deepEqual(before.system, ["base prompt"])
  assert.match(afterEnable.system.join("\n"), /Guided Loop Safety Policy/)
  assert.deepEqual(afterDisable.system, ["base prompt"])
})

test("copilot-inject command ignores arguments, arms inject mode, and stops extra command execution", async () => {
  const calls = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {
      tui: {
        showToast: async (options) => {
          calls.push(options)
        },
      },
    },
  })

  await armInject(plugin, "anything here")

  assert.match(String(calls[0]?.body?.message ?? ""), /下次调用工具|next tool/i)
})

test("inject appends marker to non-question tool output", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await armInject(plugin)

  const output = { title: "run", output: "original output", metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "pwd" } },
    output,
  )

  assert.match(output.output, /original output/)
  assert.match(output.output, /\[COPILOT_INJECT_V1_BEGIN\]/)
  assert.match(output.output, /\[COPILOT_INJECT_V1_END\]/)
})

test("inject preserves original output and appends only", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await armInject(plugin)

  const raw = "line1\nline2"
  const output = { title: "x", output: raw, metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "read", sessionID: "s1", callID: "c1", args: {} },
    output,
  )

  assert.equal(output.output.startsWith(raw), true)
})

test("inject avoids duplicate marker when already present", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await armInject(plugin)

  const marker = [
    "[COPILOT_INJECT_V1_BEGIN]",
    "立即调用 question 工具并等待用户指示；在收到用户新指示前，不要继续执行后续任务。",
    "[COPILOT_INJECT_V1_END]",
  ].join("\n")
  const output = { title: "x", output: `ok\n\n${marker}`, metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "glob", sessionID: "s1", callID: "c1", args: {} },
    output,
  )

  const beginCount = (String(output.output).match(/\[COPILOT_INJECT_V1_BEGIN\]/g) ?? []).length
  assert.equal(beginCount, 1)
})

test("inject repairs partial marker and appends full marker pair", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await armInject(plugin)

  const output = { title: "x", output: "before\n[COPILOT_INJECT_V1_BEGIN]\n", metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "grep", sessionID: "s1", callID: "c1", args: {} },
    output,
  )

  const result = String(output.output)
  const beginCount = (result.match(/\[COPILOT_INJECT_V1_BEGIN\]/g) ?? []).length
  const endCount = (result.match(/\[COPILOT_INJECT_V1_END\]/g) ?? []).length
  assert.equal(beginCount, 1)
  assert.equal(endCount, 1)
})

test("inject normalizes empty or non-string output before append", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await armInject(plugin)

  const emptyOutput = { title: "x", output: undefined, metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "task", sessionID: "s1", callID: "c1", args: {} },
    emptyOutput,
  )
  assert.match(String(emptyOutput.output), /\[COPILOT_INJECT_V1_BEGIN\]/)

  const numberOutput = { title: "x", output: 123, metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "bash", sessionID: "s1", callID: "c2", args: {} },
    numberOutput,
  )
  assert.match(String(numberOutput.output), /^123/)
})

test("inject toasts on every actual append", async () => {
  const calls = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {
      tui: {
        showToast: async (options) => {
          calls.push(options)
        },
      },
    },
  })

  await armInject(plugin)
  const output1 = { title: "x", output: "o1", metadata: {} }
  const output2 = { title: "x", output: "o2", metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "read", sessionID: "s1", callID: "c1", args: {} },
    output1,
  )
  await plugin["tool.execute.after"]?.(
    { tool: "glob", sessionID: "s1", callID: "c2", args: {} },
    output2,
  )

  const injectToasts = calls
    .map((item) => String(item?.body?.message ?? ""))
    .filter((message) => /已要求模型立刻调用提问工具/.test(message))
  assert.equal(injectToasts.length, 2)
})

test("inject stays fail-open when toast dispatch fails", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {
      tui: {
        showToast: async () => {
          throw new Error("toast-failed")
        },
      },
    },
  })

  await armInject(plugin)

  const output = { title: "x", output: "original", metadata: {} }
  await assert.doesNotReject(() => plugin["tool.execute.after"]?.(
    { tool: "read", sessionID: "s1", callID: "c1", args: {} },
    output,
  ))
  assert.match(String(output.output), /\[COPILOT_INJECT_V1_BEGIN\]/)
})

test("question clears inject armed state", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await armInject(plugin)
  await plugin["tool.execute.before"]?.(
    { tool: "question", sessionID: "s1", callID: "q1" },
    { args: {} },
  )

  const output = { title: "x", output: "after-question", metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "read", sessionID: "s1", callID: "c1", args: {} },
    output,
  )

  assert.doesNotMatch(String(output.output), /\[COPILOT_INJECT_V1_BEGIN\]/)
})

test("after question inject no longer appends markers", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await armInject(plugin)
  await plugin["tool.execute.after"]?.(
    { tool: "question", sessionID: "s1", callID: "q1", args: {} },
    { title: "q", output: "question output", metadata: {} },
  )

  const output = { title: "x", output: "next", metadata: {} }
  await plugin["tool.execute.after"]?.(
    { tool: "glob", sessionID: "s1", callID: "c1", args: {} },
    output,
  )

  assert.equal(String(output.output), "next")
})

test("tool.definition rewrites question description with wait and uncertainty semantics", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
  })

  const output = { description: "original", parameters: {} }
  await plugin["tool.definition"]?.({ toolID: "question" }, output)

  assert.match(output.description, /required user response|explicit wait|final handoff|uncertain/i)
})

test("tool.definition rewrites notify description as non-blocking progress channel", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
  })

  const output = { description: "original", parameters: {} }
  await plugin["tool.definition"]?.({ toolID: "notify" }, output)

  assert.match(output.description, /non-blocking progress|phase updates|immediate user response/i)
})

test("status command hook ignores unrelated commands", async () => {
  const calls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
    writeStore: async (store, meta) => writes.push({ store, meta }),
    client: {
      tui: {
        showToast: async (options) => calls.push(options),
      },
    },
  })

  assert.equal(typeof plugin["command.execute.before"], "function")

  await assert.doesNotReject(() => plugin["command.execute.before"]?.(
    { command: "review", sessionID: "s1", arguments: "" },
    { parts: [] },
  ))

  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
})

test("status command hook delegates to status command handler", async () => {
  const calls = []
  const writes = []
  const delegated = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      active: "alice",
      accounts: {
        alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
      },
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: true,
    }),
    writeStore: async (store, meta) => writes.push({ store, meta }),
    client: {
      tui: {
        showToast: async (options) => calls.push(options),
      },
    },
    handleStatusCommandImpl: async (input) => {
      delegated.push({
        loadStore: typeof input.loadStore,
        writeStore: typeof input.writeStore,
        refreshQuota: typeof input.refreshQuota,
      })
      throw new Error("delegated")
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /delegated/,
  )

  assert.equal(delegated.length, 1)
  assert.equal(delegated[0]?.loadStore, "function")
  assert.equal(delegated[0]?.writeStore, "function")
  assert.equal(delegated[0]?.refreshQuota, "function")
  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
})

test("status command hook still delegates when hook-level loadStore precheck fails", async () => {
  const delegated = []
  let refreshCount = 0
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => {
      throw new Error("store read failed")
    },
    handleStatusCommandImpl: async (input) => {
      delegated.push({
        loadStore: typeof input.loadStore,
        refreshQuota: typeof input.refreshQuota,
      })
      throw new Error("delegated")
    },
    refreshQuota: async () => {
      refreshCount += 1
      return { type: "missing-active" }
    },
  })

  await assert.rejects(
    plugin["command.execute.before"]?.(
      { command: "copilot-status", sessionID: "s1", arguments: "" },
      { parts: [] },
    ),
    /delegated/,
  )

  assert.equal(delegated.length, 1)
  assert.equal(delegated[0]?.loadStore, "function")
  assert.equal(delegated[0]?.refreshQuota, "function")
  assert.equal(refreshCount, 0)
})

test("status command hook does nothing when unified slash switch is disabled", async () => {
  const calls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      active: "alice",
      accounts: {
        alice: { name: "alice", refresh: "ghu_x", access: "ghu_x", expires: 0 },
      },
      loopSafetyEnabled: false,
      experimentalSlashCommandsEnabled: false,
    }),
    writeStore: async (store, meta) => writes.push({ store, meta }),
    client: {
      tui: {
        showToast: async (options) => calls.push(options),
      },
    },
    handleStatusCommandImpl: async () => {
      throw new Error("should not delegate")
    },
  })

  await assert.doesNotReject(() => plugin["command.execute.before"]?.(
    { command: "copilot-status", sessionID: "s1", arguments: "" },
    { parts: [] },
  ))

  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
})

function createToolContext() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "task",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

test("plugin exposes notify tool for model progress updates", () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
  })

  assert.equal(typeof plugin.tool?.notify?.execute, "function")
  assert.match(plugin.tool?.notify?.description ?? "", /notify/i)
  assert.ok(plugin.tool?.notify?.args?.message)
  assert.ok(plugin.tool?.notify?.args?.variant)
  assert.equal(Object.hasOwn(plugin.tool?.notify?.args ?? {}, "title"), false)
  assert.equal(Object.hasOwn(plugin.tool?.notify?.args ?? {}, "duration"), false)
})

test("notify tool defaults variant to info", async () => {
  const calls = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {
      tui: {
        showToast: async (options) => {
          calls.push(options)
        },
      },
    },
  })

  await plugin.tool.notify.execute(
    { message: "still working" },
    createToolContext(),
  )

  assert.equal(calls[0]?.body?.variant, "info")
})

test("notify tool maps message and variant to tui.showToast", async () => {
  const calls = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {
      tui: {
        showToast: async (options) => {
          calls.push(options)
        },
      },
    },
  })

  const result = await plugin.tool.notify.execute(
    { message: "后台继续执行测试", variant: "info" },
    {
      sessionID: "s1",
      messageID: "m1",
      agent: "task",
      directory: "/tmp/project",
      worktree: "/tmp/project",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    },
  )

  assert.equal(result, "ok")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.body?.message, "后台继续执行测试")
  assert.equal(calls[0]?.body?.variant, "info")
})

test("notify tool fails open when showToast is unavailable", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
    client: {},
  })

  await assert.doesNotReject(() => plugin.tool.notify.execute(
    { message: "still running" },
    createToolContext(),
  ))
})

test("notify tool swallows toast failures and warns once", async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(" "))

  try {
    const plugin = buildPluginHooks({
      auth: { provider: "github-copilot", methods: [] },
      loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false }),
      client: {
        tui: {
          showToast: async () => {
            throw new Error("toast failed")
          },
        },
      },
    })

    await assert.doesNotReject(() => plugin.tool.notify.execute(
      { message: "still running" },
      createToolContext(),
    ))
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? "", /notify-tool/i)
})

test("plugin source does not preload upstream hook bundle for untouched hooks", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.doesNotMatch(pluginSource, /loadOfficialCopilotHooks/)
})

test("plugin chat headers only append internal session id locally", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
    }),
    loadOfficialChatHeaders: async () => async (input, output) => {
      output.headers["x-initiator"] = "agent"
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    },
  })

  const chatHeaders = plugin["chat.headers"]
  const copilotOutput = {
    headers: {
      existing: "value",
    },
  }
  const enterpriseOutput = {
    headers: {},
  }
  const googleOutput = {
    headers: {
      existing: "value",
    },
  }

  await chatHeaders?.(
    {
      sessionID: "session-123",
      agent: "build",
      model: {
        providerID: "github-copilot",
        api: {
          npm: "@ai-sdk/anthropic",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m1" },
    },
    copilotOutput,
  )
  await chatHeaders?.(
    {
      sessionID: "session-ent-123",
      agent: "build",
      model: {
        providerID: "github-copilot-enterprise",
        api: {
          npm: "@ai-sdk/github-copilot",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m2" },
    },
    enterpriseOutput,
  )
  await chatHeaders?.(
    {
      sessionID: "session-456",
      agent: "build",
      model: {
        providerID: "google",
        api: {
          npm: "@ai-sdk/google",
        },
      },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m3" },
    },
    googleOutput,
  )

  assert.equal(copilotOutput.headers.existing, "value")
  assert.equal(copilotOutput.headers["x-opencode-session-id"], "session-123")
  assert.equal(enterpriseOutput.headers["x-opencode-session-id"], "session-ent-123")
  assert.equal(googleOutput.headers.existing, "value")
  assert.equal(Object.hasOwn(googleOutput.headers, "x-opencode-session-id"), false)
})

function createSyntheticChatHeadersHarness(input = {}) {
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      syntheticAgentInitiatorEnabled: input.syntheticAgentInitiatorEnabled === true,
    }),
    client: input.client ?? {
      session: {
        message: async (request) => {
          calls.push(request)
          if (typeof input.messageResponse === "function") {
            return input.messageResponse(request)
          }
          return input.messageResponse
        },
      },
    },
    directory: "/tmp/project",
    loadOfficialChatHeaders: async () => async (_hookInput, output) => {
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      if (input.officialInitiator !== undefined) {
        output.headers["x-initiator"] = input.officialInitiator
      }
    },
  })

  return {
    calls,
    chatHeaders: plugin["chat.headers"],
  }
}

function createChatHeadersInput(input = {}) {
  return {
    sessionID: input.sessionID ?? "session-123",
    agent: "task",
    model: {
      providerID: input.providerID ?? "github-copilot",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    },
    provider: { source: "custom", info: {}, options: {} },
    message: input.message ?? {
      id: "message-456",
      sessionID: input.sessionID ?? "session-123",
    },
  }
}

function createFirstUseInitiatorHarness(input = {}) {
  const outgoing = []
  const officialInitiators = new Map()
  const store = {
    active: input.active ?? "main",
    accounts: {
      main: {
        name: "main",
        refresh: "main-refresh",
        access: "main-access",
        expires: 0,
      },
      alt: {
        name: "alt",
        refresh: "alt-refresh",
        access: "alt-access",
        expires: 0,
      },
      ...(input.accounts ?? {}),
    },
    modelAccountAssignments: input.modelAccountAssignments,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    ...(input.store ?? {}),
  }

  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const normalizedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        const call = {
          auth,
          url: request instanceof URL ? request.href : String(request),
          headers: normalizedHeaders,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        }
        outgoing.push(call)

        if (typeof input.fetchImpl === "function") {
          return input.fetchImpl({
            request,
            init,
            auth,
            call,
            attempt: outgoing.length,
          })
        }

        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
    loadOfficialChatHeaders: async () => async (hookInput, output) => {
      for (const [name, value] of Object.entries(input.officialHeaders ?? {})) {
        output.headers[name] = value
      }

      if (!officialInitiators.has(hookInput.message.id)) {
        return
      }

      const initiator = officialInitiators.get(hookInput.message.id)
      if (initiator !== null) {
        output.headers["x-initiator"] = initiator
      }
    },
  })

  const authOptionsPromise = plugin.auth?.loader?.(
    async () => {
      const active = store.accounts[store.active]
      return {
        type: "oauth",
        refresh: active.refresh,
        access: active.access,
        expires: active.expires,
        enterpriseUrl: active.enterpriseUrl,
      }
    },
    { models: {} },
  )

  return {
    outgoing,
    store,
    async sendRequest(options = {}) {
      const messageID = options.messageID ?? `message-${outgoing.length + 1}`
      const sessionID = options.sessionID ?? "session-123"
      const headers = { ...(options.initialHeaders ?? {}) }

      if (Object.hasOwn(options, "officialInitiator")) {
        officialInitiators.set(messageID, options.officialInitiator ?? null)
      }

      await plugin["chat.headers"]?.(
        createChatHeadersInput({
          sessionID,
          providerID: options.providerID,
          message: {
            id: messageID,
            sessionID,
          },
        }),
        { headers },
      )

      const authOptions = await authOptionsPromise
      return authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: options.model ?? "o3" }),
      })
    },
  }
}

function createSessionBindingHarness(input = {}) {
  const outgoing = []
  let loadCall = 0
  const store = {
    active: "main",
    activeAccountNames: ["main", "alt"],
    accounts: {
      main: {
        name: "main",
        refresh: "main-refresh",
        access: "main-access",
        expires: 0,
      },
      alt: {
        name: "alt",
        refresh: "alt-refresh",
        access: "alt-access",
        expires: 0,
      },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    ...(input.store ?? {}),
  }

  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadCandidateAccountLoads: async (ctx) => {
      if (typeof input.loadCandidateAccountLoads !== "function") return undefined
      return input.loadCandidateAccountLoads({ ...ctx, call: loadCall++ })
    },
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const normalizedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        outgoing.push({
          auth,
          url: request instanceof URL ? request.href : String(request),
          headers: normalizedHeaders,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptionsPromise = plugin.auth?.loader?.(
    async () => {
      const active = store.accounts[store.active]
      return {
        type: "oauth",
        refresh: active.refresh,
        access: active.access,
        expires: active.expires,
        enterpriseUrl: active.enterpriseUrl,
      }
    },
    { models: {} },
  )

  return {
    outgoing,
    async sendRequest(options = {}) {
      const authOptions = await authOptionsPromise
      return authOptions?.fetch?.("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: {
          "x-opencode-session-id": options.sessionID ?? "child-session",
          "x-initiator": options.initiator ?? "agent",
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({
          model: options.model ?? "gpt-5",
        }),
      })
    },
  }
}

async function sendFirstUseRequest(harness, options = {}) {
  await harness.sendRequest(options)
  return harness.outgoing.at(-1)
}

function assertInitiatorHeader(call, expected) {
  if (expected === undefined) {
    assert.equal(Object.hasOwn(call.headers, "x-initiator"), false)
    return
  }

  assert.equal(call.headers["x-initiator"], expected)
}

test("plugin chat headers synthetic stays disabled by default", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.deepEqual(output.headers, {
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-opencode-session-id": "session-123",
  })
})

test("plugin chat headers synthetic text overrides x-initiator when enabled", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.deepEqual(output.headers, {
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-initiator": "agent",
    "x-opencode-session-id": "session-123",
  })
  assert.deepEqual(calls, [
    {
      path: {
        id: "session-123",
        messageID: "message-456",
      },
      query: {
        directory: "/tmp/project",
      },
      throwOnError: true,
    },
  ])
})

test("plugin chat headers synthetic leaves ordinary text unchanged", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Plain user message", synthetic: false }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers continue template text without synthetic never triggers", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task now", synthetic: false }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers synthetic non-text part does not trigger", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: {
      data: {
        parts: [{ type: "tool", synthetic: true, text: "Continue with the next task now" }],
      },
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers non-Copilot provider ignores synthetic initiator", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    messageResponse: async () => {
      throw new Error("lookup should not run")
    },
  })
  const output = {
    headers: {
      "x-initiator": "user",
    },
  }

  await chatHeaders?.(createChatHeadersInput({ providerID: "google" }), output)

  assert.equal(output.headers["x-initiator"], "user")
  assert.deepEqual(calls, [])
})

test("plugin chat headers synthetic lookup failure preserves official initiator", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: async () => {
      throw new Error("lookup failure")
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers synthetic preserves official initiator when official already set one", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
  assert.deepEqual(calls, [])
})

test("plugin chat headers synthetic missing message id preserves official initiator", async () => {
  const { chatHeaders, calls } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {
        parts: [{ type: "text", text: "Continue with the next task", synthetic: true }],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput({ message: { sessionID: "session-123" } }), output)

  assert.equal(output.headers["x-initiator"], "user")
  assert.deepEqual(calls, [])
})

test("plugin chat headers synthetic missing parts preserves official initiator", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {},
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers synthetic empty parts preserves official initiator", async () => {
  const { chatHeaders } = createSyntheticChatHeadersHarness({
    syntheticAgentInitiatorEnabled: true,
    officialInitiator: "user",
    messageResponse: {
      data: {
        parts: [],
      },
    },
  })
  const output = { headers: {} }

  await chatHeaders?.(createChatHeadersInput(), output)

  assert.equal(output.headers["x-initiator"], "user")
})

test("plugin chat headers debug logs include evidence and candidates without leaking session parent id", async () => {
  const logLines = []
  const originalWarn = console.warn
  process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE = ""
  process.env.OPENCODE_COPILOT_RETRY_DEBUG = "1"
  console.warn = (...args) => {
    logLines.push(args.map(String).join(" "))
  }

  try {
    const plugin = buildPluginHooks({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      loadStore: async () => ({
        accounts: {},
        loopSafetyEnabled: false,
      }),
      client: {
        session: {
          message: async () => ({
            data: {
              parts: [
                { type: "compaction" },
                { type: "text", text: "Continue with   the next task now", synthetic: true },
              ],
            },
          }),
          get: async () => ({
            data: {
              parentID: "parent-secret-value",
            },
          }),
          messages: async () => ({
            data: [
              {
                info: { id: "message-456", role: "user" },
                parentID: "parent-secret-value",
                parts: [
                  { type: "compaction" },
                  { type: "text", text: "Continue with   the next task now", synthetic: true },
                ],
              },
              {
                info: { id: "assistant-1", role: "assistant" },
                parentID: "root-parent",
                summary: true,
                finish: "stop",
                parts: [{ type: "text" }],
              },
              {
                info: { id: "assistant-0", role: "assistant" },
                parentID: "older-parent",
                summary: false,
                finish: "length",
                parts: [{ type: "tool" }],
              },
            ],
          }),
        },
      },
      directory: "/tmp/project",
      loadOfficialChatHeaders: async () => async (_input, output) => {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
        output.headers["x-initiator"] = "agent"
      },
    })

    await plugin["chat.headers"]?.(
      {
        sessionID: "session-123",
        agent: "task",
        model: {
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        provider: { source: "custom", info: {}, options: {} },
        message: {
          id: "message-456",
          sessionID: "message-session-789",
        },
      },
      { headers: { existing: "value" } },
    )
  } finally {
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG
    delete process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE
    console.warn = originalWarn
  }

  assert.deepEqual(logLines, [])
})

test("plugin auth loader keeps official fetch when network retry is disabled", async () => {
  const calls = []
  const fetchImpl = async (request, init) => {
    calls.push({ request, init })
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: fetchImpl,
    }),
    createRetryFetch: () => {
      throw new Error("retry wrapper should stay disabled")
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(options?.baseURL, "https://api.githubcopilot.com")
  assert.equal(typeof options?.fetch, "function")
  assert.notEqual(options?.fetch, fetchImpl)
  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "o3" }),
  })
  assert.equal(calls.length, 1)
})

test("plugin auth loader wraps official fetch when network retry is enabled", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const wrappedFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch) => {
      calls.push(fetch)
      return wrappedFetch
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0], "function")
  assert.notEqual(calls[0], officialFetch)
  assert.equal(options?.fetch, wrappedFetch)
})

test("plugin auth loader suppresses first-use agent initiator once and restores agent initiator on later requests", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async (_request, init) => {
        outgoing.push(Object.fromEntries(new Headers(init?.headers).entries()))
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
    }),
    loadOfficialChatHeaders: async () => async (_input, output) => {
      output.headers["x-initiator"] = "agent"
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })
  const sendAgentRequest = async (messageID) => {
    const headers = {}
    await plugin["chat.headers"]?.(
      {
        sessionID: "child-session",
        agent: "task",
        model: {
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        provider: { source: "custom", info: {}, options: {} },
        message: { id: messageID },
      },
      { headers },
    )

    await options?.fetch?.("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "o3",
        input: [{ role: "user", content: [] }],
      }),
    })
  }

  await sendAgentRequest("msg-1")
  await sendAgentRequest("msg-2")

  assert.equal(outgoing.length, 2)
  assert.equal(Object.hasOwn(outgoing[0], "x-initiator"), false)
  assert.equal(outgoing[1]["x-initiator"], "agent")
  assert.equal(outgoing[1]["anthropic-beta"], "interleaved-thinking-2025-05-14")
})

test("plugin auth loader only suppresses first use once and keeps subagent initiator across later retry requests", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async (_request, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        outgoing.push({
          headers: {
            "x-initiator": "user",
            ...(init?.headers),
            Authorization: "Bearer test-token",
          },
          body,
        })

        if (body.input?.[1]?.id) {
          return new Response(
            "Invalid 'input[2].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.",
            { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
          )
        }

        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
    }),
    loadOfficialChatHeaders: async () => async (_input, output) => {
      output.headers["x-initiator"] = "agent"
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })
  const sendAgentRequest = async (messageID, body) => {
    const headers = {}
    await plugin["chat.headers"]?.(
      {
        sessionID: "child-session",
        agent: "task",
        model: {
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        provider: { source: "custom", info: {}, options: {} },
        message: { id: messageID },
      },
      { headers },
    )

    await options?.fetch?.("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  }

  await sendAgentRequest("msg-1", {
    model: "o3",
    input: [{ role: "user", content: [] }],
  })
  await sendAgentRequest("msg-2", {
    model: "o3",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "x".repeat(408) },
    ],
  })

  assert.equal(outgoing.length, 3)
  assert.equal(outgoing[0].headers["x-initiator"], "user")
  assert.equal(outgoing[1].headers["x-initiator"], "agent")
  assert.equal(outgoing[1].headers["anthropic-beta"], "interleaved-thinking-2025-05-14")
  assert.equal(outgoing[2].headers["x-initiator"], "agent")
  assert.equal(outgoing[2].headers["anthropic-beta"], "interleaved-thinking-2025-05-14")
  assert.equal(outgoing[2].body.input[1].id, undefined)
})

test("plugin auth loader initiator first use strips first agent request for an account", async () => {
  const harness = createFirstUseInitiatorHarness({
    officialHeaders: {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
  })

  const firstCall = await sendFirstUseRequest(harness, {
    model: "o3",
    officialInitiator: "agent",
    initialHeaders: {
      "x-test-header": "kept",
    },
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(firstCall.auth.refresh, "main-refresh")
  assertInitiatorHeader(firstCall, undefined)
  assert.equal(firstCall.headers["anthropic-beta"], "interleaved-thinking-2025-05-14")
  assert.equal(firstCall.headers["x-test-header"], "kept")
})

test("plugin auth loader initiator first use restores agent header on second request for same account", async () => {
  const harness = createFirstUseInitiatorHarness()

  const firstCall = await sendFirstUseRequest(harness, {
    model: "o3",
    officialInitiator: "agent",
    initialHeaders: {
      "x-test-header": "first",
    },
  })
  const secondCall = await sendFirstUseRequest(harness, {
    model: "o3",
    officialInitiator: "agent",
    initialHeaders: {
      "x-test-header": "second",
    },
  })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(firstCall, undefined)
  assert.equal(firstCall.headers["x-test-header"], "first")
  assertInitiatorHeader(secondCall, "agent")
  assert.equal(secondCall.headers["x-test-header"], "second")
})

test("plugin auth loader initiator first use is tracked independently per account", async () => {
  const harness = createFirstUseInitiatorHarness({
    modelAccountAssignments: {
      "gpt-5": "alt",
    },
  })

  const altFirstCall = await sendFirstUseRequest(harness, { model: "gpt-5", officialInitiator: "agent" })
  const mainFirstCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(altFirstCall.auth.refresh, "alt-refresh")
  assertInitiatorHeader(altFirstCall, undefined)
  assert.equal(mainFirstCall.auth.refresh, "main-refresh")
  assertInitiatorHeader(mainFirstCall, undefined)
})

test("plugin auth loader initiator first use keeps first user header and leaves next agent request unchanged", async () => {
  const harness = createFirstUseInitiatorHarness()

  const firstUserCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "user" })
  const secondAgentCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(firstUserCall, "user")
  assertInitiatorHeader(secondAgentCall, "agent")
})

test("plugin auth loader initiator first use keeps missing initiator missing and leaves next agent request unchanged", async () => {
  const harness = createFirstUseInitiatorHarness()

  const firstMissingCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: null })
  const secondAgentCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(firstMissingCall, undefined)
  assertInitiatorHeader(secondAgentCall, "agent")
})

test("plugin auth loader initiator first use consumes first use when account is chosen by active fallback", async () => {
  const harness = createFirstUseInitiatorHarness({
    active: "alt",
    modelAccountAssignments: {
      "gpt-5": "alt",
    },
  })

  const fallbackFirstCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })
  const mappedSecondCall = await sendFirstUseRequest(harness, { model: "gpt-5", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(fallbackFirstCall.auth.refresh, "alt-refresh")
  assertInitiatorHeader(fallbackFirstCall, undefined)
  assert.equal(mappedSecondCall.auth.refresh, "alt-refresh")
  assertInitiatorHeader(mappedSecondCall, "agent")
})

test("plugin auth loader initiator first use does not roll back when first send fails", async () => {
  const harness = createFirstUseInitiatorHarness({
    fetchImpl: ({ attempt }) => {
      if (attempt === 1) {
        throw new Error("send failed")
      }

      return new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
  })

  await assert.rejects(
    harness.sendRequest({ model: "o3", officialInitiator: "agent" }),
    /send failed/,
  )
  const secondCall = await sendFirstUseRequest(harness, { model: "o3", officialInitiator: "agent" })

  assert.equal(harness.outgoing.length, 2)
  assertInitiatorHeader(harness.outgoing[0], undefined)
  assertInitiatorHeader(secondCall, "agent")
})

test("plugin auth loader initiator first use normalizes Request and init headers together", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      loopSafetyEnabled: false,
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const headers = new Headers(request instanceof Request ? request.headers : undefined)
        for (const [name, value] of new Headers(init?.headers).entries()) {
          headers.set(name, value)
        }
        const normalizedHeaders = Object.fromEntries(headers.entries())
        outgoing.push({ auth, headers: normalizedHeaders })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await authOptions?.fetch?.(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-test-header": "request",
    },
    body: JSON.stringify({ model: "o3" }),
  }), {
    headers: new Headers({
      "x-initiator": "agent",
      "x-added-header": "init",
    }),
  })
  await authOptions?.fetch?.(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-test-header": "request",
    },
    body: JSON.stringify({ model: "o3" }),
  }), {
    headers: new Headers({
      "x-initiator": "agent",
      "x-added-header": "init",
    }),
  })

  assert.equal(outgoing.length, 2)
  assert.equal(outgoing[0].auth.refresh, "main-refresh")
  assertInitiatorHeader(outgoing[0], undefined)
  assert.equal(outgoing[0].headers["x-test-header"], "request")
  assert.equal(outgoing[0].headers["x-added-header"], "init")
  assertInitiatorHeader(outgoing[1], "agent")
  assert.equal(outgoing[1].headers["x-test-header"], "request")
  assert.equal(outgoing[1].headers["x-added-header"], "init")
})

test("plugin auth loader first-use agent detection uses merged header precedence", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
      },
      loopSafetyEnabled: false,
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const auth = await getAuth()
        const headers = new Headers(request instanceof Request ? request.headers : undefined)
        for (const [name, value] of new Headers(init?.headers).entries()) {
          headers.set(name, value)
        }
        outgoing.push({ auth, headers: Object.fromEntries(headers.entries()) })
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const authOptions = await plugin.auth?.loader?.(async () => ({
    type: "oauth",
    refresh: "base-refresh",
    access: "base-access",
    expires: 0,
  }), { models: {} })

  await authOptions?.fetch?.(new Request("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "x-initiator": "user",
    },
    body: JSON.stringify({ model: "o3" }),
  }), {
    headers: new Headers({
      "x-initiator": "agent",
      "x-added-header": "init",
    }),
  })

  assert.equal(outgoing.length, 1)
  assertInitiatorHeader(outgoing[0], undefined)
  assert.equal(outgoing[0].headers["x-added-header"], "init")
})

test("plugin auth loader passes plugin context into retry wrapper factory", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const fakeClient = { session: { messages: async () => ({ data: [] }) } }
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
    client: fakeClient,
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0].fetch, "function")
  assert.notEqual(calls[0].fetch, officialFetch)
  assert.equal(calls[0].ctx?.client, fakeClient)
  assert.equal(calls[0].ctx?.directory, "C:/repo")
  assert.equal(calls[0].ctx?.serverUrl?.href, "http://localhost:4096/")
})

test("plugin auth loader only wires explicitly provided account switch clear callback", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const clearCalls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
    clearAccountSwitchContext: async (lastAccountSwitchAt) => {
      clearCalls.push(lastAccountSwitchAt)
    },
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].ctx?.lastAccountSwitchAt, 1_717_171_717_171)
  assert.equal(typeof calls[0].ctx?.clearAccountSwitchContext, "function")
  await calls[0].ctx?.clearAccountSwitchContext?.()
  assert.deepEqual(clearCalls, [1_717_171_717_171])
})

test("plugin auth loader provides default account switch clear callback", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0].ctx?.clearAccountSwitchContext, "function")
})

test("plugin auth loader instantiates notifier and injects its interface into retry wrapper", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const retryCalls = []
  const toastCalls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryCalls.push({ fetch, ctx })
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next, meta) => {
      writes.push({
        lastAccountSwitchAt: next.lastAccountSwitchAt,
        loopSafetyEnabled: next.loopSafetyEnabled,
        networkRetryEnabled: next.networkRetryEnabled,
        meta,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(retryCalls.length, 1)
  assert.equal(typeof retryCalls[0].ctx?.notifier?.started, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.progress, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.repairWarning, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.completed, "function")
  assert.equal(typeof retryCalls[0].ctx?.notifier?.stopped, "function")
  assert.equal("tui" in retryCalls[0].ctx.notifier, false)

  await retryCalls[0].ctx.notifier.started({ remaining: 2 })
  assert.equal(toastCalls.length, 1)
  assert.match(toastCalls[0].body.message, /剩余 2 项/)
  assert.deepEqual(writes, [
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
  ])
})

test("plugin auth loader notifier is a no-op when plugin client toast sdk is unavailable", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const retryCalls = []
  const writes = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      lastAccountSwitchAt: 1_717_171_717_171,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryCalls.push({ fetch, ctx })
      return fetch
    },
    writeStore: async (next, meta) => {
      writes.push({
        lastAccountSwitchAt: next.lastAccountSwitchAt,
        loopSafetyEnabled: next.loopSafetyEnabled,
        networkRetryEnabled: next.networkRetryEnabled,
        meta,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(retryCalls.length, 1)
  await assert.doesNotReject(async () => {
    await retryCalls[0].ctx.notifier.started({ remaining: 3 })
    await retryCalls[0].ctx.notifier.progress({ remaining: 2 })
    await retryCalls[0].ctx.notifier.repairWarning({ remaining: 2 })
    await retryCalls[0].ctx.notifier.completed({ remaining: 0 })
    await retryCalls[0].ctx.notifier.stopped({ remaining: 1 })
  })
  assert.deepEqual(writes, [
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
    {
      lastAccountSwitchAt: undefined,
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
      meta: {
        reason: "clear-account-switch-context",
        source: "plugin-hooks",
      },
    },
  ])
})

test("plugin auth loader notifier reads latest account switch context from store after loader setup", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const writes = []
  const now = 1_717_171_900_000
  const recentSwitchAt = now - 5_000
  const expiredSwitchAt = now - ACCOUNT_SWITCH_TTL_MS - 1
  const store = {
    active: "account",
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next) => {
      writes.push(next.lastAccountSwitchAt)
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof retryContext?.notifier?.started, "function")

  store.lastAccountSwitchAt = recentSwitchAt
  await retryContext.notifier.started({ remaining: 2 })

  assert.match(toastCalls[0].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)

  store.lastAccountSwitchAt = expiredSwitchAt
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[1].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)
  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [undefined])
})

test("plugin auth loader notifier keeps captured account-switch copy after external context clears", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const now = 1_717_171_900_000
  const initialSwitchAt = now - 5_000
  const store = {
    active: "account",
    lastAccountSwitchAt: initialSwitchAt,
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  store.lastAccountSwitchAt = undefined
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[0].body.message, /正在清理可能因账号切换遗留的非法输入 ID/)
})


test("plugin auth loader returns empty config when official loader has no oauth config", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: false,
      networkRetryEnabled: true,
    }),
    loadOfficialConfig: async () => undefined,
    createRetryFetch: () => {
      throw new Error("retry wrapper should not be called")
    },
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "token" }), { models: {} })

  assert.deepEqual(options, {})
})

test("plugin auth loader uses mapped account for matching Copilot model requests and falls back otherwise", async () => {
  const calls = []
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      active: "main",
      accounts: {
        main: {
          name: "main",
          refresh: "main-refresh",
          access: "main-access",
          expires: 0,
        },
        alt: {
          name: "alt",
          refresh: "alt-refresh",
          access: "alt-access",
          expires: 0,
          enterpriseUrl: "example.ghe.com",
          models: {
            available: ["gpt-5"],
            disabled: [],
          },
        },
      },
      modelAccountAssignments: {
        "gpt-5": "alt",
      },
      loopSafetyEnabled: false,
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async ({ getAuth }) => ({
      apiKey: "",
      fetch: async (request, init) => {
        const info = await getAuth()
        calls.push({
          info,
          url: request instanceof URL ? request.href : String(request),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    }),
  })

  const options = await plugin.auth?.loader?.(
    async () => ({
      type: "oauth",
      refresh: "main-refresh",
      access: "main-access",
      expires: 0,
    }),
    { models: {} },
  )

  assert.equal(typeof options?.fetch, "function")

  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5" }),
  })
  await options?.fetch?.("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "o3" }),
  })

  assert.equal(calls[0]?.info?.refresh, "alt-refresh")
  assert.match(String(calls[0]?.url), /copilot-api\.example\.ghe\.com/)
  assert.equal(calls[1]?.info?.refresh, "main-refresh")
  assert.match(String(calls[1]?.url), /api\.githubcopilot\.com/)
})

test("plugin auth loader binds the first real request of a child session to a selected account from candidates", async () => {
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async () => ({
      main: 4,
      alt: 1,
    }),
  })

  await harness.sendRequest({
    sessionID: "child-1",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
})

test("plugin auth loader reuses the bound account for non-user-turn follow-up requests", async () => {
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 0, alt: 10 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
  })

  await harness.sendRequest({
    sessionID: "child-2",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "child-2",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "alt-refresh")
})

test("plugin auth loader reselects on a new user turn when current account load exceeds min by 3 or more", async () => {
  const loadsByCall = [
    { main: 4, alt: 1 },
    { main: 1, alt: 5 },
  ]
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ call }) => loadsByCall[call] ?? loadsByCall.at(-1),
  })

  await harness.sendRequest({
    sessionID: "child-3",
    initiator: "agent",
    model: "gpt-5",
  })
  await harness.sendRequest({
    sessionID: "child-3",
    initiator: "user",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 2)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
  assert.equal(harness.outgoing[1]?.auth?.refresh, "main-refresh")
})

test("plugin auth loader selection path can consume routing-state-derived loads", async () => {
  const now = 2_000_000
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ candidates }) => buildCandidateAccountLoads({
      snapshot: {
        accounts: {
          main: {
            sessions: {
              s1: now - 20_000,
              s2: now - 30_000,
              s3: now - 40_000,
            },
          },
          alt: {
            sessions: {
              s9: now - 10_000,
            },
          },
        },
        appliedSegments: [],
      },
      candidateAccountNames: candidates.map((item) => item.name),
      now,
    }),
  })

  await harness.sendRequest({
    sessionID: "child-routing-loads",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "alt-refresh")
})

test("plugin auth loader keeps candidate order as tie-breaker when loads are equal", async () => {
  const harness = createSessionBindingHarness({
    store: {
      activeAccountNames: ["main", "alt"],
    },
    loadCandidateAccountLoads: async () => ({
      main: 2,
      alt: 2,
    }),
  })

  await harness.sendRequest({
    sessionID: "child-tie",
    initiator: "agent",
    model: "gpt-5",
  })

  assert.equal(harness.outgoing.length, 1)
  assert.equal(harness.outgoing[0]?.auth?.refresh, "main-refresh")
})

test("plugin auth loader evicts stale session bindings when binding cache grows too large", async () => {
  let child0Hits = 0
  const harness = createSessionBindingHarness({
    loadCandidateAccountLoads: async ({ sessionID }) => {
      if (sessionID === "child-0") {
        child0Hits += 1
        if (child0Hits === 1) {
          return { main: 10, alt: 0 }
        }
        return { main: 0, alt: 10 }
      }
      return { main: 5, alt: 1 }
    },
  })

  for (let index = 0; index < 260; index += 1) {
    await harness.sendRequest({
      sessionID: `child-${index}`,
      initiator: "agent",
      model: "gpt-5",
    })
  }

  await harness.sendRequest({
    sessionID: "child-0",
    initiator: "agent",
    model: "gpt-5",
  })

  const firstCall = harness.outgoing[0]
  const lastCall = harness.outgoing.at(-1)
  assert.equal(firstCall?.auth?.refresh, "alt-refresh")
  assert.equal(lastCall?.auth?.refresh, "main-refresh")
})

test("configureModelAccountAssignments stores multiple selected accounts", async () => {
  const { configureModelAccountAssignments } = await import("../dist/plugin.js")

  const store = {
    active: "main",
    activeAccountNames: ["main"],
    accounts: {
      main: {
        name: "main",
        refresh: "main-refresh",
        access: "main-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      alt: {
        name: "alt",
        refresh: "alt-refresh",
        access: "alt-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      org: {
        name: "org",
        refresh: "org-refresh",
        access: "org-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
    },
  }

  const changed = await configureModelAccountAssignments(store, {
    selectModel: async () => "gpt-5",
    selectAccounts: async () => ["alt", "org"],
  })

  assert.equal(changed, true)
  assert.deepEqual(store.modelAccountAssignments?.["gpt-5"], ["alt", "org"])
})

test("default account group can include multiple accounts", async () => {
  const { configureDefaultAccountGroup } = await import("../dist/plugin.js")

  const store = {
    active: "main",
    activeAccountNames: ["main"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      "student-2": { name: "student-2", refresh: "s2-refresh", access: "s2-access", expires: 0 },
    },
  }

  const changed = await configureDefaultAccountGroup(store, {
    selectAccounts: async () => ["main", "student-2"],
  })

  assert.equal(changed, true)
  assert.deepEqual(store.activeAccountNames, ["main", "student-2"])
  assert.equal(store.active, "main")
})

test("configureModelAccountAssignments fallback hint uses default account group when available", async () => {
  const { configureModelAccountAssignments } = await import("../dist/plugin.js")

  let capturedModelOptions = []
  const store = {
    active: "solo",
    activeAccountNames: ["student-1", "student-2"],
    accounts: {
      solo: {
        name: "solo",
        refresh: "solo-refresh",
        access: "solo-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      "student-1": {
        name: "student-1",
        refresh: "s1-refresh",
        access: "s1-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
      "student-2": {
        name: "student-2",
        refresh: "s2-refresh",
        access: "s2-access",
        expires: 0,
        models: { available: ["gpt-5"], disabled: [] },
      },
    },
  }

  const changed = await configureModelAccountAssignments(store, {
    selectModel: async (options) => {
      capturedModelOptions = options
      return null
    },
  })

  assert.equal(changed, false)
  assert.match(capturedModelOptions[0]?.hint ?? "", /fallbacks to student-1, student-2/)
})

test("configureDefaultAccountGroup keeps active account unchanged when it is outside new default group", async () => {
  const { configureDefaultAccountGroup } = await import("../dist/plugin.js")

  const store = {
    active: "manual-current",
    activeAccountNames: ["manual-current"],
    accounts: {
      "manual-current": { name: "manual-current", refresh: "mc-refresh", access: "mc-access", expires: 0 },
      "student-1": { name: "student-1", refresh: "s1-refresh", access: "s1-access", expires: 0 },
      "student-2": { name: "student-2", refresh: "s2-refresh", access: "s2-access", expires: 0 },
    },
  }

  const changed = await configureDefaultAccountGroup(store, {
    selectAccounts: async () => ["student-1", "student-2"],
  })

  assert.equal(changed, true)
  assert.equal(store.active, "manual-current")
  assert.deepEqual(store.activeAccountNames, ["student-1", "student-2"])
})

test("clearAllAccounts also clears activeAccountNames", async () => {
  const { clearAllAccounts } = await import("../dist/plugin.js")

  const store = {
    active: "main",
    activeAccountNames: ["main", "alt"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
    },
    modelAccountAssignments: {
      "gpt-5": ["alt"],
    },
  }

  clearAllAccounts(store)

  assert.equal(store.active, undefined)
  assert.equal(store.activeAccountNames, undefined)
  assert.deepEqual(store.accounts, {})
  assert.equal(store.modelAccountAssignments, undefined)
})

test("removeAccountFromStore chooses deterministic active fallback", async () => {
  const { removeAccountFromStore } = await import("../dist/plugin.js")

  const preferGroupStore = {
    active: "main",
    activeAccountNames: ["alt"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
      beta: { name: "beta", refresh: "beta-refresh", access: "beta-access", expires: 0 },
    },
  }

  removeAccountFromStore(preferGroupStore, "main")
  assert.equal(preferGroupStore.active, "alt")

  const fallbackStore = {
    active: "main",
    activeAccountNames: ["missing"],
    accounts: {
      main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
      zeta: { name: "zeta", refresh: "zeta-refresh", access: "zeta-access", expires: 0 },
      alpha: { name: "alpha", refresh: "alpha-refresh", access: "alpha-access", expires: 0 },
    },
  }

  removeAccountFromStore(fallbackStore, "main")
  assert.equal(fallbackStore.active, "alpha")
})

test("plugin menu toggle path persists loopSafetyEnabled", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: false,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-loop-safety" },
    store,
    writeStore: async (next) => {
      writes.push(next.loopSafetyEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.loopSafetyEnabled, true)
  assert.deepEqual(writes, [true])
})

test("plugin menu toggle path persists networkRetryEnabled", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-network-retry" },
    store,
    writeStore: async (next) => {
      writes.push(next.networkRetryEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.networkRetryEnabled, true)
  assert.deepEqual(writes, [true])
})

test("plugin menu toggle path persists synthetic initiator state", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
    syntheticAgentInitiatorEnabled: false,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-synthetic-agent-initiator" },
    store,
    writeStore: async (next) => {
      writes.push(next.syntheticAgentInitiatorEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.syntheticAgentInitiatorEnabled, true)
  assert.deepEqual(writes, [true])
})

test("plugin menu toggle path persists loopSafetyProviderScope", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "copilot-only",
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-loop-safety-provider-scope" },
    store,
    writeStore: async (next) => {
      writes.push(next.loopSafetyProviderScope)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.loopSafetyProviderScope, "all-models")
  assert.deepEqual(writes, ["all-models"])
})

test("plugin menu toggle path toggles loopSafetyProviderScope back to copilot-only", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "all-models",
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-loop-safety-provider-scope" },
    store,
    writeStore: async (next) => {
      writes.push(next.loopSafetyProviderScope)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.loopSafetyProviderScope, "copilot-only")
  assert.deepEqual(writes, ["copilot-only"])
})

test("plugin menu toggle path persists experimental slash commands state", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: true,
    experimentalSlashCommandsEnabled: true,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-experimental-slash-commands" },
    store,
    writeStore: async (next) => {
      writes.push(next.experimentalSlashCommandsEnabled)
    },
  })

  assert.equal(handled, true)
  assert.equal(store.experimentalSlashCommandsEnabled, false)
  assert.deepEqual(writes, [false])
})

test("plugin menu toggle path forwards debug reason for loop safety writes", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: true,
    networkRetryEnabled: true,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-loop-safety" },
    store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
  })

  assert.equal(handled, true)
  assert.deepEqual(writes, [
    {
      reason: "toggle-loop-safety",
      source: "applyMenuAction",
      actionType: "toggle-loop-safety",
    },
  ])
})

test("plugin menu toggle path forwards debug reason for policy scope writes", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: true,
    loopSafetyProviderScope: "copilot-only",
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-loop-safety-provider-scope" },
    store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
  })

  assert.equal(handled, true)
  assert.deepEqual(writes, [
    {
      reason: "toggle-loop-safety-provider-scope",
      source: "applyMenuAction",
      actionType: "toggle-loop-safety-provider-scope",
    },
  ])
})

test("plugin menu toggle path forwards debug reason for experimental slash command writes", async () => {
  const writes = []
  const store = {
    accounts: {},
    loopSafetyEnabled: true,
    experimentalSlashCommandsEnabled: true,
  }

  const handled = await applyMenuAction({
    action: { type: "toggle-experimental-slash-commands" },
    store,
    writeStore: async (_next, meta) => {
      writes.push(meta)
    },
  })

  assert.equal(handled, true)
  assert.deepEqual(writes, [
    {
      reason: "toggle-experimental-slash-commands",
      source: "applyMenuAction",
      actionType: "toggle-experimental-slash-commands",
    },
  ])
})

test("persistAccountSwitch keeps active in sync while preserving activeAccountNames and updates lastUsed", async () => {
  const { persistAccountSwitch } = await import("../dist/plugin-actions.js")

  assert.equal(typeof persistAccountSwitch, "function")

  const at = 1_717_171_717_171
  const writes = []
  const store = {
    active: "old-account",
    activeAccountNames: ["old-account", "new-account"],
    lastAccountSwitchAt: 123,
    accounts: {
      "old-account": { name: "old-account", refresh: "r1", access: "a1", expires: 0, lastUsed: 10 },
      "new-account": { name: "new-account", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  await persistAccountSwitch({
    store,
    name: "new-account",
    at,
    writeStore: async (next) => {
      writes.push({
        active: next.active,
        activeAccountNames: next.activeAccountNames,
        lastUsed: next.accounts["new-account"].lastUsed,
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
    },
  })

  assert.equal(store.active, "new-account")
  assert.deepEqual(store.activeAccountNames, ["old-account", "new-account"])
  assert.equal(store.accounts["new-account"].lastUsed, at)
  assert.equal(store.lastAccountSwitchAt, at)
  assert.deepEqual(writes, [
    {
      active: "new-account",
      activeAccountNames: ["old-account", "new-account"],
      lastUsed: at,
      lastAccountSwitchAt: at,
    },
  ])

  const storeWithoutDefaultGroup = {
    active: "old-account",
    accounts: {
      "old-account": { name: "old-account", refresh: "r1", access: "a1", expires: 0, lastUsed: 10 },
      "new-account": { name: "new-account", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  await persistAccountSwitch({
    store: storeWithoutDefaultGroup,
    name: "new-account",
    at,
    writeStore: async () => {},
  })

  assert.deepEqual(storeWithoutDefaultGroup.activeAccountNames, ["new-account"])
})

test("activateAddedAccount records switch metadata only after switch succeeds", async () => {
  const { activateAddedAccount } = await import("../dist/plugin.js")

  assert.equal(typeof activateAddedAccount, "function")

  const writes = []
  const metas = []
  const store = {
    active: "new-account",
    accounts: {
      "new-account": { name: "new-account", refresh: "r", access: "a", expires: 0 },
    },
  }

  await activateAddedAccount({
    store,
    name: "new-account",
    switchAccount: async () => {},
    writeStore: async (next, meta) => {
      writes.push({
        active: next.active,
        lastUsed: next.accounts["new-account"].lastUsed,
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
      metas.push(meta)
    },
    now: () => 1_717_171_717_171,
  })

  assert.equal(store.active, "new-account")
  assert.equal(store.accounts["new-account"].lastUsed, 1_717_171_717_171)
  assert.equal(store.lastAccountSwitchAt, 1_717_171_717_171)
  assert.deepEqual(writes, [
    {
      active: "new-account",
      lastUsed: undefined,
      lastAccountSwitchAt: undefined,
    },
    {
      active: "new-account",
      lastUsed: 1_717_171_717_171,
      lastAccountSwitchAt: 1_717_171_717_171,
    },
  ])
  assert.deepEqual(metas, [
    {
      reason: "activate-added-account",
      source: "activateAddedAccount",
      actionType: "add",
    },
    {
      reason: "persist-account-switch",
      source: "persistAccountSwitch",
      actionType: "switch",
    },
  ])
})

test("plugin auth loader default clearAccountSwitchContext reloads and persists matching switch timestamp", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const staleStore = {
    active: "stale-account",
    lastAccountSwitchAt: 1_717_171_717_171,
    accounts: {
      "stale-account": { name: "stale-account", refresh: "r1", access: "a1", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  const freshStore = {
    active: "fresh-account",
    lastAccountSwitchAt: 1_717_171_717_171,
    accounts: {
      "fresh-account": { name: "fresh-account", refresh: "r2", access: "a2", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  const writes = []
  let loads = 0
  let clearAccountSwitchContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => {
      loads += 1
      return loads === 1 ? staleStore : freshStore
    },
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      clearAccountSwitchContext = ctx?.clearAccountSwitchContext
      return fetch
    },
    writeStore: async (next) => {
      writes.push({
        active: next.active,
        accountNames: Object.keys(next.accounts),
        lastAccountSwitchAt: next.lastAccountSwitchAt,
      })
    },
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof clearAccountSwitchContext, "function")
  await clearAccountSwitchContext()

  assert.equal(loads, 2)
  assert.equal(staleStore.lastAccountSwitchAt, 1_717_171_717_171)
  assert.equal(freshStore.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [
    {
      active: "fresh-account",
      accountNames: ["fresh-account"],
      lastAccountSwitchAt: undefined,
    },
  ])
})

test("plugin auth loader default clearAccountSwitchContext logs minimal diagnostics on persist failure", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const warns = []
  let clearAccountSwitchContext
  const originalWarn = console.warn

  console.warn = (...args) => {
    warns.push(args)
  }

  try {
    const plugin = buildPluginHooks({
      auth: {
        provider: "github-copilot",
        methods: [],
      },
      loadStore: async () => ({
        active: "account",
        lastAccountSwitchAt: 1_717_171_717_171,
        accounts: {
          account: { name: "account", refresh: "r", access: "a", expires: 0 },
        },
        loopSafetyEnabled: false,
        networkRetryEnabled: true,
      }),
      loadOfficialConfig: async () => ({
        baseURL: "https://api.githubcopilot.com",
        apiKey: "",
        fetch: officialFetch,
      }),
      createRetryFetch: (fetch, ctx) => {
        clearAccountSwitchContext = ctx?.clearAccountSwitchContext
        return fetch
      },
      writeStore: async () => {
        throw new Error("persist failed")
      },
    })

    await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
      models: {},
    })

    assert.equal(typeof clearAccountSwitchContext, "function")
    await clearAccountSwitchContext()
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warns.length, 1)
  assert.match(String(warns[0][0]), /plugin-hooks/i)
  assert.match(String(warns[0][0]), /clear account-switch context/i)
})

test("plugin auth loader notifier clears ttl-expired persisted switch context without changing wording", async () => {
  const officialFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  const toastCalls = []
  const writes = []
  const now = 1_717_171_900_000
  const expiredSwitchAt = now - ACCOUNT_SWITCH_TTL_MS - 1
  const store = {
    active: "account",
    lastAccountSwitchAt: expiredSwitchAt,
    accounts: {
      account: { name: "account", refresh: "r", access: "a", expires: 0 },
    },
    loopSafetyEnabled: false,
    networkRetryEnabled: true,
  }
  let retryContext
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => store,
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: officialFetch,
    }),
    createRetryFetch: (fetch, ctx) => {
      retryContext = ctx
      return fetch
    },
    client: {
      tui: {
        showToast: async (options) => {
          toastCalls.push(options)
          return { data: true }
        },
      },
    },
    writeStore: async (next) => {
      writes.push(next.lastAccountSwitchAt)
    },
    now: () => now,
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })

  assert.equal(typeof retryContext?.notifier?.progress, "function")
  await retryContext.notifier.progress({ remaining: 1 })

  assert.match(toastCalls[0].body.message, /可能因账号切换遗留的非法输入 ID/)
  assert.equal(store.lastAccountSwitchAt, undefined)
  assert.deepEqual(writes, [undefined])
})

test("plugin switch flow prints retry hint after account switch", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.match(pluginSource, /input\[\*\]\.id too long/)
  assert.match(pluginSource, /enable Copilot Network Retry from the menu/i)
})

test("plugin source does not force promptAccountEntry on empty store bootstrap", async () => {
  const pluginSource = await fs.readFile(new URL("../dist/plugin.js", import.meta.url), "utf8")

  assert.doesNotMatch(pluginSource, /if \(!Object\.entries\(store\.accounts\)\.length\)\s*\{\s*const \{ name, entry \} = await promptAccountEntry\(\[\]\)/)
})

test("plugin transform wiring appends for Copilot and skips non-Copilot", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
  })
  const transform = plugin["experimental.chat.system.transform"]
  const copilotOutput = { system: ["base prompt"] }
  const nonCopilotOutput = { system: ["base prompt"] }

  await transform?.(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    copilotOutput,
  )
  await transform?.(
    { sessionID: "s2", model: { providerID: "google" } },
    nonCopilotOutput,
  )

  assert.equal(copilotOutput.system.at(-1), LOOP_SAFETY_POLICY)
  assert.equal(copilotOutput.system.filter((item) => item === LOOP_SAFETY_POLICY).length, 1)
  assert.equal(nonCopilotOutput.system.includes(LOOP_SAFETY_POLICY), false)
})

function createTransformHarness(input = {}) {
  const lookupCalls = []
  const defaultClient = {
    session: {
      get: async (request) => {
        lookupCalls.push(request)
        if (typeof input.sessionGetResponse === "function") {
          return input.sessionGetResponse(request)
        }
        return input.sessionGetResponse
      },
    },
  }
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: input.loopSafetyEnabled ?? true,
    }),
    client: Object.hasOwn(input, "client") ? input.client : defaultClient,
    directory: input.directory ?? "/tmp/project",
  })

  return {
    lookupCalls,
    transform: plugin["experimental.chat.system.transform"],
    compacting: plugin["experimental.session.compacting"],
  }
}

test("plugin transform wiring skips derived child session via session lookup", async () => {
  const { transform, lookupCalls } = createTransformHarness({
    sessionGetResponse: {
      data: {
        parentID: "root-session",
      },
    },
  })
  const output = { system: ["base prompt"] }

  await transform?.(
    { sessionID: "child-session", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt"])
  assert.deepEqual(lookupCalls, [
    {
      path: {
        id: "child-session",
      },
      query: {
        directory: "/tmp/project",
      },
      throwOnError: true,
    },
  ])
})

test("plugin transform wiring keeps injecting for root session lookup results", async () => {
  const { transform } = createTransformHarness({
    sessionGetResponse: {
      data: {},
    },
  })
  const output = { system: ["base prompt"] }

  await transform?.(
    { sessionID: "root-session", model: { providerID: "github-copilot" } },
    output,
  )

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("plugin transform wiring fails open when lookup returns undefined payload shapes", async () => {
  for (const sessionGetResponse of [undefined, {}, { data: undefined }]) {
    const { transform } = createTransformHarness({ sessionGetResponse })
    const output = { system: ["base prompt"] }

    await transform?.(
      { sessionID: "root-session", model: { providerID: "github-copilot" } },
      output,
    )

    assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
  }
})

test("plugin transform wiring fails open when session lookup throws or is unavailable", async () => {
  const cases = [
    {
      client: {
        session: {
          get: async () => {
            throw new Error("boom")
          },
        },
      },
    },
    {
      client: undefined,
    },
    {
      client: {},
    },
    {
      client: {
        session: {},
      },
    },
  ]

  for (const testCase of cases) {
    const { transform, lookupCalls } = createTransformHarness(testCase)
    const output = { system: ["base prompt"] }

    await transform?.(
      { sessionID: "root-session", model: { providerID: "github-copilot" } },
      output,
    )

    assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
    if ("client" in testCase && testCase.client?.session?.get === undefined) {
      assert.deepEqual(lookupCalls, [])
    }
  }
})

test("plugin transform wiring fails open when buildPluginHooks omits client entirely", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
    directory: "/tmp/project",
  })
  const output = { system: ["base prompt"] }

  await assert.doesNotReject(async () => {
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "root-session", model: { providerID: "github-copilot" } },
      output,
    )
  })

  assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("plugin transform wiring only skips when parentID is a non-empty string", async () => {
  const cases = [
    { parentID: "", expected: ["base prompt", LOOP_SAFETY_POLICY] },
    { parentID: 0, expected: ["base prompt", LOOP_SAFETY_POLICY] },
    { parentID: false, expected: ["base prompt", LOOP_SAFETY_POLICY] },
    { parentID: null, expected: ["base prompt", LOOP_SAFETY_POLICY] },
    { parentID: "root-session", expected: ["base prompt"] },
  ]

  for (const testCase of cases) {
    const { transform } = createTransformHarness({
      sessionGetResponse: {
        data: {
          parentID: testCase.parentID,
        },
      },
    })
    const output = { system: ["base prompt"] }

    await transform?.(
      { sessionID: "candidate-session", model: { providerID: "github-copilot" } },
      output,
    )

    assert.deepEqual(output.system, testCase.expected)
  }
})

test("plugin transform wiring does not lookup when sessionID is missing and fails open", async () => {
  const { transform, lookupCalls } = createTransformHarness({
    sessionGetResponse: async () => {
      throw new Error("lookup should not run")
    },
  })
  const missingOutput = { system: ["base prompt"] }
  const emptyOutput = { system: ["base prompt"] }

  await transform?.(
    { model: { providerID: "github-copilot" } },
    missingOutput,
  )
  await transform?.(
    { sessionID: "", model: { providerID: "github-copilot" } },
    emptyOutput,
  )

  assert.deepEqual(missingOutput.system, ["base prompt", LOOP_SAFETY_POLICY])
  assert.deepEqual(emptyOutput.system, ["base prompt", LOOP_SAFETY_POLICY])
  assert.deepEqual(lookupCalls, [])
})

test("plugin transform wiring does not lookup for disabled non-Copilot or compaction bypass paths", async () => {
  const disabledHarness = createTransformHarness({
    loopSafetyEnabled: false,
    sessionGetResponse: async () => {
      throw new Error("lookup should not run when disabled")
    },
  })
  const nonCopilotHarness = createTransformHarness({
    sessionGetResponse: async () => {
      throw new Error("lookup should not run for non-Copilot")
    },
  })
  const bypassHarness = createTransformHarness({
    sessionGetResponse: async () => {
      throw new Error("lookup should not run for compaction bypass")
    },
  })
  const disabledOutput = { system: ["base prompt"] }
  const nonCopilotOutput = { system: ["base prompt"] }
  const bypassOutput = { system: ["base prompt"] }

  await disabledHarness.transform?.(
    { sessionID: "disabled-session", model: { providerID: "github-copilot" } },
    disabledOutput,
  )
  await nonCopilotHarness.transform?.(
    { sessionID: "google-session", model: { providerID: "google" } },
    nonCopilotOutput,
  )
  await bypassHarness.compacting?.(
    { sessionID: "compacting-session" },
    { context: [], prompt: undefined },
  )
  await bypassHarness.transform?.(
    { sessionID: "compacting-session", model: { providerID: "github-copilot" } },
    bypassOutput,
  )

  assert.deepEqual(disabledHarness.lookupCalls, [])
  assert.deepEqual(nonCopilotHarness.lookupCalls, [])
  assert.deepEqual(bypassHarness.lookupCalls, [])
  assert.deepEqual(disabledOutput.system, ["base prompt"])
  assert.deepEqual(nonCopilotOutput.system, ["base prompt"])
  assert.deepEqual(bypassOutput.system, ["base prompt"])
})

test("plugin transform skips pending compaction session once", async () => {
  const plugin = buildPluginHooks({
    auth: {
      provider: "github-copilot",
      methods: [],
    },
    loadStore: async () => ({
      accounts: {},
      loopSafetyEnabled: true,
    }),
  })
  const compacting = plugin["experimental.session.compacting"]
  const transform = plugin["experimental.chat.system.transform"]
  const skipped = { system: ["base prompt"] }
  const normal = { system: ["base prompt"] }

  await compacting?.(
    { sessionID: "s1" },
    { context: [], prompt: undefined },
  )
  await transform?.(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    skipped,
  )
  await transform?.(
    { sessionID: "s1", model: { providerID: "github-copilot" } },
    normal,
  )

  assert.deepEqual(skipped.system, ["base prompt"])
  assert.deepEqual(normal.system, ["base prompt", LOOP_SAFETY_POLICY])
})

test("package root only exposes plugin entry and internal subpath exposes helpers", async () => {
  const root = await import("../dist/index.js")
  const internal = await import("../dist/internal.js")

  assert.equal(typeof root.CopilotAccountSwitcher, "function")
  assert.equal("buildPluginHooks" in root, false)
  assert.equal("loadOfficialCopilotConfig" in root, false)
  assert.equal(typeof internal.buildPluginHooks, "function")
  assert.equal(typeof internal.loadOfficialCopilotConfig, "function")
})
