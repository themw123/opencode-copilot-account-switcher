# Codex Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为插件新增 `/codex-status`，通过上游 OpenAI OAuth 凭据请求 Codex 远端 usage/status，并把身份与最近一次状态快照缓存到 Codex 专用 store。

**Architecture:** 沿用当前插件的“独立命令模块 + 受控中断 + toast 输出”模式，但把 Codex 状态能力拆成四个清晰边界：认证来源、远端 fetcher、Codex store、slash command。认证与鉴权方式对齐 opencode 上游 `plugin/codex.ts`，远端状态接口与字段语义参考 `myauth` 的 `/usage` 实现。

**Tech Stack:** TypeScript, Node test runner, existing plugin hooks, local JSON store helpers, OpenAI OAuth auth data

---

## 文件结构与职责映射

### 实现前约束

- 优先复用现有 helper 与边界：
  - auth 读写入口优先复用当前仓库已存在的 auth/client 接口；
  - slash command 的受控中断、toast 模式优先复用现有 `status-command` / command-handled 约定；
  - 只有在现有 helper 无法表达 Codex 语义时，才新增最小 helper。
- 本计划坚持 TDD：每个新增边界都要先写失败测试，再显式跑一次确认红灯，然后才写实现。

### 新增

- `src/codex-store.ts`
  - Codex 专用 store 路径、读写、结构定义

- `src/codex-auth-source.ts`
  - 从现有 auth 数据读取/刷新 OpenAI OAuth，提取 accountId

- `src/codex-status-fetcher.ts`
  - 请求 `https://chatgpt.com/backend-api/codex/usage` 并归一化返回体

- `src/codex-status-command.ts`
  - `/codex-status` 的命令逻辑、toast 输出、受控中断

- `test/codex-status-command.test.js`
  - command 成功/失败/回退缓存输出测试

- `test/codex-status-fetcher.test.js`
  - OAuth 读取、token 刷新、返回体归一化测试

### 修改

- `src/plugin-hooks.ts`
  - 注册 `/codex-status` 并接入新命令

- `src/providers/descriptor.ts`
  - 给 codex descriptor 加入 `codex-status` 能力/命令占位

- `src/providers/registry.ts`
  - 若需要，暴露 codex status capability 给后续装配测试使用

- `test/plugin.test.js`
  - 补 slash command 注册测试

---

### Task 1: 先锁定 `/codex-status` 的命令注册与受控中断红灯测试

**Files:**
- Modify: `test/plugin.test.js`
- Create: `test/codex-status-command.test.js`

- [ ] **Step 1: 为 `/codex-status` 注册写失败测试**

```js
test("experimental slash commands enabled registers codex-status", async () => {})
test("experimental slash commands disabled leaves codex-status unregistered", async () => {})
```

- [ ] **Step 2: 为 command 入口写失败测试**

```js
test("codex status command ends with controlled interrupt after success toast", async () => {})
test("codex status command shows auth-missing error and exits with controlled interrupt", async () => {})
```

- [ ] **Step 3: 跑聚焦测试确认红灯**

Run:

```bash
node --test test/plugin.test.js test/codex-status-command.test.js
```

Expected: FAIL，且失败原因是 `codex-status` 尚未注册、命令模块不存在或行为未实现，而不是测试语法错误。

---

### Task 2: 先把 codex descriptor / registry 接到命令注册路径

**Files:**
- Modify: `src/providers/descriptor.ts`
- Modify: `src/providers/registry.ts`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 为 codex descriptor 命令占位补失败测试**

```js
test("codex descriptor exposes codex-status command while staying isolated from copilot commands", () => {})
```

- [ ] **Step 2: 跑测试确认红灯**

Run:

```bash
node --test test/plugin.test.js --test-name-pattern "codex-status|descriptor"
```

Expected: FAIL，且失败原因是 codex descriptor 尚未暴露 `codex-status`。

- [ ] **Step 3: 最小修改 descriptor / registry，让 `codex-status` 有明确命令能力声明**

- [ ] **Step 4: 跑插件聚焦测试确认转绿**

Run:

```bash
node --test test/plugin.test.js --test-name-pattern "codex-status|descriptor"
```

Expected: PASS

---

### Task 3: 建立 Codex 专用 store 边界

**Files:**
- Create: `src/codex-store.ts`
- Modify: `test/codex-status-command.test.js`

- [ ] **Step 1: 先写 store 独立失败测试**

```js
test("codex store reads and writes codex-only snapshots without touching copilot fields", async () => {})
```

- [ ] **Step 2: 跑测试确认红灯**

Run:

```bash
node --test test/codex-status-command.test.js --test-name-pattern "codex store"
```

Expected: FAIL，且失败原因是 `codex-store` 尚未实现。

- [ ] **Step 3: 定义 Codex store 结构与路径 helper**

至少包含：

```ts
type CodexStatusStore = {
  activeProvider?: "openai"
  activeAccountId?: string
  activeEmail?: string
  lastStatusRefresh?: number
  account?: {
    email?: string
    accountId?: string
    plan?: string
    teamSpace?: string
    updatedAt?: number
  }
  status?: {
    source: "remote" | "cached"
    updatedAt?: number
    credits?: unknown
    windows?: {
      primary?: { remainingPercent?: number; resetAt?: number }
      secondary?: { remainingPercent?: number; resetAt?: number }
    }
    rawSummary?: string
    error?: string
  }
}
```

- [ ] **Step 4: 写最小读写实现**

- [ ] **Step 5: 跑 store 聚焦测试确认转绿**

Run:

```bash
node --test test/codex-status-command.test.js --test-name-pattern "codex store"
```

Expected: PASS

---

### Task 4: 抽出 Codex OAuth 来源与 accountId 解析逻辑

**Files:**
- Create: `src/codex-auth-source.ts`
- Create: `test/codex-status-fetcher.test.js`

- [ ] **Step 1: 写失败测试覆盖三种输入**

```js
test("reads openai oauth auth with accountId directly", async () => {})
test("extracts accountId from token claims when auth body misses it", async () => {})
```

- [ ] **Step 2: 实现最小认证来源 helper**

要求：

- 读取现有 auth 中的 `openai` OAuth；
- 支持直接 `accountId`；
- 支持从 JWT claims 提取 `accountId`；
- 返回“建议回写字段”，但不直接写 auth。

- [ ] **Step 3: 跑聚焦测试确认转绿**

Run:

```bash
node --test test/codex-status-fetcher.test.js --test-name-pattern "oauth|accountId"
```

Expected: PASS

---

### Task 5: 实现 `codex-status-fetcher` 远端 usage 请求、401 刷新重试与归一化

**Files:**
- Create: `src/codex-status-fetcher.ts`
- Modify: `test/codex-status-fetcher.test.js`

- [ ] **Step 1: 先写归一化失败测试**

```js
test("fetches codex usage with Authorization and ChatGPT-Account-Id headers", async () => {})
test("normalizes usage payload into identity and window snapshots", async () => {})
test("retries once with refreshed oauth tokens after 401", async () => {})
test("degrades cleanly on 429 timeout 5xx and non-json responses", async () => {})
test("keeps missing quota fields as undefined instead of fabricating values", async () => {})
```

- [ ] **Step 2: 实现最小 fetcher**

请求要求：

- URL: `https://chatgpt.com/backend-api/codex/usage`
- Method: `GET`
- Headers:
  - `Authorization: Bearer <access_token>`
  - `ChatGPT-Account-Id: <account_id>`
  - `Accept: application/json`
  - `User-Agent: Codex CLI`

- [ ] **Step 3: 实现 payload -> snapshot 归一化**

- [ ] **Step 4: 把 refresh 行为限制为返回新的 auth patch，由上层决定是否持久化**

- [ ] **Step 5: 跑聚焦测试确认转绿**

Run:

```bash
node --test test/codex-status-fetcher.test.js
```

Expected: PASS

---

### Task 6: 实现 `codex-status-command` 与 toast 输出

**Files:**
- Create: `src/codex-status-command.ts`
- Modify: `src/plugin-hooks.ts`
- Modify: `test/codex-status-command.test.js`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 先写 command 成功路径失败测试**

```js
test("codex status command fetches remote status, writes codex store, and shows success toast", async () => {})
```

- [ ] **Step 2: 再写 fail-open 测试**

```js
test("codex status command falls back to latest cached status on remote error", async () => {})
test("codex status command fails with error toast when neither auth nor cache is available", async () => {})
test("codex status command renders n/a for missing quota fields", async () => {})
```

- [ ] **Step 3: 实现 command 模块**

要求：

- 先发 info toast（例如 `Fetching Codex status...`）；
- 调 auth source + fetcher；
- 在 command 层统一决定是否回写 auth patch；
- 写 Codex store；
- 输出身份块 + usage 块；
- 最后抛受控 handled error。

- [ ] **Step 4: 在 `plugin-hooks.ts` 注册 `/codex-status` 并接入 command**

- [ ] **Step 5: 跑 command / plugin 聚焦测试确认转绿**

Run:

```bash
node --test test/codex-status-command.test.js test/plugin.test.js
```

Expected: PASS

---

### Task 7: 全量验证与文案检查

**Files:**
- Verify all touched source/tests

- [ ] **Step 1: 跑 Codex 相关聚焦验证**

Run:

```bash
node --test test/codex-status-fetcher.test.js test/codex-status-command.test.js test/plugin.test.js
```

Expected: PASS

- [ ] **Step 2: 跑全量测试**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 3: 自检边界**

确认：

- `/codex-status` 没有接入 Copilot quota/routing/store；
- Codex 认证仍然跟随 `openai` OAuth；
- 字段缺失时输出 `n/a`；
- 远端失败时存在缓存回退路径。

- [ ] **Step 4: 提交实现（仅在用户要求时）**

建议提交信息：

```bash
git commit -m "feat(codex): 新增远端状态查询命令"
```
