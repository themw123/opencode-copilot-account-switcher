# Copilot Stop-Tool Transcript Annotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/copilot-stop-tool` 改成更诚实的近似版：先做会话级中断，再把被打断的工具结果写成“用户主动中止 / 结果可能不完整”的 transcript，最后才发 synthetic continue。

**Architecture:** 保留 `session.abort(sessionID)` 作为唯一可用的中断入口，但不再把它包装成“真单 tool stop”。`src/session-control-command.ts` 负责 synthetic 前置检查、目标 tool part 解析、等待 `completed/error`、`client.part.update(...)` transcript patch 与 synthetic continue；`src/plugin-hooks.ts` 只负责把 store 中的 `syntheticAgentInitiatorEnabled` 与 slash command 文案接到 helper。

**Tech Stack:** TypeScript, @opencode-ai/plugin hooks, @opencode-ai/sdk v2 session/part APIs, Node test runner

---

## 文件结构与职责映射

### 修改

- `src/session-control-command.ts`
  - 为 `/copilot-stop-tool` 增加 synthetic 实验开关前置检查
  - 从 session messages 中定位唯一 running/pending tool part
  - abort 后等待目标 tool part 进入 `completed` 或 `error`
  - 使用 `client.part.update(...)` 把用户主动中止语义写入 transcript
  - 仅在 patch 成功后发送 synthetic continue

- `src/plugin-hooks.ts`
  - 向 stop-tool helper 传入 `syntheticAgentInitiatorEnabled`
  - 更新 `/copilot-stop-tool` 的 template / description，避免继续暗示“真单 tool stop”

- `test/session-control-command.test.js`
  - 覆盖 synthetic 未开启、completed/error patch、patch 失败停止 continue、promptAsync 失败但 transcript 已 patch 等路径

- `test/plugin.test.js`
  - 覆盖 stop-tool 命令文案变得更诚实
  - 覆盖 plugin hook 把 synthetic 开关状态透传给 helper

### 不修改

- `src/ui/menu.ts`
  - 现有 synthetic 风险提示已经存在，本轮不再额外改菜单

- `src/status-command.ts`
  - 本轮 stop-tool transcript patch 方案不再触碰 status 逻辑

---

### Task 1: 先锁定新的 stop-tool 行为红灯（TDD）

**Files:**
- Modify: `test/session-control-command.test.js`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 为 synthetic 前置检查写失败测试**

```js
test("/copilot-stop-tool warns when synthetic agent initiator is disabled", async () => {})
test("/copilot-stop-tool does not abort or continue when synthetic agent initiator is disabled", async () => {})
test("/copilot-stop-tool warns when there is no running/pending tool", async () => {})
test("/copilot-stop-tool warns when multiple running/pending tools exist", async () => {})
```

- [ ] **Step 2: 为 transcript patch 路径写失败测试**

```js
test("/copilot-stop-tool patches completed tool output with interrupted-by-user semantics", async () => {})
test("/copilot-stop-tool patches error tool state with interrupted-by-user semantics", async () => {})
test("/copilot-stop-tool reports abort failure and stops recovery", async () => {})
test("/copilot-stop-tool does not continue when tool part never settles", async () => {})
test("/copilot-stop-tool does not continue when part.update fails", async () => {})
test("/copilot-stop-tool keeps patched transcript when promptAsync fails", async () => {})
```

- [ ] **Step 3: 为 plugin 接线与命令文案写失败测试**

```js
test("stop-tool hook passes syntheticAgentInitiatorEnabled into the helper", async () => {})
test("stop-tool command description no longer claims true single-tool stop", async () => {})
```

- [ ] **Step 4: 跑聚焦测试确认红灯**

Run:

```bash
node --test test/session-control-command.test.js test/plugin.test.js
```

Expected: FAIL，且失败点落在 synthetic 前置检查缺失、part.update 未发生、patch 失败后仍继续、命令文案仍不诚实等目标差异上。

---

### Task 2: 实现 stop-tool 的 transcript patch 主路径（最小绿灯）

**Files:**
- Modify: `src/session-control-command.ts`
- Test: `test/session-control-command.test.js`

- [ ] **Step 1: 扩展 helper 输入与目标 tool part 类型**

```ts
type SessionMessage = {
  info?: { id?: unknown; role?: unknown }
  parts?: Array<{ id?: unknown; type?: unknown; callID?: unknown; state?: unknown }>
}

type StopToolInput = {
  sessionID: string
  runningTools?: unknown
  syntheticAgentInitiatorEnabled?: boolean
}
```

- [ ] **Step 2: 先实现 synthetic 前置检查**

```ts
if (input.syntheticAgentInitiatorEnabled !== true) {
  await showToast({
    message: "Enable 'Send synthetic messages as agent' first, or stop-tool recovery will add one billed synthetic turn.",
    variant: "warning",
  })
  throw new SessionControlCommandHandledError()
}
```

- [ ] **Step 3: 先实现“唯一 running/pending part 识别”最小路径**

```ts
// 从 runningTools + session messages 中收窄到唯一 running/pending callID
// 0 个 warning
// >1 个 warning
```

- [ ] **Step 4: 再实现“等待 tool part 稳定”最小路径**

```ts
// abort 后轮询 messages
// 直到目标 tool part.state.status === "completed" || "error"
// 超时则 error toast 并停止
```

- [ ] **Step 5: 实现 completed/error 两条 part.update patch 路径**

```ts
if (part.state.status === "completed") {
  part.state.output += "\n\n<user_interrupt>\nInterrupted by user. Output may be incomplete.\n</user_interrupt>"
}

if (part.state.status === "error") {
  part.state.error += "\n\nInterrupted by user before completion; treat this result as partial."
}

await client.part.update({ sessionID, messageID, partID, directory, part })
```

- [ ] **Step 6: 仅在 patch 成功后发送 synthetic continue**

```ts
await session.promptAsync({
  sessionID,
  synthetic: true,
  parts: [{
    type: "text",
    text: "The previous tool call was interrupted at the user's request. Treat its result as partial evidence. Continue with the remaining work, and do not resume that tool unless the user explicitly asks for it.",
  }],
})
```

- [ ] **Step 7: 跑 helper 测试确认绿灯**

Run:

```bash
node --test test/session-control-command.test.js
```

Expected: PASS

---

### Task 3: 接入 plugin hook 状态透传与命令文案（TDD -> 绿灯）

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 为 stop-tool helper 透传 synthetic 开关状态**

```ts
await handleStopToolCommandImpl({
  client: input.client ?? {},
  sessionID: hookInput.sessionID,
  runningTools: (hookInput as { runningTools?: unknown[] }).runningTools,
  syntheticAgentInitiatorEnabled: store?.syntheticAgentInitiatorEnabled === true,
})
```

- [ ] **Step 2: 更新 stop-tool 命令文案为更诚实的表述**

```ts
config.command["copilot-stop-tool"] = {
  template: "Interrupt the current session tool flow, annotate the interrupted tool result, and resume with a synthetic continue.",
  description: "Experimental interrupted-tool annotation helper for Copilot sessions",
}
```

- [ ] **Step 3: 跑 plugin 测试确认绿灯**

Run:

```bash
node --test test/plugin.test.js
```

Expected: PASS

---

### Task 4: 全量验证与边界自检

**Files:**
- Verify all touched source/tests

- [ ] **Step 1: 跑本轮相关测试**

Run:

```bash
node --test test/session-control-command.test.js test/plugin.test.js
```

Expected: PASS

- [ ] **Step 2: 跑全量测试**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 3: 自检 stop-tool 的诚实语义边界**

确认：

- `/copilot-stop-tool` 不再暗示“真单 tool stop”
- synthetic 未开启时不会触发 abort / patch / continue
- patch 失败或 tool part 不稳定时不会偷偷继续 promptAsync
- transcript 中确实留下“用户主动中止 / 结果可能不完整”的语义

- [ ] **Step 4: 记录交付状态（不提交 git，除非用户另行要求）**

完成后向用户报告：

- 改动文件列表
- 测试结果
- stop-tool 仍然是 session.abort 近似版，而不是真单 tool cancel
