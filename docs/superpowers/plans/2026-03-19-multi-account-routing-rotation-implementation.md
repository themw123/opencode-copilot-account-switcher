# Multi-Account Routing Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为插件新增多账号默认组、按模型多账号路由、会话级账号选择与 rate-limit 后切换能力，并保持现有单一当前生效账号兼容。

**Architecture:** 保留 `copilot-accounts.json` 作为配置源，继续让 `active` 承担现有“当前生效账号”语义，同时新增 `activeAccountNames` 与多账号模型路由数组。运行时把会话绑定与 5 分钟滑窗 rate-limit 队列放在 `plugin-hooks` 内存里，把跨实例共享的近 30 分钟会话使用痕迹与 `lastRateLimitedAt` 放进新的 routing-state 目录，采用 `snapshot + active.log + sealed-*.log` 的分段折叠模型。

**Tech Stack:** TypeScript、Node.js 文件系统 API、现有 OpenCode plugin hooks、Node test runner

---

## 文件结构与职责

- `src/store.ts`
  - 扩展 `StoreFile` 结构，保留 `active`，新增 `activeAccountNames`，把 `modelAccountAssignments` 迁移为数组。
  - 负责 parse/migration/read/write 的向后兼容。
- `src/model-account-map.ts`
  - 从“单账号解析”升级为“候选账号组收集、过滤、稳定排序、辅助选择输入”。
- `src/routing-state.ts`（新建）
  - 封装 routing-state 目录路径、快照读取、active/sealed 日志读取、append、轮转、compaction、幂等折叠。
- `src/plugin-hooks.ts`
  - 接入会话级绑定、首次请求选号、新用户轮次重选、rate-limit 检测、三次滑窗标记、自动切换、补偿动作、切换后的 long-id 快速清理入口。
- `src/plugin.ts`
  - 菜单流改成默认组多选与模型路由多选。
  - 保持“手动切换当前生效账号”的现有动作仍能工作。
- `src/plugin-actions.ts`
  - 适配默认组 / 当前生效账号的持久化更新。
- `src/ui/menu.ts`
  - 更新菜单文案、提示文案和多选动作入口。
- `src/ui/select.ts`
  - 复用现有 select 组件；若需要则新增一个最小多选 helper，而不是在 `plugin.ts` 里堆交互逻辑。
- `src/copilot-network-retry.ts`
  - 抽出或暴露 rate-limit 证据识别、切换时 long-id 全量清理的复用入口。
- `test/store.test.js`
  - 验证 store 迁移与兼容。
- `test/model-account-map.test.js`
  - 验证候选账号组与过滤 / 排序 / 回退规则。
- `test/routing-state.test.js`（新建）
  - 验证 routing-state 幂等折叠、读取一致性、轮转和过期清理。
- `test/plugin.test.js`
  - 验证菜单、多账号选择、会话绑定与自动切换。
- `test/copilot-network-retry.test.js`
  - 验证 rate-limit 识别与切换后的 long-id 快速清理回退路径。

### Task 1: 扩展 store 配置结构并锁定迁移行为

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.js`

- [ ] **Step 1: 先写 store 迁移失败用例**

```js
test("parseStore migrates legacy active into activeAccountNames while preserving active", () => {
  const store = parseStore(JSON.stringify({
    active: "main",
    accounts: { main: { name: "main", refresh: "r", access: "a", expires: 0 } },
  }))

  assert.equal(store.active, "main")
  assert.deepEqual(store.activeAccountNames, ["main"])
})

test("parseStore normalizes array model assignments and drops missing accounts", () => {
  const store = parseStore(JSON.stringify({
    active: "main",
    activeAccountNames: ["main", "missing", "main"],
    modelAccountAssignments: { "gpt-5": ["alt", "alt", "missing"] },
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      alt: { name: "alt", refresh: "r2", access: "a2", expires: 0 },
    },
  }))

  assert.deepEqual(store.activeAccountNames, ["main"])
  assert.deepEqual(store.modelAccountAssignments, { "gpt-5": ["alt"] })
})
```

- [ ] **Step 2: 运行 store 测试并确认先失败**

Run: `npm test -- --test-name-pattern="parseStore"`
Expected: FAIL，提示 `activeAccountNames` 或数组映射尚未实现

- [ ] **Step 3: 最小实现 store 迁移与标准化**

```ts
export type StoreFile = {
  active?: string
  activeAccountNames?: string[]
  accounts: Record<string, AccountEntry>
  modelAccountAssignments?: Record<string, string[]>
}

function normalizeAccountNameList(names: unknown, accounts: Record<string, AccountEntry>) {
  if (!Array.isArray(names)) return undefined
  const next = [...new Set(names.filter((item): item is string => typeof item === "string" && !!accounts[item]))].sort((a, b) => a.localeCompare(b))
  return next.length > 0 ? next : undefined
}
```

- [ ] **Step 4: 再跑 store 测试确认通过**

Run: `npm test -- --test-name-pattern="parseStore"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/store.ts test/store.test.js
git commit -m "feat(store): 支持多账号默认组配置"
```

### Task 2: 升级模型账号映射为候选账号组

**Files:**
- Modify: `src/model-account-map.ts`
- Test: `test/model-account-map.test.js`

- [ ] **Step 1: 先写候选账号组解析失败用例**

```js
test("resolveCopilotModelAccounts prefers mapped account group and falls back to activeAccountNames", () => {
  const store = {
    active: "main",
    activeAccountNames: ["main", "fallback"],
    modelAccountAssignments: { "gpt-5": ["alt", "org"] },
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      fallback: { name: "fallback", refresh: "r2", access: "a2", expires: 0 },
      alt: { name: "alt", refresh: "r3", access: "a3", expires: 0 },
      org: { name: "org", refresh: "r4", access: "a4", expires: 0 },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), ["alt", "org"])
  assert.deepEqual(resolveCopilotModelAccounts(store, "o3").map((item) => item.name), ["fallback", "main"])
})

test("resolveCopilotModelAccounts keeps unknown model metadata candidates but excludes explicitly disabled ones", () => {
  const store = {
    active: "main",
    activeAccountNames: ["main", "unknown", "disabled"],
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0, models: { available: ["gpt-5"], disabled: [] } },
      unknown: { name: "unknown", refresh: "r2", access: "a2", expires: 0 },
      disabled: { name: "disabled", refresh: "r3", access: "a3", expires: 0, models: { available: [], disabled: ["gpt-5"] } },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), ["main", "unknown"])
})

test("resolveCopilotModelAccounts excludes accounts whose available list is present but does not include the model", () => {
  const store = {
    active: "main",
    activeAccountNames: ["main", "other-model"],
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0, models: { available: ["gpt-5"], disabled: [] } },
      "other-model": { name: "other-model", refresh: "r2", access: "a2", expires: 0, models: { available: ["o3"], disabled: [] } },
    },
  }

  assert.deepEqual(resolveCopilotModelAccounts(store, "gpt-5").map((item) => item.name), ["main"])
})
```

- [ ] **Step 2: 跑映射测试确认失败**

Run: `npm test -- --test-name-pattern="model account"`
Expected: FAIL，提示仍返回单账号

- [ ] **Step 3: 最小实现候选账号组 API**

```ts
export function resolveCopilotModelAccounts(store: StoreFile, modelID?: string) {
  const names = store.modelAccountAssignments?.[modelID ?? ""] ?? store.activeAccountNames ?? (store.active ? [store.active] : [])
  return [...new Set(names)]
    .filter((name) => !!store.accounts[name])
    .filter((name) => {
      const models = store.accounts[name]?.models
      if (!modelID || !models) return true
      if (models.disabled?.includes(modelID)) return false
      if (models.available?.includes(modelID)) return true
      if (Array.isArray(models.available)) return false
      return true
    })
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, entry: store.accounts[name], source: store.modelAccountAssignments?.[modelID ?? ""]?.includes(name) ? "model" : "active-group" as const }))
}
```

- [ ] **Step 4: 跑映射测试确认通过**

Run: `npm test -- --test-name-pattern="model account"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/model-account-map.ts test/model-account-map.test.js
git commit -m "feat(router): 支持模型候选账号组解析"
```

### Task 3: 适配当前生效账号写回与默认组持久化动作

**Files:**
- Modify: `src/plugin-actions.ts`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 先写 `plugin-actions` 失败用例**

```js
test("persistAccountSwitch keeps active in sync while preserving activeAccountNames", async () => {
  const store = {
    active: "main",
    activeAccountNames: ["main", "alt"],
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0 },
      alt: { name: "alt", refresh: "r2", access: "a2", expires: 0 },
    },
  }

  await persistAccountSwitch({ store, name: "alt", at: 123, writeStore: async () => {} })

  assert.equal(store.active, "alt")
  assert.deepEqual(store.activeAccountNames, ["main", "alt"])
  assert.equal(store.accounts.alt.lastUsed, 123)
})
```

- [ ] **Step 2: 跑 `plugin-actions` 测试确认失败**

Run: `npm test -- --test-name-pattern="persistAccountSwitch keeps active in sync"`
Expected: FAIL，如果实现误改默认组或未覆盖新字段

- [ ] **Step 3: 最小实现默认组 / 当前生效账号兼容写回**

```ts
export async function persistAccountSwitch(input) {
  input.store.active = input.name
  input.store.activeAccountNames = input.store.activeAccountNames?.length ? input.store.activeAccountNames : [input.name]
  input.store.accounts[input.name].lastUsed = input.at
  input.store.lastAccountSwitchAt = input.at
  await input.writeStore(input.store, { reason: "persist-account-switch", source: "persistAccountSwitch", actionType: "switch" })
}
```

- [ ] **Step 4: 跑 `plugin-actions` 测试确认通过**

Run: `npm test -- --test-name-pattern="persistAccountSwitch keeps active in sync"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin-actions.ts test/plugin.test.js
git commit -m "refactor(actions): 兼容默认组与当前生效账号"
```

### Task 4: 新建 routing-state 读写与折叠模块

**Files:**
- Create: `src/routing-state.ts`
- Test: `test/routing-state.test.js`

- [ ] **Step 1: 先写 routing-state 基础失败用例**

```js
test("readRoutingState merges snapshot active and unapplied sealed segments", async () => {
  const state = await readRoutingState(dir)
  assert.equal(state.accounts.main.sessions.s1, 100)
  assert.equal(state.accounts.main.lastRateLimitedAt, 200)
})

test("foldRoutingEvents is idempotent for duplicate session-touch events", async () => {
  const next = foldRoutingEvents(base, [
    { type: "session-touch", accountName: "main", sessionID: "s1", at: 100 },
    { type: "session-touch", accountName: "main", sessionID: "s1", at: 100 },
  ])
  assert.deepEqual(Object.keys(next.accounts.main.sessions), ["s1"])
  assert.equal(next.accounts.main.sessions.s1, 100)
})

test("readRoutingState ignores sealed segments already listed in appliedSegments", async () => {
  const state = await readRoutingState(dir)
  assert.equal(state.accounts.main.sessions.s1, 100)
})

test("readRoutingState recovers from a broken snapshot by replaying logs", async () => {
  const state = await readRoutingState(dir)
  assert.equal(state.accounts.main.lastRateLimitedAt, 200)
})
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `npm test -- --test-name-pattern="routing-state"`
Expected: FAIL，提示模块不存在

- [ ] **Step 3: 最小实现 routing-state 路径、读取、幂等折叠**

```ts
export type RoutingSnapshot = {
  accounts: Record<string, { sessions?: Record<string, number>; lastRateLimitedAt?: number }>
  appliedSegments?: string[]
}

export function foldRoutingEvents(base: RoutingSnapshot, events: RoutingEvent[]) {
  for (const event of events) {
    if (event.type === "session-touch") {
      const current = base.accounts[event.accountName]?.sessions?.[event.sessionID] ?? 0
      base.accounts[event.accountName] ??= {}
      base.accounts[event.accountName].sessions ??= {}
      base.accounts[event.accountName].sessions[event.sessionID] = Math.max(current, event.at)
    }
    if (event.type === "rate-limit-flagged") {
      const current = base.accounts[event.accountName]?.lastRateLimitedAt ?? 0
      base.accounts[event.accountName] ??= {}
      base.accounts[event.accountName].lastRateLimitedAt = Math.max(current, event.at)
    }
  }
  return base
}
```

- [ ] **Step 4: 先写并运行轮转 / compaction / 损坏恢复失败用例**

Run: `npm test -- --test-name-pattern="appliedSegments|broken snapshot|compaction|sealed"`
Expected: FAIL，提示还未实现 `appliedSegments`、原子快照写入或损坏恢复

- [ ] **Step 5: 最小实现轮转、原子快照写入与损坏恢复**

```ts
async function writeSnapshotAtomically(file, snapshot) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(snapshot, null, 2), "utf8")
  await fs.rename(`${file}.tmp`, file)
}

function listUnappliedSegments(files, snapshot) {
  const applied = new Set(snapshot.appliedSegments ?? [])
  return files.filter((name) => !applied.has(name))
}
```

- [ ] **Step 6: 再跑 routing-state 测试确认全部通过**

Run: `npm test -- --test-name-pattern="routing-state|compaction|sealed"`
Expected: PASS，覆盖 `appliedSegments`、损坏快照回退、30 分钟过期清理

- [ ] **Step 7: 提交这一小步**

```bash
git add src/routing-state.ts test/routing-state.test.js
git commit -m "feat(routing-state): 新增路由状态分段日志存储"
```

### Task 5: 为菜单和配置流加入多选默认组与多选模型路由

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/ui/menu.ts`
- Modify: `src/ui/select.ts`
- Modify: `test/plugin.test.js`
- Modify: `test/menu.test.js`

- [ ] **Step 1: 先写菜单与交互失败用例**

```js
test("configureModelAccountAssignments stores multiple selected accounts", async () => {
  const store = {
    active: "main",
    activeAccountNames: ["main"],
    accounts: {
      main: { name: "main", refresh: "r1", access: "a1", expires: 0, models: { available: ["gpt-5"], disabled: [] } },
      alt: { name: "alt", refresh: "r2", access: "a2", expires: 0, models: { available: ["gpt-5"], disabled: [] } },
      org: { name: "org", refresh: "r3", access: "a3", expires: 0, models: { available: ["gpt-5"], disabled: [] } },
    },
  }
  assert.deepEqual(store.modelAccountAssignments["gpt-5"], ["alt", "org"])
})

test("default account group can include multiple accounts", async () => {
  assert.deepEqual(store.activeAccountNames, ["main", "student-2"])
})
```

- [ ] **Step 2: 跑菜单相关测试确认失败**

Run: `npm test -- --test-name-pattern="assign-models|default account group|menu"`
Expected: FAIL，提示仍是单选行为

- [ ] **Step 3: 最小实现多选 helper 与菜单配置流**

```ts
async function selectMany(items, options) {
  const picked = new Set<string>()
  // 复用 select 风格，支持空格切换、回车确认
  return [...picked].sort((a, b) => a.localeCompare(b))
}

store.activeAccountNames = selectedDefaults
store.modelAccountAssignments[modelID] = selectedAccounts
```

- [ ] **Step 4: 跑菜单与插件测试确认通过**

Run: `npm test -- --test-name-pattern="assign-models|default account group|menu"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin.ts src/ui/menu.ts src/ui/select.ts test/plugin.test.js test/menu.test.js
git commit -m "feat(menu): 支持多账号默认组与模型路由"
```

### Task 6: 在 hooks 中实现会话绑定与首次选号

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 先写首次选号与会话复用失败用例**

```js
test("plugin auth loader binds the first real request of a child session to a selected account", async () => {
  const requests = []
  const plugin = createTestPlugin({
    store: buildStore({ active: "main", activeAccountNames: ["main", "alt"] }),
    routingState: buildRoutingState({ main: ["s1", "s2", "s3"], alt: ["s4"] }),
    fetch: async (request) => { requests.push(request); return okJson() },
  })

  await sendCopilotRequest(plugin, { sessionID: "child-1", model: "gpt-5", initiator: "agent" })

  assert.match(requests[0].headers.get("authorization") ?? "", /alt-token/)
})

test("plugin auth loader reuses the bound account for non-user-turn follow-up requests", async () => {
  assert.equal(requests[0].headers.get("authorization"), requests[1].headers.get("authorization"))
})

test("plugin auth loader reselects on a new user turn when current account load exceeds min by 3 or more", async () => {
  assert.match(requests[2].headers.get("authorization") ?? "", /new-low-load-token/)
})
```

- [ ] **Step 2: 跑 hooks 相关测试确认失败**

Run: `npm test -- --test-name-pattern="binds the first real request|reuses the bound account|reselects on a new user turn"`
Expected: FAIL，提示当前只会解析单账号

- [ ] **Step 3: 最小实现会话绑定与负载比较**

```ts
const sessionBindings = new Map<string, { accountName: string }>()

function chooseAccount(input: { candidates: Candidate[]; sessionID: string; loads: Map<string, number>; allowReselect: boolean }) {
  const bound = sessionBindings.get(input.sessionID)
  const ranked = [...input.candidates].sort((a, b) => (input.loads.get(a.name) ?? 0) - (input.loads.get(b.name) ?? 0) || a.name.localeCompare(b.name))
  if (!bound) return ranked[0]
  if (!input.allowReselect) return input.candidates.find((item) => item.name === bound.accountName) ?? ranked[0]
  const currentLoad = input.loads.get(bound.accountName) ?? 0
  const minLoad = input.loads.get(ranked[0].name) ?? 0
  return currentLoad - minLoad < 3 ? (input.candidates.find((item) => item.name === bound.accountName) ?? ranked[0]) : ranked[0]
}
```

- [ ] **Step 4: 跑 hooks 测试确认通过**

Run: `npm test -- --test-name-pattern="binds the first real request|reuses the bound account|reselects on a new user turn"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(router): 新增会话级账号选择与复用"
```

### Task 7: 接入 routing-state 的近 30 分钟统计与 1 分钟节流写入

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/routing-state.ts`
- Modify: `test/plugin.test.js`
- Modify: `test/routing-state.test.js`

- [ ] **Step 1: 先写节流与负载读取失败用例**

```js
test("session-touch writes are throttled to once per minute per account-session pair", async () => {
  const events = []
  const state = createRoutingStateHarness({ append: async (event) => events.push(event) })
  await state.touch("main", "s1", 100)
  await state.touch("main", "s1", 120)
  assert.equal(events.length, 1)
})

test("load comparison counts distinct sessions used within 30 minutes", async () => {
  const loads = buildLoadsFromState({
    main: { s1: 100, s1_dup: 100, s2: 200 },
    alt: { s9: 100 },
  })
  assert.equal(loads.get("main"), 2)
  assert.equal(loads.get("alt"), 1)
})
```

- [ ] **Step 2: 跑相关测试确认失败**

Run: `npm test -- --test-name-pattern="throttled to once per minute|counts distinct sessions"`
Expected: FAIL

- [ ] **Step 3: 最小实现 touch 节流与窗口统计接入**

```ts
const touchKey = `${accountName}:${sessionID}`
const lastWrite = lastTouchWrites.get(touchKey) ?? 0
if (now - lastWrite >= 60_000) {
  await appendRoutingEvent({ type: "session-touch", accountName, sessionID, at: now })
  lastTouchWrites.set(touchKey, now)
}
```

- [ ] **Step 4: 跑相关测试确认通过**

Run: `npm test -- --test-name-pattern="throttled to once per minute|counts distinct sessions"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin-hooks.ts src/routing-state.ts test/plugin.test.js test/routing-state.test.js
git commit -m "feat(router): 接入近30分钟会话负载统计"
```

### Task 8: 识别 rate-limit 并实现三次滑窗正式标记

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Modify: `src/plugin-hooks.ts`
- Modify: `test/copilot-network-retry.test.js`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 先写 rate-limit 证据识别失败用例**

```js
test("detects rate limit from 429 and too_many_requests payloads", async () => {
  assert.deepEqual(detectRateLimit(make429Error({ "retry-after": "12" })), { matched: true, retryAfterMs: 12_000 })
  assert.equal(detectRateLimit(makeJsonError({ type: "error", error: { type: "too_many_requests" } })).matched, true)
  assert.equal(detectRateLimit(makeJsonError({ type: "error", error: { code: "rate_limit_exceeded" } })).matched, true)
})

test("flags account as rate-limited only after three hits within five minutes", async () => {
  // 第三次才写 lastRateLimitedAt
})
```

- [ ] **Step 2: 跑 rate-limit 测试确认失败**

Run: `npm test -- --test-name-pattern="rate limit|three hits within five minutes"`
Expected: FAIL

- [ ] **Step 3: 最小实现 rate-limit 归一化与滑窗计数**

```ts
function detectRateLimit(error) {
  if (error?.status === 429) return { matched: true, retryAfterMs: parseRetryAfter(error.headers) }
  if (payload?.error?.type === "too_many_requests") return { matched: true, retryAfterMs: parseRetryAfter(error.headers) }
  if (String(payload?.error?.code ?? "").includes("rate_limit")) return { matched: true, retryAfterMs: parseRetryAfter(error.headers) }
  return { matched: false }
}

const queue = pruneOld(rateLimitQueues.get(accountName) ?? [], now - 5 * 60_000)
queue.push(now)
rateLimitQueues.set(accountName, queue)
if (queue.length >= 3) await appendRoutingEvent({ type: "rate-limit-flagged", accountName, at: now, retryAfterMs })
```

- [ ] **Step 4: 跑 rate-limit 测试确认通过**

Run: `npm test -- --test-name-pattern="rate limit|three hits within five minutes"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/copilot-network-retry.ts src/plugin-hooks.ts test/copilot-network-retry.test.js test/plugin.test.js
git commit -m "feat(router): 新增rate-limit检测与滑窗标记"
```

### Task 9: 实现 fail-open、错误提示、自动切换与 long-id 快速清理闭环

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/routing-state.ts`
- Modify: `test/plugin.test.js`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 先写 fail-open、自动切换和 long-id 快速路径失败用例**

```js
test("switches to a lower-load account whose lastRateLimitedAt is older than ten minutes", async () => {
  assert.equal(toasts.at(-1)?.message, "已切换到 alt")
  assert.equal(cleanupCalls.length, 1)
  assert.match(retriedRequest.headers.get("authorization") ?? "", /alt-token/)
})

test("keeps current account when no better candidate exists", async () => {
  await assert.rejects(runRequest(), /Too Many Requests/)
})

test("fails open when routing-state read fails during candidate selection", async () => {
  const response = await runRequestWithBrokenRoutingState()
  assert.equal(response.status, 200)
})

test("surfaces a clear error when an explicit model group has no usable accounts", async () => {
  await assert.rejects(runRequest(), /No usable account for model gpt-5/)
})

test("falls back to existing targeted cleanup when bulk cleanup cannot patch session state", async () => {
  assert.equal(targetedCleanupCalls.length, 1)
})
```

- [ ] **Step 2: 跑闭环测试确认失败**

Run: `npm test -- --test-name-pattern="lower-load account|no better candidate|fails open when routing-state read fails|explicit model group has no usable accounts|bulk cleanup cannot patch session state"`
Expected: FAIL

- [ ] **Step 3: 最小实现 fail-open、候选替换、补偿动作和 bulk cleanup 闭环**

```ts
const replacement = rankedCandidates.find((item) => item.name !== current && cooldownOk(item) && load(item) < load(current))
if (replacement) {
  const cleaned = await cleanupAllLongIdsBeforeSwitch(ctx)
  sessionBindings.set(sessionID, { accountName: replacement.name })
  await showStatusToast({ client, message: `已切换到 ${replacement.name}` })
  await triggerBillingCompensation(replacement)
}
```

- [ ] **Step 4: 跑闭环测试确认通过**

Run: `npm test -- --test-name-pattern="lower-load account|no better candidate|fails open when routing-state read fails|explicit model group has no usable accounts|bulk cleanup cannot patch session state"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin-hooks.ts src/routing-state.ts src/copilot-network-retry.ts test/plugin.test.js test/copilot-network-retry.test.js
git commit -m "feat(router): 完成自动切换与补偿重试闭环"
```

### Task 10: 强化并发 / 平台测试与全量回归

**Files:**
- Modify: `src/routing-state.ts`
- Modify: `src/plugin-hooks.ts`（如并发恢复暴露点需要调整）
- Modify: `test/routing-state.test.js`
- Modify: `docs/superpowers/specs/2026-03-19-multi-account-routing-rotation-design.md`（仅当实现偏离 spec 时）

- [ ] **Step 1: 先写并发与平台分支失败用例**

```js
test("append and rotate racing together do not drop a session-touch event", async () => {
  const state = await runAppendRotateRace()
  assert.equal(state.accounts.main.sessions.s1, 100)
})

test("compaction does not double-apply a sealed segment already recorded in appliedSegments", async () => {
  const state = await runCompactionReplay()
  assert.equal(Object.keys(state.accounts.main.sessions).length, 1)
})

test("rotate gracefully retries or skips when rename fails on Windows-like handle contention", async () => {
  const result = await runRenameFailureScenario()
  assert.equal(result.recovered, true)
})

test("append retries by reopening active.log after a transient write failure", async () => {
  const result = await runAppendRetryScenario()
  assert.equal(result.eventPersisted, true)
})

test("snapshot.tmp residue is ignored during reads and cleaned on the next compaction", async () => {
  const result = await runSnapshotTmpRecoveryScenario()
  assert.equal(result.state.accounts.main.lastRateLimitedAt, 200)
  assert.equal(result.tmpCleaned, true)
})
```

- [ ] **Step 2: 运行并发测试并确认先失败**

Run: `npm test -- --test-name-pattern="racing together|double-apply|rename fails on Windows-like handle contention|append retries by reopening active.log|snapshot.tmp residue"`
Expected: FAIL

- [ ] **Step 3: 先实现 append 重开重试与 rotate 失败跳过逻辑**

```ts
async function appendWithRetry(event) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await appendToActive(event)
    } catch (error) {
      if (attempt === 2) throw error
      await reopenActiveLog()
    }
  }
}
```

- [ ] **Step 4: 再实现 `snapshot.tmp` 残留忽略与下一次 compaction 清理**

```ts
async function readSnapshot(file) {
  return safeParse(file) ?? { accounts: {}, appliedSegments: [] }
}
```

- [ ] **Step 5: 跑并发 / 平台测试确认通过**

Run: `npm test -- --test-name-pattern="racing together|double-apply|rename fails on Windows-like handle contention|append retries by reopening active.log|snapshot.tmp residue"`
Expected: PASS

- [ ] **Step 6: 运行定向测试集合**

Run: `npm test -- --test-name-pattern="parseStore|model account|routing-state|rate limit|long id|assign-models|default account group|binds the first real request|reuses the bound account|reselects on a new user turn"`
Expected: PASS

- [ ] **Step 7: 运行完整测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 运行类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: 对照 spec 做最终核对**

```md
- 默认组多账号
- 单模型多账号组
- 子代理首次选号
- 主会话新轮次重选
- disabled / unknown 模型过滤细则
- 30 分钟不同 session 计数
- 1 分钟 touch 节流
- 5 分钟滑窗 3 次 rate-limit
- 10 分钟冷却切换
- fail-open 与显式配置错误提示
- routing-state 并集读取
- appliedSegments 不重复折叠
- 并发 append / rotate / read
- long-id 切换快速路径
```

- [ ] **Step 10: 提交整体验收结果**

```bash
git add src/store.ts src/model-account-map.ts src/routing-state.ts src/plugin-hooks.ts src/plugin.ts src/plugin-actions.ts src/ui/menu.ts src/ui/select.ts test/store.test.js test/model-account-map.test.js test/routing-state.test.js test/plugin.test.js test/copilot-network-retry.test.js
git commit -m "feat(router): 支持多账号轮询与自动切换"
```
