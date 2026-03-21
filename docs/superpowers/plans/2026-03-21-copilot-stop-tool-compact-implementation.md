# Copilot Stop-Tool / Compact 与 Status 省略号修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为插件新增 `/copilot-stop-tool`、`/copilot-compact`，并把 `/copilot-status` 的中间省略号从 `...` 改成单列宽 `…`。

**Architecture:** 新增一个独立的 session-control command helper 文件，负责后台调度 `session.summarize(auto=true)` 与 `session.abort + synthetic continue` 两条真实会话控制链路；`src/plugin-hooks.ts` 只负责命令注册与委托，`src/status-command.ts` 单独修正 ellipsis 宽度计算。

**Tech Stack:** TypeScript, @opencode-ai/plugin hooks, @opencode-ai/sdk session APIs, Node test runner

---

## 文件结构与职责映射

### 新增

- `src/session-control-command.ts`
  - 封装 `/copilot-compact` 与 `/copilot-stop-tool` 的后台调度逻辑
  - 统一做 session message 解析、模型上下文解析、toast 与 continue synthetic prompt

- `test/session-control-command.test.js`
  - 聚焦测试 compact / stop-tool helper，不把复杂场景全塞进 `test/plugin.test.js`

### 修改

- `src/plugin-hooks.ts`
  - 注册 `/copilot-stop-tool` 与 `/copilot-compact`
  - 增加两个 handler 注入点
  - 在 `command.execute.before` 中后台触发 helper 并抛出 handled error

- `src/status-command.ts`
  - 将中间省略号改为 `…`
  - 调整 cell 宽度分配算法

- `src/ui/menu.ts`
  - 更新 experimental slash command hint，纳入两个新命令

- `test/plugin.test.js`
  - 验证两个新 slash command 注入与委托

- `test/status-command.test.js`
  - 更新 ellipsis 断言，从 `...` 改成 `…`

- `test/menu.test.js`
  - 更新 hint 断言，包含两个新命令

---

### Task 1: 先锁定 helper 与省略号的新行为（TDD）

**Files:**
- Create: `test/session-control-command.test.js`
- Modify: `test/status-command.test.js`
- Modify: `test/plugin.test.js`
- Modify: `test/menu.test.js`

- [ ] **Step 1: 为 `/copilot-compact` 写失败测试**

```js
test("compact command schedules real summarize with auto=true", async () => {})
test("compact command falls back to latest assistant model when latest user model is missing", async () => {})
test("compact command warns when no model context can be resolved", async () => {})
```

- [ ] **Step 2: 为 `/copilot-stop-tool` 写失败测试**

```js
test("stop-tool warns when there is no running tool", async () => {})
test("stop-tool refuses multiple running tools", async () => {})
test("stop-tool aborts current tool phase and queues synthetic continue prompt", async () => {})
test("stop-tool shows recovery failure toast when promptAsync fails", async () => {})
```

- [ ] **Step 3: 更新 plugin/menu/status 相关失败测试**

```js
test("status slash command registration also includes stop-tool and compact", async () => {})
test("experimental slash commands hint mentions stop-tool and compact", () => {})
test("status command uses single-character ellipsis in 16-char cell", async () => {})
```

- [ ] **Step 4: 运行聚焦测试确认红灯**

Run:

```bash
node --test test/session-control-command.test.js test/plugin.test.js test/status-command.test.js test/menu.test.js
```

Expected: FAIL，且失败点落在“helper 不存在 / 新命令未注册 / ellipsis 仍为 ...”等目标差异上。

---

### Task 2: 实现 `session-control-command` helper（最小绿灯实现）

**Files:**
- Create: `src/session-control-command.ts`
- Test: `test/session-control-command.test.js`

- [ ] **Step 1: 实现 compact helper 的最小路径**

```ts
// 读取 session.messages
// 解析最近可用 model
// 后台调用 client.session.summarize({ auto: true })
// 失败时 toast
```

- [ ] **Step 2: 实现 stop-tool helper 的最小路径**

```ts
// 定位唯一 running/pending tool
// abort session
// 轮询 target assistant message 直到完成
// 发送 synthetic continue promptAsync
```

- [ ] **Step 3: 复跑 helper 单测确认绿灯**

Run:

```bash
node --test test/session-control-command.test.js
```

Expected: PASS

---

### Task 3: 接到 plugin hooks 与菜单 hint（TDD -> 绿灯）

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/ui/menu.ts`
- Modify: `test/plugin.test.js`
- Modify: `test/menu.test.js`

- [ ] **Step 1: 在 `buildPluginHooks()` 中新增两个 handler 注入点**

```ts
handleCompactCommandImpl?: ...
handleStopToolCommandImpl?: ...
```

- [ ] **Step 2: 注册两个 slash command 并在 `command.execute.before` 中委托**

```ts
config.command["copilot-stop-tool"] = { ... }
config.command["copilot-compact"] = { ... }
```

- [ ] **Step 3: 更新 experimental slash command hint 文案**

确保中英菜单 hint 都包含：

- `/copilot-stop-tool`
- `/copilot-compact`

- [ ] **Step 4: 复跑 plugin/menu 测试确认绿灯**

Run:

```bash
node --test test/plugin.test.js test/menu.test.js
```

Expected: PASS

---

### Task 4: 修复 `/copilot-status` 的单列省略号（TDD -> 绿灯）

**Files:**
- Modify: `src/status-command.ts`
- Modify: `test/status-command.test.js`

- [ ] **Step 1: 将 ellipsis 常量改成 `…` 并重算可见宽度**

```ts
const ELLIPSIS = "…"
const visibleWidth = maxWidth - ELLIPSIS.length
```

- [ ] **Step 2: 保持 cell 总宽与 row 总宽断言不变**

重点保证：

- `ACCOUNT_CELL_WIDTH === 16`
- row length 仍为 50
- 长用户名 cell 里出现 `…` 而不是 `...`

- [ ] **Step 3: 复跑 status 测试确认绿灯**

Run:

```bash
node --test test/status-command.test.js
```

Expected: PASS

---

### Task 5: 全量验证与整理提交

**Files:**
- Modify: `docs/superpowers/specs/2026-03-21-copilot-stop-tool-compact-design.md`
- Modify: `docs/superpowers/plans/2026-03-21-copilot-stop-tool-compact-implementation.md`
- Verify all touched source/tests

- [ ] **Step 1: 跑本轮相关测试**

Run:

```bash
node --test test/session-control-command.test.js test/plugin.test.js test/status-command.test.js test/menu.test.js
```

Expected: PASS

- [ ] **Step 2: 跑全量测试**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 3: 自检改动边界**

确认：

- `/copilot-compact` 使用真实 `session.summarize(auto=true)`
- `/copilot-stop-tool` 只在单个 running tool 时生效
- 没有偷偷扩大到多并发 tool 停止
- `/copilot-status` 仅修 ellipsis，不改分组布局

- [ ] **Step 4: 最终提交**

```bash
git add src/session-control-command.ts src/plugin-hooks.ts src/status-command.ts src/ui/menu.ts test/session-control-command.test.js test/plugin.test.js test/status-command.test.js test/menu.test.js docs/superpowers/specs/2026-03-21-copilot-stop-tool-compact-design.md docs/superpowers/plans/2026-03-21-copilot-stop-tool-compact-implementation.md
git commit -m "feat(plugin): 新增 stop-tool 与 compact 控制命令"
```
