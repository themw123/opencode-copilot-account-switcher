# regular 与 user-reselect 路由语义收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `regular` 只表示已有绑定的 root-session follow-up，引入 `unbound-fallback` 兜底 reason，并把该异常入口按 `user-reselect` 发送语义处理，同时提供单独 warning toast。

**Architecture:** 在 `src/plugin-hooks.ts` 中把“基础分类”和“发送语义”拆开：基础分类新增 `unbound-fallback`，发送时对该分支移除 outbound `x-initiator: agent` 并复用 `user-reselect` 式首次入口处理；日志继续记录原始 reason。`src/routing-state.ts` 扩展新 reason，`test/plugin.test.js` 先写回归测试再最小实现，保证现有 `subagent`、`compaction`、`rate-limit-switch` 语义不回退。

**Tech Stack:** TypeScript, Node.js built-in test runner, existing plugin hook architecture, existing routing decision log model.

---

### Task 1: 先用测试钉住 `unbound-fallback` 的基础分类与发送语义

**Files:**
- Modify: `test/plugin.test.js`
- Modify: `src/plugin-hooks.ts`

- [ ] **Step 1: 写失败测试，覆盖 root-session 无既有绑定的 `agent` 入口**

在 `test/plugin.test.js` 新增一个测试，断言：

- 请求带 `sessionID`
- 最终 `x-initiator` 为 `agent`
- `session.get()` 返回无 `parentID`
- `session.message()` 返回非 compaction
- 当前 session 之前没有绑定账号

预期：

- `decisions[0].reason === "unbound-fallback"`
- 实际发出去的请求头里没有 `x-initiator: agent`

- [ ] **Step 2: 只跑这条测试，确认它先失败**

Run: `node --test test/plugin.test.js --test-name-pattern "unbound-fallback"`

Expected: FAIL，且失败点是当前代码把它记成 `regular` 或仍然带着 `agent` 发出。

- [ ] **Step 3: 在 `src/plugin-hooks.ts` 给基础分类引入“既有绑定”判定**

最小实现要求：

- 在 `fetchWithModelAccount()` 中基于 `sessionAccountBindings` 计算 `hasExistingBinding`
- 调整分类逻辑，让 root-session + `agent` + 无绑定 + 非 compaction + 非 child session 先落成 `unbound-fallback`

- [ ] **Step 4: 在发送前对 `unbound-fallback` 去掉 outbound `x-initiator: agent`**

最小实现要求：

- 只改 outbound request
- 不要破坏 `subagent`、`compaction`、`user-reselect` 原有头语义

- [ ] **Step 5: 重跑单测，确认转绿**

Run: `node --test test/plugin.test.js --test-name-pattern "unbound-fallback"`

Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add test/plugin.test.js src/plugin-hooks.ts
git commit -m "test(routing): 覆盖 unbound fallback 基础分类"
```

### Task 2: 用测试钉住日志语义与发送语义分离

**Files:**
- Modify: `test/plugin.test.js`
- Modify: `src/plugin-hooks.ts`

- [ ] **Step 1: 写失败测试，直接断言“日志保留 `unbound-fallback`，发送等价 `user-reselect`”**

新增测试至少断言：

- `decisions.log` / `appendRouteDecisionEventImpl` 看到的 reason 是 `unbound-fallback`
- 实际发出的 outbound request 没有 `x-initiator: agent`
- 当前请求没有被当成 `regular` follow-up 处理
- 账号选择结果与真实 `user-reselect` 首次入口一致：也就是它会走允许首次入口选号/绑定的那条路径，而不是已有绑定 follow-up 的复用路径

- [ ] **Step 2: 只跑这条测试，确认失败原因正确**

Run: `node --test test/plugin.test.js --test-name-pattern "日志保留|sending behavior"`

Expected: FAIL，失败点落在当前实现还没把“日志语义”和“发送语义”拆干净。

- [ ] **Step 3: 最小调整 `src/plugin-hooks.ts`，显式分离记录用 reason 与发送用 behavior**

实现要求：

- 保留一个用于 `appendRouteDecisionEventImpl(...)` 的 `decisionReason`
- 单独推导一个发送侧布尔/枚举，让 `unbound-fallback` 复用 `user-reselect` 式首次入口处理
- 不允许靠“把 reason 直接改成 `user-reselect`”糊过去

- [ ] **Step 4: 重跑单测确认通过**

Run: `node --test test/plugin.test.js --test-name-pattern "日志保留|sending behavior"`

Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add test/plugin.test.js src/plugin-hooks.ts
git commit -m "fix(routing): 分离 unbound fallback 的日志与发送语义"
```

### Task 3: 收紧 toast 规则并给 `unbound-fallback` 单独 warning 类型

**Files:**
- Modify: `test/plugin.test.js`
- Modify: `src/plugin-hooks.ts`
- Optional Modify: `src/status-command.ts`

- [ ] **Step 1: 写失败测试，覆盖 `unbound-fallback` 的单独 toast 约束**

新增测试至少断言：

- `variant === "warning"`
- message 包含 `异常无绑定 agent 入口`
- message 包含 `已按用户回合处理`

- [ ] **Step 2: 写失败测试，覆盖 `regular` 不再弹普通消费 toast**

新增测试至少断言：

- 已有绑定的 root-session `agent` follow-up 仍记成 `regular`
- 这次请求不会再弹 `已使用 xxx（常规请求）`

- [ ] **Step 3: 单独运行 toast 相关测试，确认先失败**

Run: `node --test test/plugin.test.js --test-name-pattern "toast|regular"`

Expected: FAIL，失败点是当前 `regular` 仍然弹 toast，或 `unbound-fallback` 没有单独 warning toast。

- [ ] **Step 4: 在 `src/plugin-hooks.ts` 最小调整 toast 生成函数与展示条件**

实现要求：

- `buildConsumptionToast(...)` 支持 `unbound-fallback`
- `shouldShowConsumptionToast(...)` 改成：
  - `compaction` -> false
  - `regular` -> false
  - `subagent` -> 仅首次
  - `user-reselect` -> true
  - `unbound-fallback` -> true
  - `rate-limit-switch` -> 保持现有 warning 切换 toast

- [ ] **Step 5: 重跑 toast 测试，确认转绿**

Run: `node --test test/plugin.test.js --test-name-pattern "toast|regular"`

Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add test/plugin.test.js src/plugin-hooks.ts src/status-command.ts
git commit -m "fix(routing): 收紧 regular toast 并新增 fallback 警告"
```

### Task 4: 保证旧语义不回退

**Files:**
- Modify: `test/plugin.test.js`
- Modify: `src/routing-state.ts`
- Modify: `src/plugin-hooks.ts`

- [ ] **Step 1: 写/补测试，覆盖 `RouteDecisionEvent` 新 reason 类型**

新增或更新测试断言：

- `routing-state` 类型接受 `unbound-fallback`
- `appendRouteDecisionEventImpl(...)` 仍可写入 JSON 行日志

- [ ] **Step 2: 写/补测试，覆盖 `subagent`、`compaction`、`user-reselect`、`rate-limit-switch` 保持原语义**

至少覆盖：

- true child session 仍然是 `subagent`
- compaction 仍然不弹 toast
- `user-reselect` 仍允许原有负载重选
- 命中成功限流切换时最终 reason 仍覆写为 `rate-limit-switch`

- [ ] **Step 3: 单独运行这些回归测试，确认新增断言先失败**

Run: `node --test test/plugin.test.js --test-name-pattern "subagent|compaction|user-reselect|rate-limit-switch|route decision"`

Expected: FAIL，且失败点来自这轮新增/收紧的断言，而不是无关错误。

- [ ] **Step 4: 在 `src/routing-state.ts` 做最小类型扩展，在 `src/plugin-hooks.ts` 补齐兼容实现**

实现要求：

- `RouteDecisionEvent["reason"]` 增加 `unbound-fallback`
- 不破坏现有限流后覆写 `reason = "rate-limit-switch"` 的路径

- [ ] **Step 5: 重跑这组测试确认通过**

Run: `node --test test/plugin.test.js --test-name-pattern "subagent|compaction|user-reselect|rate-limit-switch|route decision"`

Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add test/plugin.test.js src/plugin-hooks.ts src/routing-state.ts
git commit -m "refactor(routing): 为 unbound fallback 扩展决策语义"
```

### Task 5: 运行完整验证并整理发布前状态

**Files:**
- Modify: `test/plugin.test.js`
- Modify: `src/plugin-hooks.ts`
- Modify: `src/routing-state.ts`
- Optional Modify: `src/status-command.ts`

- [ ] **Step 1: 运行针对性测试集**

Run: `node --test test/plugin.test.js`

Expected: PASS

- [ ] **Step 2: 运行完整项目测试**

Run: `npm test`

Expected: PASS

- [ ] **Step 3: 检查最终 diff，确认只包含本轮语义收敛改动**

Run: `git diff --stat origin/master...HEAD`

Expected: 只涉及 `src/plugin-hooks.ts`、`src/routing-state.ts`、`test/plugin.test.js`，以及必要的相关文件。

- [ ] **Step 4: 按实际改动补一个最终提交（如果前面是分步提交则可跳过）**

```bash
git status --short
```

Expected: 工作树干净，或只剩下你准备提交的最终收尾修改。

- [ ] **Step 5: 准备交付说明**

说明里必须覆盖：

- `regular` 现在只表示什么
- `unbound-fallback` 在什么条件下出现
- 为什么它会以 `warning` toast 提示
- 哪些旧路径已验证不回退
