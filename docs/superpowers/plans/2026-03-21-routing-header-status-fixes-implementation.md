# Routing Header / Status Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复删除账号后的路由组残留、统一 finalized request 与真实发送的 header 语义，并移除 `/copilot-status` 的重复尾部摘要。

**Architecture:** 先用测试锁住三类回归：删除账号后映射立即清理、routing/toast/outbound header 统一基于 finalized request、status 网格保留但底部重复摘要消失。实现上分别收敛 `removeAccountFromStore(...)` / `rewriteModelAccountAssignments(...)` 的删除语义，统一 `fetchWithModelAccount(...)` 对 finalized request 的使用路径，并简化 `buildSuccessMessage(...)` 的尾部文案。

**Tech Stack:** TypeScript, Node test runner, GitHub Copilot plugin hooks, store/routing helpers

---

## 文件结构与职责映射

### 修改

- `src/plugin.ts`
  - 修正删除账号时的 store 清理顺序，保证账号删除当下路由组映射同步收敛

- `src/model-account-map.ts`
  - 收紧“删除映射项”的重写语义，避免 `undefined ?? 原名` 让已删账号残留在 `modelAccountAssignments`

- `src/plugin-hooks.ts`
  - 统一 finalized request 与真实发送链路
  - 让 classification、toast、outbound request 使用同一份 header 视图

- `src/status-command.ts`
  - 删除底部重复的“活跃组 / 路由组账号列表”摘要

- `test/plugin.test.js`
  - 覆盖删除账号后的即时映射清理
  - 覆盖 finalized request 与真实发送 header 一致性

- `test/status-command.test.js`
  - 覆盖 status 网格仍在，但尾部重复摘要消失

---

### Task 1: 先锁定三类回归的红灯测试

**Files:**
- Modify: `test/plugin.test.js`
- Modify: `test/status-command.test.js`

- [ ] **Step 1: 为“删除账号后路由组映射立即清理”写失败测试**

```js
test("removeAccountFromStore immediately removes deleted account from modelAccountAssignments", async () => {})
```

- [ ] **Step 2: 为“selection / toast / outbound header 使用同一份 finalized request”写失败测试**

```js
test("plugin auth loader sends the finalized request headers it used for classification", async () => {})
test("user-reselect toast and outbound x-initiator stay aligned for routed user turns", async () => {})
```

- [ ] **Step 3: 为“/copilot-status 去掉重复尾部摘要”写失败测试**

```js
test("status success output no longer repeats active-group and routed-account footer lines", async () => {})
```

- [ ] **Step 4: 跑聚焦测试确认红灯**

Run:

```bash
node --test test/plugin.test.js test/status-command.test.js
```

Expected: FAIL，且失败点落在删除后映射残留、classification/outbound header 分叉、status 尾部仍重复等目标差异上。

---

### Task 2: 修删除账号后的即时映射清理

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/model-account-map.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 收紧映射重写语义，区分“重命名为空值”与“保持原名”**

```ts
const hasRename = Object.prototype.hasOwnProperty.call(rename, originalName)
const mappedName = hasRename ? rename[originalName] : originalName
if (typeof mappedName !== "string" || mappedName.length === 0) continue
```

- [ ] **Step 2: 调整删除账号时的清理顺序或调用方式**

```ts
delete store.accounts[name]
rewriteModelAccountAssignments(store, { [name]: undefined })
```

- [ ] **Step 3: 跑相关测试确认转绿**

Run:

```bash
node --test test/plugin.test.js --test-name-pattern "removeAccountFromStore"
```

Expected: PASS

---

### Task 3: 统一 finalized request 与真实发送链路

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 让真实发送从 finalized request/init 出发，而不是回到原始 request/init**

```ts
let nextRequest = selectionRequest
let nextInit = selectionInit
```

- [ ] **Step 2: 把后续 header 改写也统一建立在 finalized request 上**

```ts
const currentInitiator = getMergedRequestHeader(nextRequest, nextInit, "x-initiator")
if (shouldStripAgentInitiator && currentInitiator === "agent") {
  const rewritten = mergeAndRewriteRequestHeaders(nextRequest, nextInit, (headers) => {
    headers.delete("x-initiator")
  })
  nextRequest = rewritten.request
  nextInit = rewritten.init
}
```

- [ ] **Step 3: 保持现有 compaction / synthetic / child-session 测试不回退**

- [ ] **Step 4: 跑 routing/header 聚焦测试确认转绿**

Run:

```bash
node --test test/plugin.test.js --test-name-pattern "finalized request|user-reselect|x-initiator|removeAccountFromStore"
```

Expected: PASS

---

### Task 4: 精简 `/copilot-status` 成功文案尾部

**Files:**
- Modify: `src/status-command.ts`
- Test: `test/status-command.test.js`

- [ ] **Step 1: 删除底部重复的活跃组/路由组摘要拼接**

```ts
return [
  refreshedLine,
  ...groupLines,
].join("\n")
```

- [ ] **Step 2: 更新 status 测试，确认网格还在但重复尾部没了**

- [ ] **Step 3: 跑 status 聚焦测试确认转绿**

Run:

```bash
node --test test/status-command.test.js
```

Expected: PASS

---

### Task 5: 全量验证与回归检查

**Files:**
- Verify all touched source/tests

- [ ] **Step 1: 跑本轮聚焦验证**

Run:

```bash
node --test test/plugin.test.js test/status-command.test.js
```

Expected: PASS

- [ ] **Step 2: 跑全量测试**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 3: 自检这三条结果是否同时成立**

确认：

- 删除账号后，路由组映射立即消失
- 用户消息的 toast / route reason / outbound header 重新一致
- `/copilot-status` 只保留分组配额，不再重复列账号摘要

- [ ] **Step 4: 向用户回报结果（不提交 git，除非用户另行要求）**

回报内容应包含：

- 受影响文件
- 聚焦测试与全量测试结果
- 如果发现“selection 与 send 分叉”不是根因，需明确停下来汇报而不是继续扩改
