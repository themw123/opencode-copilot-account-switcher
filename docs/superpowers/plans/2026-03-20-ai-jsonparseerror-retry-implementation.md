# AI_JSONParseError 可重试归一化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Copilot 响应链上看起来像网络截断导致的 `AI_JSONParseError` 在 retry fetch 最外层 `catch` 被归一化成可重试 `AI_APICallError`，同时不误伤非 Copilot 或本地 JSON.parse 错误。

**Architecture:** 在 `src/copilot-network-retry.ts` 的最外层 `catch` 增加一个窄匹配判定函数，仅当请求 URL 属于 Copilot 且错误具有 AI 响应解析失败特征时，才复用现有 `toRetryableApiCallError(..., { group: "transport" })` 包装；对应测试集中在 `test/copilot-network-retry.test.js`，先红后绿锁定 Copilot 命中、非 Copilot 排除、本地 parse error 排除三类行为。

**Tech Stack:** TypeScript, Node.js built-in test runner, existing Copilot retry wrapper, Vercel AI-style error markers.

---

### Task 1: 用失败测试钉住 Copilot `AI_JSONParseError` 的可重试转换

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，覆盖 Copilot URL 上的 `AI_JSONParseError`**

新增测试至少断言：

- `baseFetch` 在 Copilot URL 上 reject 一个 `AI_JSONParseError`
- 错误 message 包含 `JSON parsing failed: Text:`
- `createCopilotRetryingFetch(...)` 最终抛出的是 `AI_APICallError`
- `isRetryable === true`
- 错误 message 仍保留现有 `Copilot retryable error [transport]: ...` 风格

- [ ] **Step 2: 只跑这条测试，确认先失败**

Run: `node --test test/copilot-network-retry.test.js --test-name-pattern "AI_JSONParseError"`

Expected: FAIL，且失败点是当前代码没有把这类错误转成 retryable `AI_APICallError`。

- [ ] **Step 3: 在 `src/copilot-network-retry.ts` 新增窄匹配判定函数**

最小实现要求：

- 新增专门函数，例如 `isRetryableCopilotJsonParseError(error)`
- 只匹配 AI 响应解析特征：
  - `name === "AI_JSONParseError"` 或 message 具有 AI JSON parse 失败特征
  - message 里包含 `json parsing failed`
  - message 里包含 `text:`
- 不要把这类逻辑塞进通用 `RETRYABLE_MESSAGES`

- [ ] **Step 4: 在最外层 `catch` 里把这个窄匹配并入 Copilot retry 判定**

最小实现要求：

- 只在 `isCopilotUrl(safeRequest)` 为 true 时生效
- 命中后继续走现有 `toRetryableApiCallError(..., { group: "transport" })`
- 不引入新的对外错误类型

- [ ] **Step 5: 重跑目标测试，确认转绿**

Run: `node --test test/copilot-network-retry.test.js --test-name-pattern "AI_JSONParseError"`

Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add test/copilot-network-retry.test.js src/copilot-network-retry.ts
git commit -m "fix(retry): 支持 Copilot JSON 解析截断错误重试"
```

### Task 2: 用失败测试锁住排除条件，防止误伤

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，覆盖“非 Copilot URL 相同错误不转”**

新增测试至少断言：

- 请求 URL 不是 Copilot 域名
- `baseFetch` 抛出同样的 `AI_JSONParseError`
- 最终仍抛原错误，不被改写成 `AI_APICallError`

- [ ] **Step 2: 写失败测试，覆盖“普通本地 parse error 不转”**

新增测试至少断言：

- Copilot URL 下如果抛出的只是普通 `SyntaxError` 或不带 AI 特征的 parse error
- 最终不应被改写成 retryable `AI_APICallError`

- [ ] **Step 3: 只跑这组排除测试，确认先失败**

Run: `node --test test/copilot-network-retry.test.js --test-name-pattern "非 Copilot|本地 parse|does not normalize"`

Expected: FAIL，且失败点是当前实现如果过宽会把不该转的错误也转掉。

- [ ] **Step 4: 最小收紧判定函数与 `catch` 条件**

实现要求：

- 非 Copilot URL 明确排除
- 不带 AI 响应解析特征的 parse error 明确排除
- 不破坏 Task 1 的命中场景

- [ ] **Step 5: 重跑排除测试，确认转绿**

Run: `node --test test/copilot-network-retry.test.js --test-name-pattern "非 Copilot|本地 parse|does not normalize"`

Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add test/copilot-network-retry.test.js src/copilot-network-retry.ts
git commit -m "test(retry): 锁住 JSON 解析错误重试排除条件"
```

### Task 3: 运行针对性与全量验证

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 运行整个 retry 测试文件**

Run: `node --test test/copilot-network-retry.test.js`

Expected: PASS

- [ ] **Step 2: 运行完整项目测试**

Run: `npm test`

Expected: PASS

- [ ] **Step 3: 检查最终 diff 只包含本轮修复相关文件**

Run: `git diff --stat origin/master...HEAD`

Expected: 主要只涉及 `src/copilot-network-retry.ts` 与 `test/copilot-network-retry.test.js`，以及必要文档。

- [ ] **Step 4: 检查工作树状态**

Run: `git status --short --branch`

Expected: 工作树干净，或只剩下准备提交的收尾改动。

- [ ] **Step 5: 准备交付说明**

说明里必须覆盖：

- 捕获点为什么放在 retry fetch 最外层 `catch`
- 为什么只把窄匹配的 Copilot `AI_JSONParseError` 转成 retryable
- 为什么非 Copilot 与本地 parse error 没被纳入
