# Codex Status Timeout And Workspace Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/codex-status` 在真实网络挂起时能够超时返回，并在 Codex 菜单中显示 `workspaceName`。

**Architecture:** 在 `src/codex-status-fetcher.ts` 给 Codex usage 请求增加显式超时和 `AbortSignal` 传递，复用现有 `timeout` 错误分支，不改变上层命令处理结构。菜单侧保持账号主标签稳定，向 `MenuAccountInfo` 和 UI hint 透传 `workspaceName`，把 workspace 作为 Codex 账号的首要辅助信息展示。

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin menu runtime

---

### Task 1: 为 Codex usage 请求补超时保护

**Files:**
- Modify: `src/codex-status-fetcher.ts`
- Test: `test/codex-status-fetcher.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/codex-status-fetcher.test.js` 增加一个挂起型 `fetchImpl`，只在收到 `AbortSignal` 时 reject，断言 `fetchCodexStatus()` 返回 `timeout`。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `node --test test/codex-status-fetcher.test.js`
Expected: 新增超时用例失败，因为当前实现不会中止挂起请求。

- [ ] **Step 3: 做最小实现**

在 `src/codex-status-fetcher.ts`：
- 给请求增加默认超时值；
- 用 `AbortController` 和 `signal` 包装 `fetch`；
- 在请求结束后清理 timeout；
- 保持现有 `timeout` 错误结构不变。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `node --test test/codex-status-fetcher.test.js`
Expected: 全部通过，新增超时用例变绿。

### Task 2: 在 Codex 菜单显示 workspaceName

**Files:**
- Modify: `src/menu-runtime.ts`
- Modify: `src/providers/codex-menu-adapter.ts`
- Modify: `src/ui/menu.ts`
- Test: `test/codex-menu-adapter.test.js`
- Test: `test/menu.test.js`

- [ ] **Step 1: 写失败测试**

增加两类断言：
- `test/codex-menu-adapter.test.js` 断言 `toMenuInfo()` 结果带出 `workspaceName`；
- `test/menu.test.js` 断言菜单 hint 会优先展示 workspace，再拼接 plan/lastUsed 等已有信息。

- [ ] **Step 2: 跑相关测试确认先失败**

Run: `node --test test/codex-menu-adapter.test.js test/menu.test.js`
Expected: 新增 workspace 展示断言失败。

- [ ] **Step 3: 做最小实现**

更新类型和映射：
- 给 `MenuAccountInfo` / `AccountInfo` 增加 `workspaceName?: string`；
- `codex-menu-adapter` 在 `toMenuInfo()` 中透传 `workspaceName`；
- `ui/menu.ts` 在账号 hint 中把 `workspaceName` 放在最前面，保持主 label 仍是账号名。

- [ ] **Step 4: 跑相关测试确认转绿**

Run: `node --test test/codex-menu-adapter.test.js test/menu.test.js`
Expected: 全部通过。

### Task 3: 回归验证

**Files:**
- Verify only

- [ ] **Step 1: 跑完整测试**

Run: `npm test`
Expected: 全量通过。

- [ ] **Step 2: 检查改动范围**

Run: `git diff -- src/codex-status-fetcher.ts src/menu-runtime.ts src/providers/codex-menu-adapter.ts src/ui/menu.ts test/codex-status-fetcher.test.js test/codex-menu-adapter.test.js test/menu.test.js`
Expected: 只包含本次超时与 workspace 菜单展示相关变更。
