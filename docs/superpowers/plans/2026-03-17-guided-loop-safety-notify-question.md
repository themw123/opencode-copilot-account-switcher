# Guided Loop Safety Notify/Question Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Copilot 会话新增模型可用的 `notify` 工具，并将 Guided Loop Safety 从单一 `question` 报告策略重构为 `notify`/`question` 双通道分工。

**Architecture:** 继续保留 `src/loop-safety-plugin.ts` 的固定 policy 注入路径，只重写 `LOOP_SAFETY_POLICY` 文本；同时在 `src/plugin-hooks.ts` 通过 `@opencode-ai/plugin` 的 `tool(...)` 能力注册一个通用 `notify` 工具，并复用/抽取现有 `client.tui.showToast` 发送能力。测试分成三层：tool wiring、toast 适配/fail-open、policy 文本与注入回归。

**Tech Stack:** TypeScript, Node.js, `@opencode-ai/plugin`, Node built-in test runner (`node:test`), `client.tui.showToast`

---

## File Map

- Modify: `src/plugin-hooks.ts`
  - 注册 `tool.notify`
  - 将运行时 `client` / `directory` 接入到 notify 工具执行上下文
  - 保持现有 auth、chat headers、loop safety、retry wiring 不回归
- Modify: `src/loop-safety-plugin.ts`
  - 重写固定 `LOOP_SAFETY_POLICY` 为 notify/question 双通道文本
  - 不改变 Copilot-only、幂等追加、derived-session skip、compaction bypass 等逻辑
- Create: `src/notify-tool.ts`
  - 定义通用 notify 工具
  - 锁定 v1 schema：`message` + 可选 `variant`
  - 负责 fail-open 执行与对 `client.tui.showToast` 的最小映射
- Modify or Create: `src/copilot-retry-notifier.ts`
  - 如有必要，抽取底层 toast 发送 helper，供 retry notifier 与 notify 工具共用
  - 保持现有 retry 专用文案与清理逻辑职责不变
- Modify: `test/plugin.test.js`
  - 为 `tool.notify` 的注册、schema、调用 shape、fail-open 行为新增测试
  - 保留现有 plugin wiring 测试不回归
- Modify: `test/loop-safety-plugin.test.js`
  - 更新 `EXPECTED_POLICY`
  - 保留现有 policy 注入、幂等、derived-session skip、compaction bypass 测试
- Modify: `test/copilot-network-retry.test.js`
  - 若抽取了共用 toast helper，补充回归断言，确保 retry notifier 既有行为不变
- Reference: `docs/superpowers/specs/2026-03-17-guided-loop-safety-notify-question-design.md`
  - 作为本计划唯一规格依据

## Chunk 1: Notify Tool Wiring And Toast Delivery

### Task 1: 先为 `notify` 工具接线写失败测试

**Files:**
- Modify: `test/plugin.test.js`
- Reference: `node_modules/@opencode-ai/plugin/dist/tool.d.ts`
- Reference: `docs/superpowers/specs/2026-03-17-guided-loop-safety-notify-question-design.md`

- [ ] **Step 1: 给 plugin hooks 增加 `tool.notify` 暴露测试**

在 `test/plugin.test.js` 新增测试，断言 `buildPluginHooks(...)` 返回结果中包含 `tool.notify`，且描述与参数面符合 v1 设计：

```js
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
```

- [ ] **Step 2: 给 `variant` 默认回落写失败测试**

在 `test/plugin.test.js` 新增测试，调用 `notify` 时省略 `variant`，断言底层 toast 使用默认 `info`：

```js
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
```

- [ ] **Step 3: 给 `notify` 成功调用写失败测试**

在 `test/plugin.test.js` 新增测试，直接调用 `plugin.tool.notify.execute(...)`，断言它会把输入映射到 `client.tui.showToast(...)`，并返回稳定字符串结果：

```js
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
```

- [ ] **Step 4: 给缺失 `showToast` 的 fail-open 行为写失败测试**

在 `test/plugin.test.js` 新增测试，断言缺失 `client.tui.showToast` 时仍返回成功样式结果，不抛错：

```js
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
```

- [ ] **Step 5: 给 `showToast` 抛错后的 warning + fail-open 写失败测试**

在 `test/plugin.test.js` 新增测试，临时 stub `console.warn`，断言底层抛错时：

1. `notify` 调用不 reject
2. 会记录一次轻量 warning

推荐断言结构：

```js
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
```

- [ ] **Step 6: 运行聚焦测试，确认当前实现变红**

Run:

```bash
npm run build && node --test test/plugin.test.js
```

Expected: FAIL，且失败原因聚焦在 `tool.notify` 尚未注册或行为与新测试不一致，而不是构建错误。

### Task 2: 实现通用 `notify` 工具与 toast 适配

**Files:**
- Create: `src/notify-tool.ts`
- Modify: `src/plugin-hooks.ts`
- Modify: `src/copilot-retry-notifier.ts`（如需要共用 helper）

- [ ] **Step 1: 新建 `src/notify-tool.ts` 并写最小实现**

在新文件中使用 `@opencode-ai/plugin` 的 `tool` helper 定义 notify 工具。v1 只暴露最小参数面：

```ts
import { tool } from "@opencode-ai/plugin"

export function createNotifyTool(input: {
  client?: {
    tui?: {
      showToast?: (options: {
        body: {
          message: string
          variant: "info" | "success" | "warning" | "error"
        }
        query?: undefined
      }) => Promise<unknown>
    }
  }
}) {
  return tool({
    description: "Send a non-blocking progress notification to the user.",
    args: {
      message: tool.schema.string().min(1).describe("Progress message to show without blocking"),
      variant: tool.schema.enum(["info", "success", "warning", "error"]).optional().describe("Toast variant"),
    },
    async execute(args) {
      try {
        await input.client?.tui?.showToast?.({
          body: {
            message: args.message,
            variant: args.variant ?? "info",
          },
        })
      } catch (error) {
        console.warn("[notify-tool] failed to show toast", error)
      }
      return "ok"
    },
  })
}
```

- [ ] **Step 2: 在 `src/plugin-hooks.ts` 注册 `tool.notify`**

把 `createNotifyTool(...)` 接到 `buildPluginHooks(...)` 的返回值里，保持现有 hooks 不变，只新增：

```ts
tool: {
  notify: createNotifyTool({
    client: input.client,
  }),
},
```

如果返回值已存在其他 `tool` 项，按对象合并方式接入；如果当前没有，则新增 `tool` 字段。

- [ ] **Step 3: 仅在必要时抽取共用 toast helper**

如果 `src/copilot-retry-notifier.ts` 与 `src/notify-tool.ts` 出现明显重复，可抽取一个最小 helper，例如：

```ts
export async function showToastSafe(client, body, source) {
  try {
    await client?.tui?.showToast?.({ body })
  } catch (error) {
    console.warn(`[${source}] failed to show toast`, error)
  }
}
```

仅在它能同时让两个调用点更清晰时才抽取；若抽取会扩大文件改动面，则允许先保留两处小范围重复。

- [ ] **Step 4: 运行聚焦测试，确认 `notify` 工具改绿**

Run:

```bash
npm run build && node --test test/plugin.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交 notify 工具接线改动**

```bash
git add src/plugin-hooks.ts src/notify-tool.ts src/copilot-retry-notifier.ts test/plugin.test.js
git commit -m "feat(loop-safety): 新增 notify 进度通知工具"
```

若最终没有修改 `src/copilot-retry-notifier.ts`，从 `git add` 中移除该文件。

## Chunk 2: Rework Guided Loop Safety Policy For Dual Channels

### Task 3: 先锁定新的双通道 policy 文本测试

**Files:**
- Modify: `test/loop-safety-plugin.test.js`
- Reference: `docs/superpowers/specs/2026-03-17-guided-loop-safety-notify-question-design.md`

- [ ] **Step 1: 将 `EXPECTED_POLICY` 改成 notify/question 双通道版本**

把 `test/loop-safety-plugin.test.js` 中的 `EXPECTED_POLICY` 更新为新 spec 文本，至少明确表达以下语义：

- 需要用户介入时必须走 `question`
- 不得把强交互内容下沉到 `notify` 或 direct assistant text
- 纯进度与阶段切换优先走 `notify`
- `notify` 不可用时纯进度静默继续，不自动升级为 `question`
- `question` 不可用时，只有强交互内容才允许考虑 direct assistant text 或既有回退
- 工具缺席不改变内容本身的交互等级
- 最终完成交接与等待态仍然属于 `question`
- 反思/复盘时先检查是否把 `notify` / `question` 用错

- [ ] **Step 2: 保持其他断言结构不变，先只改文本常量**

不要在这一小步顺手改 transform 逻辑测试的结构，先让失败聚焦到 policy 文本差异。

- [ ] **Step 3: 运行聚焦测试，确认源码先失败**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js
```

Expected: FAIL，且失败原因是 `LOOP_SAFETY_POLICY` 与新的 `EXPECTED_POLICY` 不一致。

### Task 4: 仅重写 `LOOP_SAFETY_POLICY` 文本，不改变注入逻辑

**Files:**
- Modify: `src/loop-safety-plugin.ts`

- [ ] **Step 1: 重写 `Strong-interaction contract` 段落**

先写强交互总规则，明确以下内容必须进入最终 policy：

- 需要用户介入的内容必须走 `question`
- 不得把这类内容下沉到 `notify` 或 direct assistant text
- `question` 是决策、阻塞澄清、等待态、最终交接的唯一合法首选通道

- [ ] **Step 2: 重写 `Notify progress contract` 段落**

再写纯进度规则，明确：

- 纯进度、阶段切换、后台继续执行等内容优先走 `notify`
- 这类内容不应被升级成 `question`
- `notify` 只承担告知，不承担索取用户决定

- [ ] **Step 3: 重写 `Silent fallback discipline` 段落**

明确双通道对称回退语义：

- `notify` 不可用时，纯进度静默继续，不自动升级为 `question`
- `question` 不可用时，只有强交互内容才允许考虑 direct assistant text 或既有回退
- 工具缺席不改变内容分级

- [ ] **Step 4: 重写 `Reflection and violation diagnosis` 段落**

明确错误复盘规则：

- 先检查是否把该走 `question` 的内容下沉了
- 或把该走 `notify` / 应静默的内容上浮成了 `question`
- 不允许把问题归因为“question 太严格”或“顺手汇报一下也没关系”

- [ ] **Step 5: 合并四段为完整固定 policy 字符串**

把前四步整理成单个固定 `LOOP_SAFETY_POLICY` 多行字符串，保持标题 `Guided Loop Safety Policy` 不变，并确认顺序与 spec 一致。

- [ ] **Step 6: 不改动现有注入与跳过逻辑**

确认以下行为只允许保留原样，不做语义变更：

- `isCopilotProvider()`
- `applyLoopSafetyPolicy()`
- `createLoopSafetySystemTransform()`
- derived-session skip
- compaction bypass

- [ ] **Step 7: 运行 policy 聚焦测试，确认改绿**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js
```

Expected: PASS。

- [ ] **Step 8: 提交 policy 重写改动**

```bash
git add src/loop-safety-plugin.ts test/loop-safety-plugin.test.js
git commit -m "feat(loop-safety): 重写 notify 与 question 双通道策略"
```

## Chunk 3: Full Regression Verification

### Task 5: 验证 notify 工具与既有 retry 通知行为不冲突

**Files:**
- Modify: `test/copilot-network-retry.test.js`（仅在共用 helper 或回归覆盖需要时）
- Reference: `src/copilot-retry-notifier.ts`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 判断本次是否修改了 `src/copilot-retry-notifier.ts`**

先确认本次实现是否实际修改了 `src/copilot-retry-notifier.ts`：

- 若修改了，继续执行 Step 2 和 Step 3
- 若未修改，跳过 Step 2，直接执行 Step 3 作为 smoke regression

- [ ] **Step 2: 若改动了 retry notifier，补一个回归测试并核对既有语义**

只有在 `src/copilot-retry-notifier.ts` 被改动时，才新增/更新断言，确保原有自动清理 toast 文案、clear context 行为和 fail-open 逻辑不变。

- [ ] **Step 3: 运行 retry 相关测试或 smoke regression**

Run:

```bash
npm run build && node --test test/copilot-network-retry.test.js
```

Expected: PASS。

如果没有修改 retry notifier，这一步仍执行同一命令，作为 smoke regression，确认新 `notify` 工具接线没有意外影响既有 retry 通知链路。

### Task 6: 执行完整回归验证

**Files:**
- Modify: none
- Test: `test/plugin.test.js`
- Test: `test/loop-safety-plugin.test.js`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 运行 plugin 与 loop safety 聚焦测试**

Run:

```bash
npm run build && node --test test/plugin.test.js test/loop-safety-plugin.test.js
```

Expected: PASS。

- [ ] **Step 2: 运行完整单测套件**

Run:

```bash
npm test
```

Expected: PASS。

- [ ] **Step 3: 运行类型检查与构建**

Run:

```bash
npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 4: 逐项核对关键 spec 回归点**

在测试全部通过后，逐项确认以下关键语义已被覆盖且结果符合 spec：

- `buildPluginHooks(...)` 暴露 `tool.notify`
- `notify` schema 仅包含 `message` + 可选 `variant`
- `notify` 缺席或失败时 fail-open，纯进度不自动升级为 `question`
- `question` 仍承载等待态与最终交接
- `LOOP_SAFETY_POLICY` 继续只在 Copilot + 开启状态下注入
- 幂等、derived-session skip、compaction bypass 相关测试未回归

- [ ] **Step 5: 人工核对范围控制**

确认实现代码只涉及与本 feature 直接相关的文件：

- `src/plugin-hooks.ts`
- `src/notify-tool.ts`
- `src/copilot-retry-notifier.ts`（如有必要）
- `src/loop-safety-plugin.ts`
- `test/plugin.test.js`
- `test/loop-safety-plugin.test.js`
- `test/copilot-network-retry.test.js`（如有必要）

并确认未顺手修改 README、菜单、账户切换逻辑或无关 upstream snapshot。

- [ ] **Step 6: 提交最终回归与收尾改动**

```bash
git add src/plugin-hooks.ts src/notify-tool.ts src/copilot-retry-notifier.ts src/loop-safety-plugin.ts test/plugin.test.js test/loop-safety-plugin.test.js test/copilot-network-retry.test.js
git commit -m "test(loop-safety): 补齐双通道 notify/question 回归覆盖"
```

根据实际改动删除未触碰的文件路径。

## Final Verification Checklist

- [ ] `npm run build && node --test test/plugin.test.js`
- [ ] `npm run build && node --test test/loop-safety-plugin.test.js`
- [ ] `npm run build && node --test test/plugin.test.js test/loop-safety-plugin.test.js`
- [ ] `npm run build && node --test test/copilot-network-retry.test.js`（若 retry 路径受影响）
- [ ] `npm test`
- [ ] `npm run typecheck && npm run build`
- [ ] `buildPluginHooks(...)` 暴露 `tool.notify`
- [ ] `notify` v1 schema 锁定为 `message + 可选 variant`
- [ ] `notify` 缺席或失败时纯进度 fail-open，不自动升级为 `question`
- [ ] `src/loop-safety-plugin.ts` 中只有 policy 文本语义发生双通道重构，注入判定逻辑不回归
- [ ] derived-session skip、compaction bypass、Copilot-only 注入、幂等行为保持原样

## Handoff Notes

- 这是“新工具接线 + 固定 prompt 文本重构”的组合特性，但仍应保持单一主题：notify/question 双通道分工。不要借机扩展到菜单、README 或新的设置开关。
- 如果实现时发现 `tool.notify.execute(...)` 的返回值风格需要和现有插件工具约定对齐，优先调整测试与工具文案，不要扩大参数面。
- 若 `src/copilot-retry-notifier.ts` 的共用抽取让职责变糊，宁可保留少量重复，也不要把 retry 场景和通用 notify 场景强行揉进一个大文件。
- 若执行中发现 `notify` 工具暴露方式与 `@opencode-ai/plugin@1.2.26` 实际 API 不符，应先修正计划对应步骤，再继续编码；不要悄悄偏离 spec。
