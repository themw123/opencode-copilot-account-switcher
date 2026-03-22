# Codex 无效账号移除与状态展示收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Codex 在 refresh token 返回 400 时自动移除无效账号并切换到下一个合适账号，同时把 `/codex-status` 收敛为只展示账号、workspace、5h、week 的紧凑输出。

**Architecture:** 先在 fetcher 层把 `Token refresh failed: 400` 归一成结构化 `invalid_account` 错误，并补齐 `workspaceName` 元信息。再新增共享的 Codex 无效账号恢复 helper，供 `/codex-status` 与 Codex 菜单刷新共用，统一处理删号、候选排序、auth 切换与提示文案。最后重写 `/codex-status` 文本输出，只保留用户关心的四个字段。

**Tech Stack:** TypeScript、Node 内置 `node:test`、现有 OpenCode plugin SDK、`src/codex-status-fetcher.ts`、`src/codex-status-command.ts`、`src/providers/codex-menu-adapter.ts`、`src/codex-store.ts`

---

## 文件结构

### 新建文件

- `src/codex-invalid-account.ts`
  - 共享 Codex 无效账号恢复 helper；负责删号、候选排序、更新 active、切换 `openai` auth。
- `test/codex-invalid-account.test.js`
  - 共享 helper 的纯逻辑与 auth 切换回归测试。

### 重点修改文件

- `src/codex-status-fetcher.ts`
  - 新增 `invalid_account` 错误分支，只在 refresh-400 时返回；必要时补 workspace identity。
- `src/codex-oauth.ts`
  - 从 token claims 提取 workspace / organization 标识，供 store 和 UI 复用。
- `src/codex-store.ts`
  - 给 `CodexAccountEntry` 增加 `workspaceName`，并保证新旧 store 兼容。
- `src/providers/codex-menu-adapter.ts`
  - 刷新 snapshot 时接入共享 helper；仅在 `invalid_account` 时删号切号。
- `src/codex-status-command.ts`
  - 接入共享 helper；成功态和缓存态都只输出账号、workspace、5h、week 四行。
- `test/codex-status-fetcher.test.js`
  - 增加 refresh-400、workspace 提取相关失败/成功测试。
- `test/codex-menu-adapter.test.js`
  - 增加 refreshSnapshots 遇到 `invalid_account` 时的删除与 fallback 行为测试。
- `test/codex-status-command.test.js`
  - 增加紧凑状态输出、400 切号提示、非 400 不切号回归测试。

---

### Task 1: 在 fetcher / store 层补齐 `invalid_account` 与 `workspaceName`

**Files:**
- Modify: `src/codex-status-fetcher.ts`
- Modify: `src/codex-oauth.ts`
- Modify: `src/codex-store.ts`
- Test: `test/codex-status-fetcher.test.js`
- Test: `test/codex-store.test.js`

- [ ] **Step 1: 先写 fetcher 的失败测试，锁定 refresh-400 行为**

```js
test("returns invalid_account when token refresh fails with 400", async () => {})
test("non-400 refresh failures stay as non-invalid-account errors", async () => {})
test("plain 400 status responses do not become invalid_account outside refresh flow", async () => {})
test("extracts workspace identity from oauth claims when available", async () => {})
```

- [ ] **Step 2: 运行聚焦测试确认红灯**

Run: `node --test test/codex-status-fetcher.test.js --test-name-pattern "invalid_account|workspace identity|refresh fails with 400"`
Expected: FAIL，提示当前没有 `invalid_account` 分支或 workspace 提取缺失。

- [ ] **Step 3: 在 `src/codex-oauth.ts` 增加 workspace 提取 helper**

```ts
export function extractWorkspaceNameFromClaims(claims: IdTokenClaims): string | undefined {
  return claims.organizations?.[0]?.id
}
```

- [ ] **Step 4: 在 `src/codex-status-fetcher.ts` 增加 refresh-400 专用错误分支**

```ts
if (refreshResult?.status === 400) {
  return {
    ok: false,
    error: {
      kind: "invalid_account",
      status: 400,
      message: refreshErrorMessage,
    },
  }
}
```

- [ ] **Step 5: 给 `CodexAccountEntry` 增加 `workspaceName` 并保持兼容读写**

```ts
export type CodexAccountEntry = {
  ...
  workspaceName?: string
}
```

- [ ] **Step 6: 为 `codex-store` 补一个最小回归测试**

```js
test("codex store preserves workspaceName in new shape", async () => {})
```

- [ ] **Step 7: 运行相关测试确认转绿**

Run: `node --test test/codex-status-fetcher.test.js test/codex-store.test.js --test-name-pattern "invalid_account|workspace|preserves workspaceName|refresh fails with 400"`
Expected: PASS，并明确验证“普通 400 响应 != invalid_account”。

- [ ] **Step 8: 提交本任务**

```bash
git add src/codex-status-fetcher.ts src/codex-oauth.ts src/codex-store.ts test/codex-status-fetcher.test.js test/codex-store.test.js
git commit -m "fix(codex): 识别无效账号并补充 workspace 标识"
```

---

### Task 2: 新增共享的 Codex 无效账号恢复 helper

**Files:**
- Create: `src/codex-invalid-account.ts`
- Test: `test/codex-invalid-account.test.js`
- Modify: `src/codex-store.ts`

- [ ] **Step 1: 先写 helper 的失败测试，锁定候选选择规则**

```js
test("removes invalid account and switches to week-positive account with earliest 5h reset", async () => {})
test("falls back to earliest week reset when no candidate has positive 5h", async () => {})
test("still switches to earliest week reset when all week quotas are zero and marks warning", async () => {})
test("clears active when invalid account was the last remaining account", async () => {})
test("persists openai auth only when a replacement account exists", async () => {})
test("accounts without resetAt sort after accounts with explicit resetAt", async () => {})
test("ties keep the original store order", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/codex-invalid-account.test.js`
Expected: FAIL，提示 helper 文件尚不存在或排序逻辑未实现。

- [ ] **Step 3: 在新文件中实现候选排序纯函数**

```ts
export function pickNextCodexAccount(accounts: Array<{ name: string; entry: CodexAccountEntry }>) {
  const weekPositive = accounts.filter((item) => (item.entry.snapshot?.usageWeek?.remaining ?? 0) > 0)
  ...
}
```

- [ ] **Step 4: 实现删除无效账号并切换 auth 的主 helper**

```ts
export async function recoverFromInvalidCodexAccount(input: {
  store: CodexStoreFile
  invalidName: string
  setAuth?: (entry: CodexAccountEntry) => Promise<void>
}) {
  delete input.store.accounts[input.invalidName]
  ...
}
```

helper 返回值至少包含：

```ts
{
  removed: { name: string; entry: CodexAccountEntry }
  replacement?: { name: string; entry: CodexAccountEntry }
  switched: boolean
  weekRecoveryOnly: boolean
  noCandidates: boolean
}
```

`/codex-status` 与 `codex-menu-adapter` 只能消费这个统一返回结构来拼 toast，不允许各自重写判断分支。

- [ ] **Step 5: 把 toast 所需的展示名规则固定下来，并写出优先级测试**

```ts
export function getCodexDisplayName(entry: CodexAccountEntry, fallbackName: string) {
  return entry.workspaceName || entry.name || entry.email || entry.accountId || fallbackName
}
```

补测试：

```js
test("display name prefers workspaceName over name email and accountId", async () => {})
```

- [ ] **Step 6: 运行 helper 测试确认转绿**

Run: `node --test test/codex-invalid-account.test.js`
Expected: PASS

- [ ] **Step 7: 提交本任务**

```bash
git add src/codex-invalid-account.ts test/codex-invalid-account.test.js src/codex-store.ts
git commit -m "fix(codex): 抽取无效账号恢复逻辑"
```

---

### Task 3: 让 Codex 菜单刷新复用共享恢复逻辑

**Files:**
- Modify: `src/providers/codex-menu-adapter.ts`
- Modify: `test/codex-menu-adapter.test.js`
- Read for context: `src/menu-runtime.ts`

- [ ] **Step 1: 先写菜单 adapter 的失败测试**

```js
test("codex adapter refreshSnapshots removes invalid account on refresh-400 and switches auth", async () => {})
test("codex adapter refreshSnapshots warns when fallback account only has week recovery", async () => {})
test("codex adapter refreshSnapshots keeps account on non-400 fetch errors", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/codex-menu-adapter.test.js --test-name-pattern "invalid account|refreshSnapshots|non-400 fetch errors|week recovery"`
Expected: FAIL，说明 adapter 尚未接共享 helper。

- [ ] **Step 3: 在 adapter 刷新循环里分流 `invalid_account`**

```ts
if (!result.ok && result.error.kind === "invalid_account") {
  await recoverFromInvalidCodexAccount(...)
  continue
}
```

- [ ] **Step 4: 刷新成功时同步维护 `workspaceName`**

```ts
workspaceName: result.status.identity.workspaceName ?? entry.workspaceName
```

- [ ] **Step 5: 运行 adapter 测试确认转绿**

Run: `node --test test/codex-menu-adapter.test.js`
Expected: PASS

- [ ] **Step 6: 提交本任务**

```bash
git add src/providers/codex-menu-adapter.ts test/codex-menu-adapter.test.js
git commit -m "fix(codex): 菜单刷新复用无效账号恢复逻辑"
```

---

### Task 4: 收敛 `/codex-status` 输出并接入无效账号恢复

**Files:**
- Modify: `src/codex-status-command.ts`
- Modify: `test/codex-status-command.test.js`
- Read for style reference: `src/status-command.ts`

- [ ] **Step 1: 先写 `/codex-status` 的失败测试**

```js
test("codex status command renders only account workspace 5h and week lines", async () => {})
test("codex status command removes invalid account on refresh-400 and switches to replacement", async () => {})
test("codex status command does not switch accounts on non-400 fetch errors", async () => {})
test("codex status command warns when replacement account only has week recovery", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/codex-status-command.test.js --test-name-pattern "renders only account workspace 5h and week|invalid account|does not switch accounts|week recovery"`
Expected: FAIL，当前输出仍含多余字段，且 refresh-400 还不会删号切号。

- [ ] **Step 3: 重写状态渲染函数，只保留四行字段**

```ts
function renderStatusSummary(input: { accountName?: string; workspaceName?: string; ... }) {
  return [
    `账号: ${...}`,
    `Workspace: ${...}`,
    renderWindow("5h", ...),
    renderWindow("week", ...),
  ].join("\n")
}
```

- [ ] **Step 4: 在 `/codex-status` 中分流 `invalid_account`**

```ts
if (!fetched.ok && fetched.error.kind === "invalid_account") {
  const recovery = await recoverFromInvalidCodexAccount(...)
  await showToast({ message: buildInvalidAccountToast(recovery), variant: "warning" })
  throw new CodexStatusCommandHandledError()
}
```

- [ ] **Step 5: 保持非 400 错误的缓存回退逻辑，但正文严格只输出四行摘要**

```ts
await showToast({
  message: `Codex status fetch failed (${fetched.error.message}); showing cached snapshot.`,
  variant: "warning",
})

message: renderCachedStatusForAccount(...)
```

并补测试断言：命令正文不包含 `fetch failed`、`cached snapshot`、`Codex status updated` 等额外文字。

- [ ] **Step 6: 运行命令测试确认转绿**

Run: `node --test test/codex-status-command.test.js`
Expected: PASS

- [ ] **Step 7: 提交本任务**

```bash
git add src/codex-status-command.ts test/codex-status-command.test.js
git commit -m "fix(codex): 收敛状态展示并处理无效账号"
```

---

### Task 5: 全量回归与发布前验证

**Files:**
- Verify only: `test/codex-status-fetcher.test.js`
- Verify only: `test/codex-invalid-account.test.js`
- Verify only: `test/codex-menu-adapter.test.js`
- Verify only: `test/codex-status-command.test.js`
- Verify only: `test/codex-plugin-config.test.js`

- [ ] **Step 1: 跑 Codex 相关聚焦测试**

Run: `node --test test/codex-status-fetcher.test.js test/codex-invalid-account.test.js test/codex-menu-adapter.test.js test/codex-status-command.test.js`
Expected: PASS

- [ ] **Step 2: 跑插件入口回归测试，确认 OpenAI/Codex 装配没有回退**

Run: `node --test test/codex-plugin-config.test.js test/plugin.test.js --test-name-pattern "codex|openai auth provider is wired|github-copilot auth methods no longer include Codex entry"`
Expected: PASS

- [ ] **Step 3: 跑全量测试**

Run: `npm test`
Expected: PASS，0 fail

- [ ] **Step 4: 自查验收标准**

Checklist:
- refresh-400 会移除无效账号
- toast 主句使用 `无效账号xxx已移除，请及时检查核对`
- workspace 名优先于普通账号名
- 候选排序遵守 week/5h/resetAt 规则
- `/codex-status` 正文只剩账号 / workspace / 5h / week
- 非 400 错误不会删号切号

- [ ] **Step 5: 仅在仍有未提交变更时补最后一个收尾提交**

```bash
git add src/codex-status-fetcher.ts src/codex-oauth.ts src/codex-store.ts src/codex-invalid-account.ts src/providers/codex-menu-adapter.ts src/codex-status-command.ts test/codex-status-fetcher.test.js test/codex-store.test.js test/codex-invalid-account.test.js test/codex-menu-adapter.test.js test/codex-status-command.test.js
git diff --cached --quiet || git commit -m "fix(codex): 处理无效账号并收敛状态展示"
```

---

## 执行备注

- 一定先把 `invalid_account` 结构化错误定下来，再做共享 helper；
- 只有 refresh-400 才允许触发删号和切号，不要在上层用宽松字符串匹配扩大范围；
- `workspaceName` 只是用户可见名称，不可替代内部账号主键；
- `/codex-status` 正文必须严格收敛为四行字段，缓存/错误说明走 toast，而不是重新把冗余信息塞回正文；
- 菜单刷新与 `/codex-status` 必须共用同一套恢复 helper，避免再次分叉。
