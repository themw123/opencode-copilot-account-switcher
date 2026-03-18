# 子代理首用账号请求标识修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 Copilot 账号在当前 OpenCode 实例中的首次真实请求，使其在首次且仅首次遇到 `x-initiator: agent` 时移除该标识，后续请求恢复上游默认行为。

**Architecture:** 继续复用 `src/plugin-hooks.ts` 里的 `fetchWithModelAccount()` 作为统一请求出口，但把当前仅在 `resolved.source === "model"` 分支生效的逻辑放宽为“凡是最终能解析到账号的 Copilot 请求都统一走首用判定”。在 `buildPluginHooks()` 闭包内维护进程内 `Set<string>`，按账号名记录是否已经发生过真实请求，并只对首次且 header 为 `agent` 的请求做一次性移除。

**Tech Stack:** TypeScript、Node.js 内置 `node:test`、现有 OpenCode Copilot plugin hooks

---

### Task 1: 先用测试锁定首用行为边界

**Files:**
- Modify: `test/plugin.test.js`
- Reference: `src/plugin-hooks.ts`
- Reference: `docs/superpowers/specs/2026-03-18-subagent-first-use-quota-design.md`

- [ ] **Step 1: 在 `test/plugin.test.js` 现有 initiator 测试附近加入首个失败用例**

```js
test("plugin auth loader removes agent initiator on account first use", async () => {
  const outgoing = []
  const plugin = buildPluginHooks({
    auth: { provider: "github-copilot", methods: [] },
    loadStore: async () => ({
      active: "alice",
      accounts: {
        alice: { name: "alice", refresh: "r1", access: "a1", expires: 0 },
      },
      loopSafetyEnabled: false,
      networkRetryEnabled: false,
    }),
    loadOfficialConfig: async () => ({
      baseURL: "https://api.githubcopilot.com",
      apiKey: "",
      fetch: async (_request, init) => {
        outgoing.push(init?.headers)
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
    }),
  })

  const options = await plugin.auth?.loader?.(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), { models: {} })
  await options?.fetch?.("https://api.githubcopilot.com/responses", {
    method: "POST",
    headers: { "x-initiator": "agent" },
    body: JSON.stringify({ input: [{ role: "user", content: [] }] }),
  })

  assert.equal(outgoing[0]["x-initiator"], undefined)
})
```

- [ ] **Step 2: 补“同账号第二次 agent 请求恢复保留”用例**

```js
test("plugin auth loader preserves agent initiator after same account first use", async () => {})
```

- [ ] **Step 3: 补“不同账号各自独立计算首次”用例**

```js
test("plugin auth loader tracks first use independently per account", async () => {})
```

- [ ] **Step 4: 补“首次 user 请求不改写但会消耗首次机会”用例**

```js
test("plugin auth loader consumes first use without rewriting user initiator", async () => {})
```

- [ ] **Step 5: 补“首次无 x-initiator 也会消耗首次机会”用例**

```js
test("plugin auth loader consumes first use without rewriting missing initiator", async () => {})
```

- [ ] **Step 6: 补“首次走 active fallback 也会消耗首次机会”用例**

```js
test("plugin auth loader consumes first use on active fallback account", async () => {})
```

- [ ] **Step 7: 补“首次发送失败后不回滚首用状态”用例**

```js
test("plugin auth loader does not roll back first use after failed send", async () => {})
```

要求这些测试共同覆盖：

- 首次 `agent` 请求会移除 header
- 同账号第二次 `agent` 请求恢复保留
- 不同账号各自独立计算首次
- 首次 `user` 请求不改写但会消耗首次机会
- 首次无 `x-initiator` 请求不改写但会消耗首次机会
- 首次走 active fallback 而非模型映射时也会消耗首次机会
- 首次发送失败后，后续再次发送会视为非首次

- [ ] **Step 8: 只跑新增相关测试，确认至少一个断言先失败**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "initiator|first use"`
Expected: FAIL，且失败点集中在当前实现仍保留 `x-initiator: agent` 或未覆盖 active fallback。

- [ ] **Step 9: 提交测试基线**

```bash
git add test/plugin.test.js
git commit -m "test(plugin): 覆盖账号首用 initiator 边界"
```

### Task 2: 在统一请求路径里实现按账号的一次性首用抑制

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 在 `buildPluginHooks()` 闭包中增加进程内账号使用状态**

```ts
const usedCopilotAccounts = new Set<string>()
```

把它放在与 `injectArmed`、`policyScopeOverride` 同一层级，确保整个插件实例共享，而不是每次请求重新创建。

- [ ] **Step 2: 提取一个小而明确的 header 修正 helper，避免把判断散落在 fetch 主流程里**

```ts
function omitAgentInitiatorOnFirstUse(input: {
  accountName: string
  headers: HeadersInit | undefined
  used: Set<string>
}) {
  const firstUse = !input.used.has(input.accountName)
  const next = new Headers(input.headers)
  if (firstUse && next.get("x-initiator") === "agent") next.delete("x-initiator")
  input.used.add(input.accountName)
  return next
}
```

实现时保持两点：

- 只有值明确为 `agent` 才删除
- 即使 header 是 `user` 或不存在，也要在首次请求时把账号记入 `usedCopilotAccounts`

- [ ] **Step 3: 改写 `fetchWithModelAccount()`，统一所有已解析到账号的请求路径**

当前代码：

```ts
if (!resolved || resolved.source !== "model") return config.fetch(request, init)
```

目标改成：

```ts
if (!resolved) return config.fetch(request, init)

const auth = {
  type: "oauth",
  refresh: resolved.entry.refresh,
  access: resolved.entry.access,
  expires: resolved.entry.expires,
  enterpriseUrl: resolved.entry.enterpriseUrl,
} satisfies CopilotAuthState

const headers = omitAgentInitiatorOnFirstUse({
  accountName: resolved.name,
  headers: init?.headers,
  used: usedCopilotAccounts,
})

return authOverride.run(auth, () =>
  config.fetch(rewriteRequestForAccount(request, resolved.entry.enterpriseUrl), {
    ...init,
    headers,
  }),
)
```

关键要求：

- `resolved.source === "active"` 也必须走同一套逻辑
- 这里是有意统一 active fallback 与模型映射路径：不仅首用判定统一，active fallback 解析出的账号认证与 enterprise 域名也继续经由同一请求出口处理
- 只改 header，不改 body
- 继续保留账号认证覆写与 enterprise 域名重写
- 不破坏 network retry wrapper 对 fetch 的包裹关系

- [ ] **Step 4: 跑新增测试，确认它们全部转绿**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "initiator|first use"`
Expected: PASS

- [ ] **Step 5: 提交最小实现**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "fix(headers): 修正账号首用请求的 initiator 标识"
```

### Task 3: 做回归验证，确认没有破坏现有插件行为

**Files:**
- Verify: `src/plugin-hooks.ts`
- Verify: `test/plugin.test.js`
- Verify: `package.json`

- [ ] **Step 1: 跑完整插件测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 2: 跑类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 定位受影响的既有 initiator 测试并确认哪些断言需要更新**

重点检查这些既有测试是否需要改名或改期望：

- `plugin auth loader preserves subagent initiator header when network retry is enabled`
- `plugin auth loader preserves subagent initiator header across retry requests`

- [ ] **Step 4: 更新既有 initiator 测试名称或期望，保持断言聚焦“首用一次性抑制后，后续仍保留 header”**

- [ ] **Step 5: 重跑全量测试与类型检查，确认更新后的旧测试也已转绿**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 记录最终验证结果并提交回归修正（若 Task 2 已含所有必要测试更新，可与上一提交合并执行）**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "test(plugin): 校准首用 initiator 回归断言"
```

## 交付检查清单

- [ ] `src/plugin-hooks.ts` 使用进程内 `Set<string>` 跟踪账号首次真实请求
- [ ] 首次且仅首次遇到 `x-initiator: agent` 时移除该 header
- [ ] 首次 `user` 或无 header 请求不改写，但会消耗首次机会
- [ ] `active` fallback 与模型映射账号都走统一判定路径
- [ ] `npm test` 通过
- [ ] `npm run typecheck` 通过
