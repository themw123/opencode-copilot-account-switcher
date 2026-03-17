# Copilot Inject / Wait 与交互通道修复 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 OpenCode core 的前提下，实现 `wait` 工具与 `/copilot-inject` 全工具注入能力，并修复 `notify/question` 边界与首启无账号流程。

**Architecture:** 以插件 hooks 为中心：`command.execute.before` 负责 `/copilot-inject` 置位，`tool.execute.after` 负责非 `question` 工具输出 marker 追加与 toast，`question` 路径负责清除内存注入态。`wait` 作为独立工具暴露，交互策略通过 `LOOP_SAFETY_POLICY` + `tool.definition` 双层约束收敛，账号首启流程在 `runMenu()` 内修正为菜单优先。

**Tech Stack:** TypeScript, @opencode-ai/plugin hooks, Node test runner, existing store/menu/plugin hooks architecture

---

## 文件结构与职责映射

### 需要新增

- `src/wait-tool.ts`
  - 定义 `wait` 工具
  - 处理 seconds 归一化（非法/缺失/<=0 => 30；<30 => 30）
  - 返回 started/waited/now 三段文本

### 需要修改

- `src/plugin-hooks.ts`
  - 注入 `/copilot-inject` 命令
  - 维护进程内 `injectArmed` 状态（实例全局内存态）
  - 在 `command.execute.before` 处理 inject 命令与初始 toast
  - 在 `tool.execute.after` 对非 `question` 工具追加 marker 并 toast
  - 在 `tool.execute.before/after` 处理 `question` 清除注入态（before 优先，after 兜底）
  - 注册 `wait` 工具
  - 添加 `tool.definition` 动态强化 `question/notify` 描述

- `src/loop-safety-plugin.ts`
  - 更新 `LOOP_SAFETY_POLICY` 固定文本，加入：
    - 禁止普通文本用户可见回复
    - `notify/question` 判定矩阵
    - 不确定场景默认 `question`
    - marker 检测后必须立即 `question`

- `src/plugin.ts`
  - 修复 `runMenu()` 空账号分支：移除强制 `promptAccountEntry([])` 直入逻辑
  - 保持菜单优先流程
  - 保证首个账号添加后走 `activateAddedAccount`

### 需要更新测试

- `test/wait-tool.test.js`
  - 新增 wait 工具行为测试

- `test/plugin.test.js`
  - 新增 `/copilot-inject` 命令注入与执行测试
  - 新增全工具改写 marker 与 toast 测试
  - 新增 `question` 清除注入态测试
  - 新增 `tool.definition` 描述强化测试
  - 保留并调整首启无账号流程断言

- `test/loop-safety-plugin.test.js`
  - 更新 `EXPECTED_POLICY` 为新固定文本

---

## Chunk 1: Wait 工具（TDD）

### Task 1: 新增 wait 工具与基础测试

**Files:**
- Create: `src/wait-tool.ts`
- Create: `test/wait-tool.test.js`
- Test: `test/wait-tool.test.js`

- [ ] **Step 1: 写失败测试（完整归一化与三段返回）**

```js
test("wait tool enforces minimum 30 seconds", async () => {
  // seconds=5 时 sleep 被调用 30000
})

test("wait tool normalizes invalid seconds to 30", async () => {
  // 缺失 / 非数值 / NaN / <=0 都按 30 秒
})

test("wait tool returns started waited now timeline", async () => {
  // 返回文本包含 started/waited/now
})
```

- [ ] **Step 2: 运行单测确认红灯**

Run: `node --test test/wait-tool.test.js`
Expected: FAIL（模块不存在或断言失败）

- [ ] **Step 3: 实现最小 wait 工具**

```ts
export function createWaitTool(...) {
  // normalize seconds
  // sleep
  // return timeline string
}
```

- [ ] **Step 4: 再跑单测确认绿灯**

Run: `node --test test/wait-tool.test.js`
Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add src/wait-tool.ts test/wait-tool.test.js
git commit -m "feat(wait): 新增wait工具并支持最小30秒等待"
```

---

## Chunk 2: `/copilot-inject` 注入状态机与 marker（TDD）

### Task 2: 命令注入与内存态置位

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试（命令注入 + 命令执行置位 + 初始 toast）**

```js
test("inject slash command is registered", async () => {
  // config.command["copilot-inject"] exists
})

test("copilot-inject arms in-memory state and shows initial toast", async () => {
  // execute command then assert toast message
})
```

- [ ] **Step 2: 跑聚焦测试确认红灯**

Run: `node --test test/plugin.test.js --test-name-pattern "copilot-inject|inject slash"`
Expected: FAIL

- [ ] **Step 3: 最小实现命令注入与置位逻辑**

```ts
let injectArmed = false
// config: add command
// command.execute.before: if copilot-inject => injectArmed=true + toast
```

- [ ] **Step 4: 复跑测试确认绿灯**

Run: `node --test test/plugin.test.js --test-name-pattern "copilot-inject|inject slash"`
Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(inject): 新增copilot-inject命令与内存注入态"
```

### Task 3: 全工具 after 改写 + marker 幂等 + 每次改写 toast

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试（非question改写、保留原输出、幂等不重复、每次改写toast）**

```js
test("inject appends marker to non-question tool output", async () => {})
test("inject preserves original output and appends only", async () => {})
test("inject avoids duplicate marker when already present", async () => {})
test("inject toasts on every actual append", async () => {})
test("inject repairs partial marker and appends full marker pair", async () => {})
test("inject normalizes empty or non-string output before append", async () => {})
test("inject stays fail-open when toast dispatch fails", async () => {})
```

- [ ] **Step 2: 跑聚焦测试确认红灯**

Run: `node --test test/plugin.test.js --test-name-pattern "marker|append|inject toasts"`
Expected: FAIL

- [ ] **Step 3: 最小实现 marker 协议**

```ts
const INJECT_BEGIN = "[COPILOT_INJECT_V1_BEGIN]"
const INJECT_BODY = "立即调用 question 工具并等待用户指示；在收到用户新指示前，不要继续执行后续任务。"
const INJECT_END = "[COPILOT_INJECT_V1_END]"
```

- [ ] **Step 4: 复跑测试确认绿灯**

Run: `node --test test/plugin.test.js --test-name-pattern "marker|append|inject toasts"`
Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(inject): 对非question工具追加marker注入并发送改写提示"
```

### Task 4: `question` 清除注入态（before+after 双保险）

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试（question触发清除；清除后不再改写）**

```js
test("question clears inject armed state", async () => {})
test("after question inject no longer appends markers", async () => {})
```

- [ ] **Step 2: 跑聚焦测试确认红灯**

Run: `node --test test/plugin.test.js --test-name-pattern "question clears inject|no longer appends"`
Expected: FAIL

- [ ] **Step 3: 最小实现清除逻辑**

```ts
// tool.execute.before: if tool===question => injectArmed=false
// tool.execute.after: if tool===question => injectArmed=false (idempotent fallback)
```

- [ ] **Step 4: 复跑测试确认绿灯**

Run: `node --test test/plugin.test.js --test-name-pattern "question clears inject|no longer appends"`
Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "fix(inject): 在question调用前后清除注入态避免遗留"
```

---

## Chunk 3: 交互策略与工具定义约束（TDD）

### Task 5: 更新 LOOP_SAFETY_POLICY 固定文本

**Files:**
- Modify: `src/loop-safety-plugin.ts`
- Modify: `test/loop-safety-plugin.test.js`

- [ ] **Step 1: 先改测试中的 EXPECTED_POLICY（红灯）**

```js
// 增加：禁止普通文本、notify/question判定矩阵、不确定默认question、marker触发question
```

- [ ] **Step 2: 跑测试确认红灯**

Run: `node --test test/loop-safety-plugin.test.js --test-name-pattern "LOOP_SAFETY_POLICY|exactly matches"`
Expected: FAIL

- [ ] **Step 3: 更新 `src/loop-safety-plugin.ts` 文本**

```ts
export const LOOP_SAFETY_POLICY = `...`
```

- [ ] **Step 4: 复跑测试确认绿灯**

Run: `node --test test/loop-safety-plugin.test.js`
Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add src/loop-safety-plugin.ts test/loop-safety-plugin.test.js
git commit -m "fix(policy): 收敛notify-question边界并禁止普通文本用户可见回复"
```

### Task 6: `tool.definition` 强化 `question/notify` 描述

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试（tool.definition 改写 question/notify）**

```js
test("tool.definition rewrites question description with wait/handoff semantics", async () => {})
test("tool.definition rewrites notify description as non-blocking progress channel", async () => {})
```

- [ ] **Step 2: 运行聚焦测试确认红灯**

Run: `node --test test/plugin.test.js --test-name-pattern "tool.definition|rewrites question|rewrites notify"`
Expected: FAIL

- [ ] **Step 3: 实现最小 hook**

```ts
"tool.definition": async (input, output) => {
  if (input.toolID === "question") output.description = "..."
  if (input.toolID === "notify") output.description = "..."
}
```

- [ ] **Step 4: 复跑测试确认绿灯**

Run: `node --test test/plugin.test.js --test-name-pattern "tool.definition|rewrites question|rewrites notify"`
Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "fix(hooks): 通过tool.definition强化question与notify语义边界"
```

---

## Chunk 4: 首启无账号流程修复（TDD）

### Task 7: 空账号进入菜单而非强制手输

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 先写失败测试（行为级：空账号菜单优先 + 首账号自动active）**

```js
test("empty store enters menu-first flow instead of forced manual prompt", async () => {})
test("first added account still auto-activates", async () => {})
```

- [ ] **Step 1.1: 保留源码级回归断言（可选）**

```js
test("plugin source does not force promptAccountEntry on empty store bootstrap", async () => {})
```

- [ ] **Step 2: 跑聚焦测试确认红灯**

Run: `node --test test/plugin.test.js --test-name-pattern "empty store|promptAccountEntry|force manual"`
Expected: FAIL

- [ ] **Step 3: 最小修改 `runMenu()` 空账号分支**

```ts
// 删除空账号时直接 promptAccountEntry([]) 的分支
// 保留菜单流程与 add 流程中的 activateAddedAccount
```

- [ ] **Step 4: 复跑测试确认绿灯**

Run: `node --test test/plugin.test.js --test-name-pattern "empty store|promptAccountEntry|force manual|activateAddedAccount"`
Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add src/plugin.ts test/plugin.test.js
git commit -m "fix(menu): 空账号首启进入菜单并保留首账号自动激活"
```

---

## Chunk 5: 全量回归与交付

### Task 8: 全量验证与文档同步

**Files:**
- Modify (if needed): `README.md`
- Verify: 全测试与类型检查

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 2: 跑类型检查**

Run: `npm run typecheck`
Expected: 无报错

- [ ] **Step 3: 校验 spec 与实现一致**

Run: 人工核对 `docs/superpowers/specs/2026-03-18-copilot-inject-wait-interaction-policy-design.md`
Expected: marker/命令/策略/首启流程全部一致

- [ ] **Step 3.1: 校验 `/copilot-inject` 无参数约束**

Run: `node --test test/plugin.test.js --test-name-pattern "copilot-inject|without args|inject slash"`
Expected: `/copilot-inject` 在计划内仅使用无参数语义

- [ ] **Step 4: 如需要，补充 README（仅增量说明）**

```md
- /copilot-inject
- wait tool behavior
- inject marker semantics
```

- [ ] **Step 5: 收尾提交**

```bash
git add .
git commit -m "feat(inject): 新增强制介入注入机制并完善交互通道约束"
```

---

## 计划执行守则

- 严格 TDD：每个行为先红灯，再最小实现，再绿灯。
- 小步提交：每个任务完成后提交，避免大杂烩。
- DRY/YAGNI：不提前实现未在 spec 约定的开关与扩展参数。
- 不修改 OpenCode core，仅改插件仓库。
