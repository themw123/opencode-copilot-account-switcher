# Copilot 路由观测与轮换修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Copilot 多账号路由补齐常驻决策观测、修正组内轮换与 rate-limit 切换规则、停止测试污染真实 routing-state，并把 `/copilot-status` 扩展成活跃组与路由组配置视图。

**Architecture:** 保留现有 `active.log` / `snapshot.json` 作为真实路由状态源，只新增一个不参与折叠的 `decisions.log` 记录每次请求的账号选择与未切换原因。把 `load` 从“唯一 session 数”改成“近窗口 `session-touch` 次数”，通过 `touchBuckets` 聚合实现；正常选择时对最小 load 平局做随机打散，rate-limit 替换时把比较条件从 `<` 放宽到 `<=`。`/copilot-status` 继续刷新当前 active quota，但输出扩展为 active quota + 活跃组 + 路由组。

**Tech Stack:** TypeScript、Node.js 文件系统 API、现有 OpenCode plugin hooks、Node test runner

---

## 文件结构与职责

- `src/routing-state.ts`
  - 继续维护 routing-state 目录路径、`active.log` 读写、快照折叠与 compaction。
  - 将快照结构从 `sessions` 升级为 `touchBuckets`，并兼容读取旧 `sessions`。
  - 新增 `decisions.log` append helper，但保持它不参与 snapshot/active/sealed 折叠。
- `src/plugin-hooks.ts`
  - 注入稳定的决策日志记录点。
  - 更新 `chooseCandidateAccount()` 的平局策略与随机源注入。
  - 记录 `touchWriteOutcome`、`switchBlockedBy`、`groupSource`、`reason` 等决策证据。
  - 调整 rate-limit 后替换条件为 `<=`。
  - 统一实际消耗 toast 规则。
- `src/status-command.ts`
  - 在成功状态 toast 中追加活跃组与路由组配置展示。
  - 保持当前 active quota 刷新逻辑不变。
- `test/routing-state.test.js`
  - 覆盖 `touchBuckets` 聚合、旧 `sessions` 兼容、`decisions.log` 不参与折叠。
- `test/plugin.test.js`
  - 覆盖 tie 随机选择、`<=` 切换条件、决策日志字段、实际消耗 toast、默认临时 routing 目录。
- `test/status-command.test.js`
  - 覆盖 `/copilot-status` 展示活跃组和路由组。

### Task 1: 把 routing-state 的负载语义改成 `session-touch` 次数

**Files:**
- Modify: `src/routing-state.ts`
- Test: `test/routing-state.test.js`

- [ ] **Step 1: 先写 `touchBuckets` 聚合失败用例**

```js
test("buildCandidateAccountLoads sums touch buckets within the rolling window", async () => {
  const { buildCandidateAccountLoads } = await import("../dist/routing-state.js")

  const loads = buildCandidateAccountLoads({
    snapshot: {
      accounts: {
        main: { touchBuckets: { "1000": 2, "61000": 3 } },
        alt: { touchBuckets: { "1000": 1 } },
      },
      appliedSegments: [],
    },
    candidateAccountNames: ["main", "alt"],
    now: 61_000,
  })

  assert.equal(loads.get("main"), 5)
  assert.equal(loads.get("alt"), 1)
})

test("readRoutingState converts legacy sessions into touch buckets", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "snapshot.json"), JSON.stringify({
      accounts: {
        main: { sessions: { s1: 60_000, s2: 61_000 } },
      },
      appliedSegments: [],
    }), "utf8")

    const state = await readRoutingState(dir)
    assert.equal(state.accounts.main.touchBuckets[60_000], 2)
  })
})
```

- [ ] **Step 2: 跑 routing-state 测试确认先失败**

Run: `npm test -- --test-name-pattern="touch buckets|legacy sessions"`
Expected: FAIL，提示 `touchBuckets` 结构或兼容读取尚未实现

- [ ] **Step 3: 最小实现 `touchBuckets` 结构与旧快照兼容**

```ts
export type RoutingAccountState = {
  touchBuckets?: Record<string, number>
  lastRateLimitedAt?: number
}

function bucketStart(at: number) {
  return Math.floor(at / 60_000) * 60_000
}

function addTouchBucket(account: RoutingAccountState, at: number) {
  account.touchBuckets ??= {}
  const key = String(bucketStart(at))
  account.touchBuckets[key] = (account.touchBuckets[key] ?? 0) + 1
}
```

- [ ] **Step 4: 更新 `buildCandidateAccountLoads()` 与 compaction**

```ts
for (const [bucket, count] of Object.entries(touchBuckets)) {
  const at = Number(bucket)
  if (Number.isFinite(at) && at >= cutoff) total += count
}
```

- [ ] **Step 5: 跑 routing-state 测试确认通过**

Run: `npm test -- --test-name-pattern="touch buckets|legacy sessions"`
Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add src/routing-state.ts test/routing-state.test.js
git commit -m "feat(routing): 将负载统计改为 session-touch 次数"
```

### Task 2: 为 routing-state 新增常驻轻量 `decisions.log`

**Files:**
- Modify: `src/routing-state.ts`
- Test: `test/routing-state.test.js`

- [ ] **Step 1: 先写 `decisions.log` 不参与折叠的失败用例**

```js
test("readRoutingState ignores decisions log entries", async () => {
  await withRoutingStateDir(async (dir) => {
    await writeFile(path.join(dir, "decisions.log"), `${JSON.stringify({
      type: "route-decision",
      chosenAccount: "main",
      sessionIDPresent: false,
    })}\n`, "utf8")

    const state = await readRoutingState(dir)
    assert.deepEqual(state.accounts, {})
  })
})

test("compactRoutingState does not rotate, fold, or delete decisions log", async () => {
  await withRoutingStateDir(async (dir) => {
    const decisionsFile = path.join(dir, "decisions.log")
    await writeFile(decisionsFile, `${JSON.stringify({ type: "route-decision", at: 100, chosenAccount: "main", sessionIDPresent: true })}\n`, "utf8")

    await compactRoutingState({ directory: dir, now: 200_000 })

    const decisions = await readFile(decisionsFile, "utf8")
    assert.match(decisions, /route-decision/)
  })
})
```

- [ ] **Step 2: 跑 routing-state 测试确认先失败或缺 helper**

Run: `npm test -- --test-name-pattern="decisions log"`
Expected: FAIL，提示缺少 `decisions.log` append/read 约束测试支撑

- [ ] **Step 3: 增加最小 append helper，但不接入折叠逻辑**

```ts
export type RouteDecisionEvent = {
  type: "route-decision"
  at: number
  chosenAccount: string
  sessionIDPresent: boolean
}

export async function appendRouteDecisionEvent(input: { directory: string; event: RouteDecisionEvent }) {
  const file = path.join(input.directory, "decisions.log")
  await defaultRoutingStateIO.mkdir(input.directory, { recursive: true })
  await defaultRoutingStateIO.appendFile(file, `${JSON.stringify(input.event)}\n`, "utf8")
}
```

- [ ] **Step 4: 跑 routing-state 测试确认通过**

Run: `npm test -- --test-name-pattern="decisions log|does not rotate, fold, or delete decisions log"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/routing-state.ts test/routing-state.test.js
git commit -m "feat(routing): 新增决策观测日志"
```

### Task 3: 修正正常选号的 tie 行为并注入可测随机源

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 先写 tie 场景失败用例**

```js
test("plugin auth loader breaks equal-load ties with injected random", async () => {
  const harness = createSessionBindingHarness({
    random: () => 0.9,
    loadCandidateAccountLoads: async () => ({ main: 2, alt: 2 }),
  })

  await harness.sendRequest({ sessionID: "tie-random", initiator: "agent", model: "gpt-5" })
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "alt-refresh")
})
```

- [ ] **Step 2: 跑 plugin 测试确认先失败**

Run: `npm test -- --test-name-pattern="equal-load ties"`
Expected: FAIL，提示当前仍稳定命中数组第一个账号

- [ ] **Step 3: 最小实现可注入随机源与平局随机选择**

```ts
const random = input.random ?? Math.random

function pickLowestWithRandom(candidates: ResolvedModelAccountCandidate[], loads: Map<string, number>, random: () => number) {
  const ranked = [...candidates].sort((a, b) => (loads.get(a.name) ?? 0) - (loads.get(b.name) ?? 0))
  const minimum = loads.get(ranked[0].name) ?? 0
  const tied = ranked.filter((item) => (loads.get(item.name) ?? 0) === minimum)
  return tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]
}
```

- [ ] **Step 4: 跑 plugin 测试确认通过**

Run: `npm test -- --test-name-pattern="equal-load ties"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(router): 在相同负载时随机选择账号"
```

### Task 4: 把 rate-limit 替换门槛从 `<` 改成 `<=`

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 先写 `load` 相等仍可切换的失败用例**

```js
test("switches accounts after rate limit when replacement load equals current load", async () => {
  let now = 1_000_000
  const harness = createSessionBindingHarness({
    now: () => now,
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  await harness.sendRequest({ sessionID: "equal-load-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "equal-load-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  const response = await harness.sendRequest({ sessionID: "equal-load-switch", initiator: "agent", model: "gpt-5" })

  assert.equal(response?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "alt-refresh")
})

test("rate-limit replacement breaks equal-load ties with injected random", async () => {
  let now = 1_200_000
  const harness = createSessionBindingHarness({
    now: () => now,
    random: () => 0.9,
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
        org: {
          touchBuckets: { [String(now - 60_000)]: 1 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    store: {
      active: "main",
      activeAccountNames: ["main", "alt", "org"],
      accounts: {
        main: { name: "main", refresh: "main-refresh", access: "main-access", expires: 0 },
        alt: { name: "alt", refresh: "alt-refresh", access: "alt-access", expires: 0 },
        org: { name: "org", refresh: "org-refresh", access: "org-access", expires: 0 },
      },
    },
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  await harness.sendRequest({ sessionID: "equal-load-random-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "equal-load-random-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  const response = await harness.sendRequest({ sessionID: "equal-load-random-switch", initiator: "agent", model: "gpt-5" })

  assert.equal(response?.status, 200)
  assert.equal(harness.outgoing.at(-1)?.auth?.refresh, "org-refresh")
})
```

- [ ] **Step 2: 跑 plugin 测试确认先失败**

Run: `npm test -- --test-name-pattern="replacement load equals current load|equal-load ties with injected random"`
Expected: FAIL，提示当前逻辑仍卡在主账号，或替换候选并列时仍稳定偏向第一个账号

- [ ] **Step 3: 最小实现 `<=` 替换条件**

```ts
.filter((item) => (nextLoads.get(item.name) ?? 0) <= currentLoad)
```

- [ ] **Step 4: 为替换候选并列最小负载场景接入随机打散**

```ts
const replacementTied = replacements.filter((item) => (nextLoads.get(item.name) ?? 0) === minimumReplacementLoad)
const replacement = replacementTied[Math.min(replacementTied.length - 1, Math.floor(random() * replacementTied.length))]
```

- [ ] **Step 5: 跑 plugin 测试确认通过**

Run: `npm test -- --test-name-pattern="replacement load equals current load|equal-load ties with injected random"`
Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "fix(router): 放宽限流切换的负载比较门槛"
```

### Task 5: 为每次请求写入决策证据与未切换原因

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/routing-state.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 先写决策日志失败用例**

```js
test("records route decisions with touch outcome and switch blocked reason", async () => {
  const decisions = []
  const harness = createSessionBindingHarness({
    appendRouteDecisionEventImpl: async (input) => decisions.push(input.event),
    loadCandidateAccountLoads: async () => ({ main: 0, alt: 0 }),
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: {} },
        alt: { touchBuckets: {}, lastRateLimitedAt: Date.now() - 60_000 },
      },
      appliedSegments: [],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  await harness.sendRequest({ sessionID: "decision-1", initiator: "agent", model: "gpt-5" })
  assert.equal(decisions.length >= 1, true)
  assert.equal(typeof decisions[0]?.sessionIDPresent, "boolean")
  assert.match(String(decisions[0]?.touchWriteOutcome), /written|throttled|failed|skipped/)
})
```

- [ ] **Step 2: 跑 plugin 测试确认先失败**

Run: `npm test -- --test-name-pattern="route decisions"`
Expected: FAIL，提示尚未记录决策事件

- [ ] **Step 3: 在 `plugin-hooks` 中最小接入决策事件记录**

```ts
await appendRouteDecisionEventImpl({
  directory: routingDirectory,
  event: {
    type: "route-decision",
    at: requestAt,
    modelID,
    sessionID,
    sessionIDPresent: sessionID.length > 0,
    groupSource: resolved.source,
    candidateNames: candidates.map((item) => item.name),
    loads: Object.fromEntries(loads.entries()),
    chosenAccount: resolved.name,
    reason,
    switched: false,
    touchWriteOutcome,
  },
}).catch(() => undefined)
```

- [ ] **Step 4: 为“未切换”路径补上 `switchBlockedBy`**

Run: `npm test -- --test-name-pattern="route decisions|blocked reason"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin-hooks.ts src/routing-state.ts test/plugin.test.js
git commit -m "feat(router): 记录账号路由决策日志"
```

### Task 6: 统一“每次实际消耗都 toast”的规则

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 先写实际消耗 toast 失败用例**

```js
test("shows a toast for each actual account consumption with a reason", async () => {
  const toasts = []
  const harness = createSessionBindingHarness({
    client: {
      tui: {
        showToast: async (options) => { toasts.push(options) },
      },
    },
  })

  await harness.sendRequest({ sessionID: "toast-regular", initiator: "agent", model: "gpt-5" })
  assert.match(String(toasts.at(-1)?.body?.message ?? ""), /已使用|常规请求|子代理请求/)
})

test("uses a single warning toast for rate-limit switch consumption", async () => {
  const toasts = []
  let now = 1_500_000
  const harness = createSessionBindingHarness({
    now: () => now,
    client: {
      tui: {
        showToast: async (options) => { toasts.push(options) },
      },
    },
    readRoutingStateImpl: async () => ({
      accounts: {
        main: { touchBuckets: { [String(now - 60_000)]: 1 } },
        alt: {
          touchBuckets: { [String(now - 60_000)]: 0 },
          lastRateLimitedAt: now - 11 * 60 * 1000,
        },
      },
      appliedSegments: [],
    }),
    fetchImpl: async ({ auth }) => auth?.refresh === "main-refresh"
      ? new Response(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  await harness.sendRequest({ sessionID: "toast-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "toast-switch", initiator: "agent", model: "gpt-5" })
  now += 60_000
  await harness.sendRequest({ sessionID: "toast-switch", initiator: "agent", model: "gpt-5" })

  const warnings = toasts.filter((item) => item?.body?.variant === "warning")
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0]?.body?.message ?? ""), /已切换到 alt|限流后切换/)
})
```

- [ ] **Step 2: 跑 plugin 测试确认先失败**

Run: `npm test -- --test-name-pattern="actual account consumption|warning toast"`
Expected: FAIL，提示当前普通请求没有消费 toast 或切换场景 toast 语义不统一

- [ ] **Step 3: 最小实现统一 toast 规则**

```ts
const reasonLabel = initiator === "agent"
  ? "子代理请求"
  : allowReselect
    ? "用户回合重选"
    : "常规请求"

await showStatusToast({
  client: input.client,
  message: `已使用 ${resolved.name}（${reasonLabel}）`,
  variant: "info",
  warn,
}).catch(() => undefined)
```

- [ ] **Step 4: 跑 plugin 测试确认通过**

Run: `npm test -- --test-name-pattern="actual account consumption|warning toast"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(toast): 为每次账号消耗显示原因提示"
```

### Task 7: 把 `/copilot-status` 扩展成活跃组与路由组配置视图

**Files:**
- Modify: `src/status-command.ts`
- Test: `test/status-command.test.js`

- [ ] **Step 1: 先写状态展示失败用例**

```js
test("status command success toast includes active group and route group", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: { tui: { showToast: async (options) => calls.push(options) } },
      loadStore: async () => ({
        active: "alice",
        activeAccountNames: ["alice", "bob"],
        modelAccountAssignments: { "gpt-5.4": ["carol", "dave"] },
        accounts: {
          alice: { name: "alice", refresh: "r", access: "a", expires: 0 },
          bob: { name: "bob", refresh: "r2", access: "a2", expires: 0 },
          carol: { name: "carol", refresh: "r3", access: "a3", expires: 0 },
          dave: { name: "dave", refresh: "r4", access: "a4", expires: 0 },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: { updatedAt: 123, snapshots: { premium: { remaining: 1, entitlement: 10 } } },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  assert.match(calls.at(-1)?.body?.message ?? "", /活跃组|alice, bob/i)
  assert.match(calls.at(-1)?.body?.message ?? "", /路由组|gpt-5\.4/i)
})
```

- [ ] **Step 2: 跑 status 测试确认先失败**

Run: `npm test -- --test-name-pattern="active group and route group"`
Expected: FAIL，提示成功 toast 仍只展示单账号 quota

- [ ] **Step 3: 最小实现配置视图拼装**

```ts
function formatGroups(store: StoreFile) {
  const activeGroup = store.activeAccountNames?.length ? store.activeAccountNames.join(", ") : "none"
  const routeGroup = Object.entries(store.modelAccountAssignments ?? {})
    .map(([modelID, names]) => `${modelID} -> ${names.join(", ")}`)
    .join(" ; ") || "none"
  return { activeGroup, routeGroup }
}
```

- [ ] **Step 4: 跑 status 测试确认通过**

Run: `npm test -- --test-name-pattern="active group and route group|status command success"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/status-command.ts test/status-command.test.js
git commit -m "feat(status): 展示活跃组与路由组配置"
```

### Task 8: 让测试 harness 默认隔离 routing-state 目录

**Files:**
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 先写默认临时目录失败用例**

```js
test("createSessionBindingHarness defaults to a temp routing directory", async () => {
  const touched = []
  const harness = createSessionBindingHarness({
    appendSessionTouchEventImpl: async (input) => {
      touched.push(input.directory)
      return true
    },
  })

  await harness.sendRequest({ sessionID: "temp-dir", initiator: "agent", model: "gpt-5" })
  assert.match(String(touched[0] ?? ""), /routing-state-/i)
})
```

- [ ] **Step 2: 跑 plugin 测试确认先失败**

Run: `npm test -- --test-name-pattern="temp routing directory"`
Expected: FAIL，提示 harness 仍回落到真实 `routingStatePath()`

- [ ] **Step 3: 最小实现临时目录注入**

```js
const routingStateDirectory = input.routingStateDirectory ?? await mkdtemp(path.join(os.tmpdir(), "routing-state-"))
```

- [ ] **Step 4: 跑 plugin 测试确认通过**

Run: `npm test -- --test-name-pattern="temp routing directory"`
Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add test/plugin.test.js
git commit -m "test(router): 隔离测试 routing-state 目录"
```

### Task 9: 跑完整验证并整理实现前证据

**Files:**
- Modify: `docs/superpowers/plans/2026-03-19-copilot-routing-observability-rotation-fix.md`（仅在需要补充核对说明时）

- [ ] **Step 1: 运行 targeted tests**

Run: `npm test -- --test-name-pattern="touch buckets|decisions log|equal-load ties|replacement load equals current load|actual account consumption|active group and route group|temp routing directory"`
Expected: PASS

- [ ] **Step 2: 手工核对 `active.log` 与 `decisions.log`**

Run: 手动发起 1-2 次真实 Copilot 请求后，对照 `~/.local/share/opencode/copilot-routing-state/active.log` 与 `~/.local/share/opencode/copilot-routing-state/decisions.log`
Expected: 当 `decisions.log` 中某条记录的 `touchWriteOutcome = "written"` 时，`active.log` 中应存在对应 `session-touch`

- [ ] **Step 3: 运行完整测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 运行类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交收尾验证变更（若有）**

```bash
git add .
git commit -m "test(router): 补齐路由观测与轮换修正验证"
```
