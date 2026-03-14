# Copilot Input ID Session Repair Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 GitHub Copilot `input[*].id too long` 的处理从“仅修当前请求 payload”升级为“在 400 明确命中后，精确定位坏 part、回写 session 源数据、只定向修复当前失败项并加强日志”。

**Architecture:** 继续保留 `src/copilot-network-retry.ts` 作为唯一的 Copilot fetch 包装层，但它不再“一锅端”删除所有长 `id`。插件会在 `chat.headers` 注入仅供内部使用的 `sessionID` 上下文，fetch 包装层在命中 `400 input[*].id too long` 后解析报错、收敛当前 payload 候选项、通过本地 OpenCode session/message/part API 读取并回写唯一命中的来源 part，再仅对当前失败项做定向重试，同时把 payload 候选、session 候选、最终命中 part 和修复结果写入 debug 日志。

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin hooks, 本地 OpenCode SDK/client, 本地 OpenCode server route

---

## Execution Notes

- 当前测试从 `dist/` 导入构建产物，因此所有测试步骤都必须先运行 `npm run build`，再执行对应的 `node --test ...`。
- 必须坚持 TDD：先写失败测试，确认失败原因正确，再写最小实现。
- `input[3].id` 不能直接被当成 JS `payload.input[3]` 的 0-based 下标；实现必须显式走“候选收敛”而不是硬编码下标直取。
- 任何自动修复都只能在 `400 input[*].id too long` 明确命中后触发；禁止新增发送前预清洗逻辑。
- 插件内部透传的 `sessionID` header 绝不能泄露到外部 Copilot provider，请在首次请求、重试请求、失败路径都加回归测试。
- session part 回写要基于最新读取到的 part 构造最小变更副本，只删 `metadata.openai.itemId`，不能用旧 part 快照整块覆盖。

---

## File Map

- Modify: `src/plugin-hooks.ts`
  - 给 retry fetch 注入插件上下文，新增 `chat.headers` 透传内部 `sessionID` header，同时保留现有 `experimental.chat.system.transform`
- Modify: `src/copilot-network-retry.ts`
  - 解析 `400` 报错索引与长度、收敛 payload 候选项、清理内部 header、执行 session 查询/回写、仅定向移除失败项、增加循环上限与重复命中停机条件、输出精确日志
- Optional: `src/index.ts`
  - 仅当执行中被测试证明必须新增公共导出时才修改；默认不扩大导出面
- Test: `test/plugin.test.js`
  - 覆盖 hooks 同时暴露 `chat.headers` 与 `experimental.chat.system.transform`、内部 header 注入、retry wrapper 上下文注入
- Test: `test/copilot-network-retry.test.js`
  - 覆盖 400 后的 payload 候选收敛、session 查询与回写、定向重试、route 不可用降级、内部 header 剥离、日志字段
- Reference: `docs/superpowers/specs/2026-03-14-copilot-input-id-session-repair-design.md`
  - 实现时每一步都要回对 spec，避免回退到“清所有长 id”的旧行为

## Chunk 1: Hook Wiring And Internal Context

### Task 1: 让插件同时暴露 `chat.headers` 并锁定内部 header 注入规则

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试，要求插件同时保留现有 transform 并新增 `chat.headers`**

在 `test/plugin.test.js` 新增：

```js
test("plugin exposes chat.headers alongside auth loader and system transform", () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false, networkRetryEnabled: true }),
  })

  assert.equal(typeof plugin.auth?.loader, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(typeof plugin["experimental.chat.system.transform"], "function")
})

test("chat.headers injects internal session header only for Copilot models", async () => {
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false, networkRetryEnabled: true }),
  })

  const copilot = { headers: {} }
  const other = { headers: {} }

  await plugin["chat.headers"]?.(
    {
      sessionID: "sess-123",
      agent: "build",
      model: { providerID: "github-copilot", modelID: "gpt-4.1" },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m1" },
    },
    copilot,
  )

  await plugin["chat.headers"]?.(
    {
      sessionID: "sess-456",
      agent: "build",
      model: { providerID: "google", modelID: "gemini-2.5-pro" },
      provider: { source: "custom", info: {}, options: {} },
      message: { id: "m2" },
    },
    other,
  )

  assert.equal(copilot.headers["x-opencode-session-id"], "sess-123")
  assert.equal(other.headers["x-opencode-session-id"], undefined)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/plugin.test.js`
Expected: FAIL，提示 `chat.headers` 不存在，或没有正确注入/过滤 header

- [ ] **Step 3: 最小实现 hook 结构**

在 `src/plugin-hooks.ts`：
- 保持现有 `auth.loader` 逻辑不变
- 新增 `chat.headers` hook
- 该 hook 只在 `input.model.providerID` 包含 `github-copilot` 时注入内部 header
- header 名称固定，例如 `x-opencode-session-id`
- header 值必须直接来自 `input.sessionID`
- `experimental.chat.system.transform` 继续保留且行为不变

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/plugin.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(copilot): 注入 session 修复所需内部请求上下文"
```

### Task 2: 把插件上下文透传到 retry wrapper 配置中

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/plugin.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试，要求启用 retry 时会把上下文传给 wrapper 工厂**

在 `test/plugin.test.js` 新增：

```js
test("plugin auth loader passes plugin context into retry wrapper factory", async () => {
  const calls = []
  const fakeClient = { session: { messages: async () => ({ data: [] }) } }
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({ accounts: {}, loopSafetyEnabled: false, networkRetryEnabled: true }),
    loadOfficialConfig: async () => ({ baseURL: "https://api.githubcopilot.com", apiKey: "", fetch: async () => new Response("{}") }),
    createRetryFetch: (fetch, ctx) => {
      calls.push({ fetch, ctx })
      return fetch
    },
    client: fakeClient,
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
  })

  await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), { models: {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ctx?.client, fakeClient)
  assert.equal(calls[0].ctx?.directory, "C:/repo")
  assert.ok(calls[0].ctx?.serverUrl)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/plugin.test.js`
Expected: FAIL，提示 `createRetryFetch` 签名或上下文不符合预期

- [ ] **Step 3: 最小实现 wrapper 上下文注入**

在 `src/plugin-hooks.ts`：
- 扩展 `createRetryFetch` 签名，第二个参数传入最小上下文
- 上下文至少包括：`client`、`directory`、`serverUrl`
- 默认实现仍指向 `createCopilotRetryingFetch`

在 `src/plugin.ts`：
- 调用 `buildPluginHooks(...)` 时把 `client`、`directory`、`serverUrl` 显式传入

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/plugin.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/plugin-hooks.ts src/plugin.ts test/plugin.test.js
git commit -m "feat(copilot): 为重试包装器接入插件上下文"
```

## Chunk 2: Retry Core Refactor

### Task 3: 用失败测试锁定“只定向处理一个坏 id”

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，要求多长 id 场景下单轮只修一个目标项**

在 `test/copilot-network-retry.test.js` 新增：

```js
test("only strips the targeted failing input id instead of all long ids", async () => {
  const calls = []
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)
    if (calls.length === 1) {
      return new Response("Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }, { /* minimal fake ctx */ })

  const originalBody = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "a" }], id: "x".repeat(200) },
      { role: "assistant", content: [{ type: "output_text", text: "b" }], id: "y".repeat(408) },
    ],
    previous_response_id: "resp_123",
  }

  await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalBody),
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].input[1].id.length, 200)
  assert.equal(calls[0].input[2].id.length, 408)
  assert.equal(calls[1].input[1].id.length, 200)
  assert.equal(calls[1].input[2].id, undefined)
  assert.equal(calls[1].previous_response_id, "resp_123")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，当前实现会把所有长 id 一起删掉

- [ ] **Step 3: 最小实现单项定向清理 helper**

在 `src/copilot-network-retry.ts`：
- 拆出只按目标候选项移除单个 `id` 的 helper
- 暂时不要接入 session 回写，只让测试先通过“单项定向清理”

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 将超长 input id 重试收窄到单项修复"
```

### Task 4: 锁定“不能把服务端索引直接当 payload 下标”并覆盖索引解析缺失时的安全退出

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，要求 `input[3]` 报错不会直接硬取 `payload.input[3]`**

测试用例要模拟：
- 报错索引是 `3`
- payload 中真实坏项收敛必须依赖长度/值匹配，而不是直接下标命中
- 另加一个用例：可识别 `too long`，但文本中没有可解析的 `input[<n>]`，此时只记日志、不做 session 回写

示例断言：

```js
test("does not treat server input index as direct payload array index", async () => {
  const calls = []
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push(body)
    if (calls.length === 1) {
      return new Response("Invalid 'input[3].id': string too long. Expected a string with maximum length 64, but got a string with length 408 instead.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }, { /* minimal fake ctx */ })

  const body = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "short" }], id: "short-id" },
      { role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "z".repeat(408) },
    ],
  }

  await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  assert.equal(calls[1].input[1].id, "short-id")
  assert.equal(calls[1].input[2].id, undefined)
})

test("does not attempt session repair when too-long error lacks parsable input index", async () => {
  const sessionReads = []
  const patchCalls = []
  const wrapped = createCopilotRetryingFetch(
    async () =>
      new Response("Invalid input id: string too long. Expected a string with maximum length 64, but got a string with length 408 instead.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    {
      client: { session: { messages: async () => { sessionReads.push(true); return { data: [] } } } },
      directory: "C:/repo",
      serverUrl: new URL("http://localhost:4096"),
      patchPart: async () => patchCalls.push(true),
    },
  )

  const response = await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({
      input: [{ role: "assistant", content: [{ type: "output_text", text: "bad" }], id: "z".repeat(408) }],
    }),
  })

  assert.equal(response.status, 400)
  assert.deepEqual(sessionReads, [])
  assert.deepEqual(patchCalls, [])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，当前实现没有这个保护

- [ ] **Step 3: 最小实现 payload 候选收敛逻辑**

在 `src/copilot-network-retry.ts`：
- 新增解析 `serverReportedIndex` / `reportedLength`
- 新增 payload 候选收集 helper，记录 `payloadIndex`、`idLength`、`itemKind`
- 候选收敛优先按长 id 数量与长度匹配，不允许直接 `payload.input[reportedIndex]`
- 当 `serverReportedIndex` 缺失时，显式走“日志 + 不回写 session”的分支

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 避免将服务端 input 索引误当 payload 下标"
```

### Task 5: 增加 session 查询与唯一匹配回写

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，要求 400 后会查 session 并回写唯一命中的 part**

测试需要准备：
- fake session messages API 返回一个 assistant message，其中某个 part 的 `metadata.openai.itemId` 等于 `failingId`
- fake part patch API 记录收到的 body
- fake local server request 断言 URL 使用 `serverUrl`，并带上 `x-opencode-directory`

断言：
- 会调用一次 session 读取
- 会调用一次 part patch
- patch body 只删除 `metadata.openai.itemId`，保留其他字段
- patch 前必须先重新读取最新 part，再基于最新 part 构造最小变更副本

建议把失败测试写成接近可执行的形式：

```js
test("repairs the uniquely matched session part after a too-long input id 400", async () => {
  const sessionReads = []
  const patchCalls = []
  const ctx = {
    directory: "C:/repo",
    serverUrl: new URL("http://localhost:4096"),
    client: {
      session: {
        messages: async ({ path }) => {
          sessionReads.push(path)
          return {
            data: [
              {
                info: { id: "msg_1", role: "assistant" },
                parts: [
                  { id: "part_1", messageID: "msg_1", sessionID: "sess-123", type: "text", text: "hi", metadata: { openai: { itemId: "x".repeat(408), keep: true } } },
                ],
              },
            ],
          }
        },
      },
    },
    patchPart: async (request) => {
      patchCalls.push(request)
      return { ok: true }
    },
  }

  // assertions should verify sessionReads, patchCalls[0].url, patchCalls[0].headers, patchCalls[0].body
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，当前实现没有 session 查询/回写

- [ ] **Step 3: 最小实现 session 搜索与 part patch**

在 `src/copilot-network-retry.ts`：
- 定义 retry 上下文类型，包含 `client`、`directory`、`serverUrl`
- 用 `client.session.messages` 或 `client.session.message` 读取 session 消息
- 遍历 assistant message 的 `text` / `reasoning` / `tool` part，按 `metadata.openai.itemId === failingId` 匹配
- 唯一匹配时，通过本地 route `PATCH /session/{sessionID}/message/{messageID}/part/{partID}` 回写最新副本，只删 `metadata.openai.itemId`

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 在超长 input id 报错后回写会话来源 part"
```

### Task 6: 锁定歧义、不存在、`sessionID` 缺失与 route 不可用时的安全降级

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，覆盖以下五类降级路径**

新增至少五个用例：

```js
test("does not patch session when matching part is ambiguous", async () => {})
test("does not patch session when no matching part exists", async () => {})
test("falls back to targeted payload retry when session header is missing", async () => {})
test("falls back to targeted payload retry when session route returns 404", async () => {})
test("falls back to targeted payload retry when session route returns 405", async () => {})
test("falls back to targeted payload retry when session patch request fails before reaching route", async () => {})
```

断言：
- session 回写失败时当前请求仍可继续单项重试
- session 查询没有匹配时当前请求仍可继续单项重试
- 歧义时不误改 session
- route 不可用不会导致整个请求失败在插件内部

同时补一个“payload 目标异常”用例，覆盖：
- 收敛出的目标项没有 `id`
- `id` 不是字符串
- 候选项为空

这些场景都必须安全退出，不做 session 回写。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL

- [ ] **Step 3: 最小实现安全降级与重复命中停机条件**

在 `src/copilot-network-retry.ts`：
- 对 session 搜索 `0 个` / `多于 1 个` 的情况安全降级
- 对 part patch 的 `404` / `405` / 网络错误做安全降级
- 加入 `MAX_INPUT_ID_REPAIR_ATTEMPTS`
- 加入“同一 failingId 连续命中且无有效变化则停机”的终止条件
- 对 `sessionID` 缺失、索引解析失败、payload 目标异常的情况只记日志并安全退出 session 回写

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 为会话回写失败路径增加安全降级"
```

### Task 7: 锁定多坏项逐轮修复上限与重复命中停机

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，覆盖逐轮修复与停机条件**

新增至少两个用例：

```js
test("repairs multiple too-long input ids one at a time up to the max attempt limit", async () => {})
test("stops retrying when the same failing id repeats without effective session change", async () => {})
```

断言：
- 同一请求中若连续返回不同坏项，只能逐轮修一个，且达到上限后停止
- 若同一个 `failingId` 重复命中且 session 修复没有产生有效变化，应立即停机，避免空转

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL

- [ ] **Step 3: 最小实现循环上限与重复命中停机逻辑**

在 `src/copilot-network-retry.ts`：
- 增加 `MAX_INPUT_ID_REPAIR_ATTEMPTS`
- 记录最近命中的 `failingId` / 修复结果
- 对“重复命中且无变化”即时停机

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 为超长 input id 修复增加上限与停机条件"
```

## Chunk 3: Internal Header Safety And Diagnostics

### Task 8: 确保内部 `sessionID` header 在所有入口与失败路径都被剥离

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，覆盖 `Request.headers`、`init.headers`、首次请求、重试请求与失败路径**

新增用例：

```js
test("strips internal session header when it arrives via init.headers on the first provider request", async () => {
  const seen = []
  const wrapped = createCopilotRetryingFetch(async (_request, init) => {
    seen.push(new Headers(init?.headers))
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }, { /* fake ctx */ })

  await wrapped("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "sess-123" },
    body: JSON.stringify({ input: [] }),
  })

  assert.equal(seen[0].get("x-opencode-session-id"), null)
})

test("strips internal session header when it arrives via Request.headers on the first provider request", async () => {
  // Build a Request with x-opencode-session-id already present and assert provider never sees it
})

test("strips internal session header from retried provider requests", async () => {
  // First response 400, second response 200; assert both outgoing attempts omit the internal header
})

test("strips internal session header even when session repair falls back after a failed patch", async () => {
  // Force session patch failure, then assert downgraded retry still omits the internal header
})
```

断言首次请求、重试请求、以及 session 回写失败后的降级请求传给外部 provider 的 headers 中都没有 `x-opencode-session-id`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL

- [ ] **Step 3: 最小实现 header 剥离 helper**

在 `src/copilot-network-retry.ts`：
- 新增统一的 header 处理 helper
- 同时覆盖 `Request` 自带 headers 与 `init.headers`
- 确保外部 provider 永远看不到内部 header

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 剥离内部 session header 防止外发泄露"
```

### Task 9: 增加精确日志，锁定 payload 候选、session 候选与命中 part

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，要求 debug 日志包含精确定位字段**

在 `test/copilot-network-retry.test.js` 新增：

```js
test("writes detailed input-id repair diagnostics when debug logging is enabled", async () => {
  // Arrange one 400 too-long response, one successful retry, one unique session-part match
  // Assert log file includes parsed index, payload candidates, payload target, session candidates,
  // session match, session repair, retry response, and a truncated idPreview
})
```

至少断言日志中出现：
- `input-id retry parsed`
- `input-id retry payload candidates`
- `input-id retry payload target`
- `input-id retry session candidates`
- `input-id retry session match`
- `input-id retry session repair`
- `input-id retry response`

并额外断言关键字段：
- `serverReportedIndex`
- `targetedPayloadIndex`
- `partID`
- `partType`
- `idLength`
- `idPreview`

其中 `idPreview` 需要验证为截断值，而不是完整超长 `id`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL

- [ ] **Step 3: 最小实现精确日志**

在 `src/copilot-network-retry.ts`：
- 为解析、payload 候选收敛、session 候选搜索、session 回写、重试响应分别新增 debugLog
- `idPreview` 只保留短前缀，避免把完整敏感值写满日志

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(debug): 增强超长 input id 的精确诊断日志"
```

## Chunk 4: Whole-Suite Verification And Docs Touch-Up

### Task 10: 验收当前公共导出面保持收敛

**Files:**
- Test: `test/plugin.test.js`
- Optional: `src/index.ts`

- [ ] **Step 1: 写验收测试，锁定当前公共导出面不扩大**

在 `test/plugin.test.js` 新增：

```js
test("public exports remain intentionally minimal for input-id session repair", async () => {
  const mod = await import("../dist/index.js")
  assert.equal(typeof mod.buildPluginHooks, "function")
  assert.equal(typeof mod.loadOfficialCopilotConfig, "function")
  assert.equal("createCopilotRetryingFetch" in mod, false)
})
```

- [ ] **Step 2: 运行测试确认当前导出保持收敛**

Run: `npm run build && node --test test/plugin.test.js`
Expected: PASS；如果 FAIL，必须先明确是哪一步实现被迫要求新增导出，再新增一个独立最小任务去改 `src/index.ts`

- [ ] **Step 3: 若验收测试通过，则不修改 `src/index.ts` 并直接提交测试**

只有当保护测试明确失败且有充分理由时，才修改 `src/index.ts`，并保持新增导出最小化。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/plugin.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/plugin.test.js src/index.ts
git commit -m "test(exports): 锁定超长 input id 修复不扩大公共导出面"
```

### Task 11: 运行完整验证并整理交付说明

**Files:**
- Modify: `README.md`（仅当需要补充 debug/行为说明时）

- [ ] **Step 1: 跑完整验证命令**

Run: `npm test`
Expected: PASS，所有测试通过

- [ ] **Step 2: 做发包产物预检**

Run: `npm pack --dry-run`
Expected: PASS，输出中包含 `dist/`、`README.md`、`LICENSE`，且没有意外遗漏/多余文件

- [ ] **Step 3: 如有必要，补最小文档说明**

仅当行为边界或 debug 日志开关发生了用户可见变化时，补充 `README.md`：
- `OPENCODE_COPILOT_RETRY_DEBUG`
- 日志文件位置
- “只在 400 too long 命中后按项修复”的行为说明

- [ ] **Step 4: 再跑完整验证与发包预检**

Run: `npm test`
Expected: PASS

Run: `npm pack --dry-run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add README.md src test
git commit -m "fix(copilot): 回写会话状态以修复超长 input id 重试"
```

## Chunk 5: Release Preparation

### Task 12: 准备发版提交

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 手工把 `package.json` 版本从 `0.2.6` 改到 `0.2.7`**

先确认工作区干净、测试全绿，再手工修改 `package.json` 中的 `version` 字段。

- [ ] **Step 2: 运行完整验证与发包预检**

Run: `npm test`
Expected: PASS

Run: `npm pack --dry-run`
Expected: PASS，发包清单包含 `dist/`、`README.md`、`LICENSE`

- [ ] **Step 3: 提交 release commit**

```bash
git add package.json
git commit -m "chore(release): 发布 0.2.7 版本"
```

- [ ] **Step 4: 创建 tag 并按仓库 release 流程发布**

Run: `git tag v0.2.7`
Expected: 本地 tag 创建成功

Run: `gh release create v0.2.7 --title "v0.2.7" --notes "- 修复 Copilot input[*].id too long 的会话内按项回写与定向重试\n- 增强超长 input id 的精确诊断日志"`
Expected: GitHub Release 创建成功，并触发 `.github/workflows/release.yml`

发布完成后再做一次：

Run: `npm view opencode-copilot-account-switcher version`
Expected: 返回 `0.2.7`（或与本次发布版本一致）

---

Plan complete and saved to `docs/superpowers/plans/2026-03-14-copilot-input-id-session-repair.md`. Ready to execute?
