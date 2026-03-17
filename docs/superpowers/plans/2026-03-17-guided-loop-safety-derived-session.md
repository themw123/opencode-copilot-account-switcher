# Guided Loop Safety Derived Session Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Guided Loop Safety 在 derived/child session 中自动跳过注入，同时保留现有 compaction bypass 与 fail-open 行为。

**Architecture:** 保持 `experimental.chat.system.transform` 作为唯一注入决策点，在 `src/loop-safety-plugin.ts` 中追加一个可注入的 derived-session 判定回调，并继续优先消费现有 compaction bypass。`src/plugin-hooks.ts` 只负责把 runtime 的 `client.session.get()` 包装成轻量 session lookup 依赖传入 transform，不在 wiring 层承载注入策略语义。

**Tech Stack:** TypeScript, Node.js, OpenCode plugin hooks, Node built-in test runner (`node:test`)

---

## Execution Rules

- 新增行为必须走严格 TDD：先写失败测试，再做最小实现，再跑绿。
- 已存在语义的守护项使用“回归测试”标记：这些测试用于锁定既有 fail-open / short-circuit 行为，预期当前即可 PASS，不属于新增行为的红灯步骤。
- 如果某个标记为“回归测试”的用例意外失败，先把它视为发现了真实回归，再做最小修正；不要把这种意外失败改写成新的需求扩张。

---

## File Map

- Modify: `src/loop-safety-plugin.ts`
  - 为 `createLoopSafetySystemTransform()` 增加 derived-session 判定协作层
  - 保持 `applyLoopSafetyPolicy()`、`isCopilotProvider()` 与 compaction bypass 语义不变
- Modify: `src/plugin-hooks.ts`
  - 通过 `client.session.get()` 接入 session lookup
  - 仅把 `session.parentID` 判定结果传给 loop safety transform
- Test: `test/loop-safety-plugin.test.js`
  - 覆盖 transform 层的 root/child/fail-open/lookup-short-circuit/compaction 优先级
- Test: `test/plugin.test.js`
  - 覆盖 plugin wiring 层的 child-session skip、root-session inject、lookup failure fallback
- Reference: `docs/superpowers/specs/2026-03-17-guided-loop-safety-derived-session-design.md`
  - 规格边界、非目标与测试范围来源

---

## Chunk 1: Transform-Level Derived Session Skip

### Task 1: 先用必然变红的测试锁定 transform 新能力

**Files:**
- Modify: `test/loop-safety-plugin.test.js`
- Reference: `docs/superpowers/specs/2026-03-17-guided-loop-safety-derived-session-design.md`

- [ ] **Step 1: 写一个失败测试，断言 enabled Copilot transform 会调用 derived-session 回调一次，且 root session 仍注入 policy**

在 `test/loop-safety-plugin.test.js` 新增唯一前缀测试名，例如：

```js
test("derived session: enabled Copilot transform checks current session before injecting", async () => {
```

测试内使用：

```js
let calls = 0
const transform = createLoopSafetySystemTransform(
  async () => ({ accounts: {}, loopSafetyEnabled: true }),
  () => false,
  async (sessionID) => {
    calls++
    assert.equal(sessionID, "s1")
    return false
  },
)
```

断言：

```js
assert.equal(calls, 1)
assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
```

当前实现尚未支持第三个参数，这个测试会先红，并且同时锁定“查过之后 root session 仍继续注入”的目标。

- [ ] **Step 2: 写一个失败测试，断言 child/derived session 会跳过注入**

新增第二个唯一前缀测试名，例如：

```js
test("derived session: child session skips loop safety injection", async () => {
```

让第三个回调参数返回 `true`，断言：

```js
assert.deepEqual(output.system, ["base prompt"])
```

这能锁定新增能力的核心行为。

- [ ] **Step 3: 运行聚焦测试，确认当前实现变红**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session:"
```

Expected: FAIL，失败原因应集中在 `createLoopSafetySystemTransform()` 还不支持 derived-session 回调或 child-session skip 行为不匹配，而不是构建错误。

### Task 2: 分步最小修改 transform，实现 derived-session skip

**Files:**
- Modify: `src/loop-safety-plugin.ts`
- Test: `test/loop-safety-plugin.test.js`

- [ ] **Step 1: 为 `createLoopSafetySystemTransform()` 增加可注入的 derived-session 回调参数**

在 `src/loop-safety-plugin.ts` 中扩展签名，允许第三个参数接收类似下面的异步回调：

```ts
(sessionID?: string) => Promise<boolean>
```

要求：

- 默认实现返回 `false`
- 只作为 derived-session 判定协作层，不要把 session SDK 细节直接引入这个文件

- [ ] **Step 2: 先只实现 root/child 两条最小路径，让前两个测试转绿**

这一轮只补最小行为：

1. 读取 store，得到 `enabled`
2. 对 `enabled + Copilot provider` 路径，在 bypass 未命中时调用 derived-session 回调
3. 回调返回 `true` 时跳过注入
4. 回调返回 `false` 时继续注入

这一轮**不要**顺手补：

- 回调抛错的 fail-open
- 非 Copilot 的 lookup short-circuit
- disabled 的 lookup short-circuit
- compaction bypass 命中后的 lookup short-circuit

这样可以保证后续每个红灯测试都还有独立的最小实现空间。

- [ ] **Step 3: 重新运行聚焦测试，确认 GREEN**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session:"
```

Expected: PASS

- [ ] **Step 4: 写一个失败测试，断言 derived-session 回调抛错时 fail open**

新增测试名：

```js
test("derived session: lookup errors fail open and still inject", async () => {
```

让第三个参数 `throw new Error("lookup failed")`，断言 transform 不抛错，且：

```js
assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
```

- [ ] **Step 5: 运行单个测试，确认 RED**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session: lookup errors fail open and still inject$"
```

Expected: FAIL

- [ ] **Step 6: 最小补上 error fallback**

只在 derived-session 回调调用点附近补上最小 `catch` / fail-open 处理，不要重排其它判断。

- [ ] **Step 7: 重新运行单个测试，确认 GREEN**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session: lookup errors fail open and still inject$"
```

Expected: PASS

- [ ] **Step 8: 新增回归测试，先锁住非 Copilot provider 不会触发 derived lookup**

新增测试名：

```js
test("derived session: non-Copilot transforms never check session ancestry", async () => {
```

使用计数器断言：

```js
assert.equal(calls, 0)
assert.deepEqual(output.system, ["base prompt"])
```

- [ ] **Step 9: 运行单个测试，确认 PASS**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session: non-Copilot transforms never check session ancestry$"
```

Expected: PASS

- [ ] **Step 10: 新增回归测试，先锁住 loop safety 关闭时不会触发 derived lookup**

新增测试名：

```js
test("derived session: disabled loop safety never checks session ancestry", async () => {
```

断言 callback 未执行，且 `output.system` 保持 `["base prompt"]`。

- [ ] **Step 11: 运行单个测试，确认 PASS**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session: disabled loop safety never checks session ancestry$"
```

Expected: PASS

- [ ] **Step 12: 新增回归测试，先锁住 compaction bypass 命中时不会再执行 derived lookup**

新增测试名：

```js
test("derived session: compaction bypass short-circuits session ancestry lookup", async () => {
```

让 bypass callback 对当前 `sessionID` 返回 `true`，同时让 derived-session 回调增加计数器。断言：

```js
assert.equal(calls, 0)
assert.deepEqual(output.system, ["base prompt"])
```

- [ ] **Step 13: 运行单个测试，确认 PASS**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session: compaction bypass short-circuits session ancestry lookup$"
```

Expected: PASS

- [ ] **Step 14: 再跑完整 transform 测试文件，确认没有破坏旧行为**

- [ ] **Step 14.5: 新增一条 enterprise 回归测试，确认 derived-session 路径同样适用于 `github-copilot-enterprise`**

测试名：

```js
test("derived session: enterprise Copilot also checks session ancestry before injecting", async () => {
```

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- bypass callback 返回 `false`
- 第三个参数 `isDerivedSession` 记录 `calls++` 并返回 `false`
- transform 输入使用：

```js
{ sessionID: "s-enterprise", model: { providerID: "github-copilot-enterprise" } }
```

核心断言：

```js
assert.equal(calls, 1)
assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
```

实现要求：复用现有 `isCopilotProvider()`，不要手写新的 provider 判断。

- [ ] **Step 14.6: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js --test-name-pattern "^derived session: enterprise Copilot also checks session ancestry before injecting$"
```

Expected: PASS

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js
```

Expected: PASS

- [ ] **Step 15: 提交本任务**

```bash
git add src/loop-safety-plugin.ts test/loop-safety-plugin.test.js
git commit -m "feat(loop-safety): 为派生会话跳过策略注入"
```

---

## Chunk 2: Plugin Wiring For Session Lookup

### Task 3: 先用 plugin 测试锁定 wiring 层 lookup 形状与 child/root 行为

**Files:**
- Modify: `test/plugin.test.js`
- Reference: `docs/superpowers/specs/2026-03-17-guided-loop-safety-derived-session-design.md`

- [ ] **Step 1: 写一个失败测试，断言 child session 会通过 `client.session.get()` 被识别并跳过注入**

在 `test/plugin.test.js` 新增唯一前缀测试名，例如：

```js
test("plugin wiring: child session lookup uses parentID and skips injection", async () => {
```

用数组记录 `client.session.get()` 入参，例如：

```js
const calls = []
get: async (request) => {
  calls.push(request)
  return { data: { parentID: "parent-1" } }
}
```

`buildPluginHooks()` 输入中设置：

- `loadStore()` 返回 `loopSafetyEnabled: true`
- `client.session.get()` 返回 `{ data: { parentID: "parent-1" } }`
- `directory: "/tmp/project"`
- 调用 `plugin["experimental.chat.system.transform"]`

断言 lookup 形状与结果同时正确：

```js
assert.deepEqual(calls, [{
  path: { id: "session-123" },
  query: { directory: "/tmp/project" },
  throwOnError: true,
}])
assert.deepEqual(output.system, ["base prompt"])
```

- [ ] **Step 2: 写一个失败测试，断言 root session 会用同样的 lookup 形状查询当前 session，并继续注入 policy**

新增唯一前缀测试名，例如：

```js
test("plugin wiring: root session lookup keeps injection enabled", async () => {
```

将 `client.session.get()` 改为返回：

```js
{ data: {} }
```

`buildPluginHooks()` 输入同样要显式包含：

```js
directory: "/tmp/project"
```

同样记录并断言 `client.session.get()` 的请求参数精确为：

```js
{
  path: { id: "session-123" },
  query: { directory: "/tmp/project" },
  throwOnError: true,
}
```

然后断言：

```js
assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
```

- [ ] **Step 3: 运行聚焦测试，确认当前实现变红**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring:"
```

Expected: FAIL，原因应是当前 wiring 还没有调用 `client.session.get()`，因此既不会产生预期 lookup 入参，也无法让 child session 跳过注入。

### Task 4: 在 plugin wiring 中分步接入 `session.parentID` 判定

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 在 `buildPluginHooks()` 中封装一个最小 `isDerivedSession()` 回调**

在 `src/plugin-hooks.ts` 中新增一个本地 helper 或内联回调，先只完成“发起 lookup”这一个动作：

- 通过 `input.client?.session?.get?.(...)` 查询当前 `sessionID`
- 请求参数固定为：

```js
{
  path: { id: sessionID },
  query: { directory: input.directory },
  throwOnError: true,
}
```

- 这一小步配合 `Task 3` 已写好的 child/root 红灯测试一起落地；不要再单独新增 shape-only 测试，避免与 `Task 3` 重复

- [ ] **Step 2: 将该回调传给 `createLoopSafetySystemTransform()`，只让 child/root 两个 red 测试转绿**

只改 wiring：

- 不改现有 compaction bypass 接线
- 不改 `chat.headers` 的 synthetic initiator 行为
- 不在 `plugin-hooks.ts` 里直接拼接 `LOOP_SAFETY_POLICY`
- helper 暂时只需让 `parentID` 为非空字符串时返回 `true`，其余返回 `false`

- [ ] **Step 2.1: 先写一个失败测试，断言 `sessionID` 缺失时直接 fail open 且不发起 lookup**

测试名：

```js
test("plugin wiring: missing sessionID falls back to injection", async () => {
```

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- `client.session.get()` 每次被调用时 `calls++`
- `buildPluginHooks()` 显式传入 `directory: "/tmp/project"`
- transform 输入里省略 `sessionID`，仅保留 `model: { providerID: "github-copilot" }`

核心断言：

```js
assert.equal(calls, 0)
assert.deepEqual(output.system, ["base prompt", LOOP_SAFETY_POLICY])
```

- [ ] **Step 2.2: 运行单个测试，确认 RED**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: missing sessionID falls back to injection$"
```

Expected: FAIL

- [ ] **Step 2.3: 最小补上 `sessionID` guard，让缺失时直接返回 `false` 且不调用 `client.session.get()`**

只改 helper 的最前置 guard：

```ts
if (!sessionID) return false
```

不要在这一步扩大到其他新行为。

- [ ] **Step 2.4: 重新运行单个测试，确认 GREEN**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: missing sessionID falls back to injection$"
```

Expected: PASS

实现时直接复用 `Task 3` 的两个失败测试作为验证入口；这两个测试同时锁定：

- `client.session.get()` 的请求形状
- `directory: "/tmp/project"` 会被透传到 `query.directory`
- child/root 的结果分叉

- [ ] **Step 3: 重新运行聚焦测试，确认 GREEN**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring:"
```

Expected: PASS

### Task 5: 回归测试 - wiring 层 fail-open 边界

**Files:**
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 新增回归测试，断言 lookup 抛错时仍回退到现有注入行为**

测试名：

```js
test("plugin wiring: lookup failure falls back to injection", async () => {
```

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- `client.session.get()` 直接 `throw new Error("lookup failed")`
- transform 输入使用 `sessionID: "session-123"` 与 `providerID: "github-copilot"`

核心断言：

- transform 不抛错
- `output.system` 为 `["base prompt", LOOP_SAFETY_POLICY]`

让 `client.session.get()` 抛错，断言 transform 不抛错，且结果仍然注入 policy。

- [ ] **Step 2: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: lookup failure falls back to injection$"
```

Expected: PASS

- [ ] **Step 3: 新增回归测试，断言 `client` 缺失时回退注入**

新增测试名：

```js
test("plugin wiring: client missing falls back to injection", async () => {
```

断言：

- 不抛错
- `output.system` 为 `["base prompt", LOOP_SAFETY_POLICY]`

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- `client` 设为 `undefined`
- transform 输入使用 `sessionID: "session-123"` 与 `providerID: "github-copilot"`

- [ ] **Step 4: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: client missing falls back to injection$"
```

Expected: PASS

- [ ] **Step 5: 新增回归测试，断言 `client.session.get` 缺失时回退注入**

新增测试名：

```js
test("plugin wiring: session.get missing falls back to injection", async () => {
```

断言：

- 不抛错
- `output.system` 为 `["base prompt", LOOP_SAFETY_POLICY]`

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- `client` 设为 `{ session: {} }`
- transform 输入使用 `sessionID: "session-123"` 与 `providerID: "github-copilot"`

- [ ] **Step 6: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: session.get missing falls back to injection$"
```

Expected: PASS

- [ ] **Step 7: 新增回归测试，断言 `get()` 返回 `undefined` 或无 `data` 时回退注入**

新增测试名：

```js
test("plugin wiring: undefined session payload falls back to injection", async () => {
```

断言：

- 不抛错
- `output.system` 为 `["base prompt", LOOP_SAFETY_POLICY]`

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- `client.session.get()` 返回 `undefined`，或返回 `{}`
- transform 输入使用 `sessionID: "session-123"` 与 `providerID: "github-copilot"`

- [ ] **Step 8: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: undefined session payload falls back to injection$"
```

Expected: PASS

### Task 6: 回归测试 - `parentID` 与 `sessionID` 结构边界

**Files:**
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 新增回归测试，断言空字符串 `parentID` 仍注入 policy**

新增测试名：

```js
test("plugin wiring: empty-string parentID still injects policy", async () => {
```

让 `client.session.get()` 返回：

```js
{ data: { parentID: "" } }
```

断言 `output.system` 为 `["base prompt", LOOP_SAFETY_POLICY]`。

- [ ] **Step 2: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: empty-string parentID still injects policy$"
```

Expected: PASS

- [ ] **Step 3: 新增回归测试，断言非字符串 `parentID` 仍注入 policy**

新增测试名：

```js
test("plugin wiring: non-string parentID still injects policy", async () => {
```

让 `client.session.get()` 返回：

```js
{ data: { parentID: 123 } }
```

断言 `output.system` 为 `["base prompt", LOOP_SAFETY_POLICY]`。

- [ ] **Step 4: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: non-string parentID still injects policy$"
```

Expected: PASS

- [ ] **Step 5: 跳过新增测试；`missing sessionID` 已在 Task 4 中作为新增行为走完 TDD**

这里不要重复添加同名测试，避免同一边界被重复覆盖。

### Task 7: 回归测试 - disabled / non-Copilot / compaction 短路

**Files:**
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 新增回归测试，断言 disabled 场景不会执行 session lookup**

新增测试名：

```js
test("plugin wiring: disabled loop safety skips session lookup", async () => {
```

使用计数器断言：

```js
assert.equal(calls, 0)
assert.deepEqual(output.system, ["base prompt"])
```

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: false }`
- `client.session.get()` 每次被调用时 `calls++`
- transform 输入使用 `sessionID: "session-123"` 与 `providerID: "github-copilot"`

- [ ] **Step 2: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: disabled loop safety skips session lookup$"
```

Expected: PASS

- [ ] **Step 3: 新增回归测试，断言非 Copilot 场景不会执行 session lookup**

新增测试名：

```js
test("plugin wiring: non-Copilot transforms skip session lookup", async () => {
```

使用计数器断言：

```js
assert.equal(calls, 0)
assert.deepEqual(output.system, ["base prompt"])
```

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- `client.session.get()` 每次被调用时 `calls++`
- transform 输入使用 `sessionID: "session-123"` 与 `providerID: "google"`

- [ ] **Step 4: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: non-Copilot transforms skip session lookup$"
```

Expected: PASS

- [ ] **Step 5: 新增回归测试，断言 compaction bypass 命中时不会执行 session lookup**

新增测试名：

```js
test("plugin wiring: compaction bypass skips session lookup", async () => {
```

复用插件已有 `experimental.session.compacting` hook，并断言：

```js
assert.equal(calls, 0)
assert.deepEqual(output.system, ["base prompt"])
```

最小 harness：

- `loadStore()` 返回 `{ accounts: {}, loopSafetyEnabled: true }`
- `client.session.get()` 每次被调用时 `calls++`
- 先在同一异步上下文中调用 `plugin["experimental.session.compacting"]({ sessionID: "session-123" }, ...)`
- 再调用 `plugin["experimental.chat.system.transform"]`，输入为 `sessionID: "session-123"` 与 `providerID: "github-copilot"`

- [ ] **Step 6: 运行单个测试，确认 PASS（回归测试）**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring: compaction bypass skips session lookup$"
```

Expected: PASS

- [ ] **Step 7: 跑完整 `plugin wiring:` 测试组，确认所有 wiring 回归都成立**

Run:

```bash
npm run build && node --test test/plugin.test.js --test-name-pattern "^plugin wiring:"
```

Expected: PASS

- [ ] **Step 8: 跑完整 plugin 测试文件，确认无回归**

Run:

```bash
npm run build && node --test test/plugin.test.js
```

Expected: PASS

- [ ] **Step 9: 提交本任务**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(plugin): 为派生会话接入 loop safety 跳过"
```

---

## Chunk 3: Final Verification And Scope Control

### Task 8: 运行最终回归并确认非目标边界没有漂移

**Files:**
- Modify: none
- Test: `test/loop-safety-plugin.test.js`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 运行两个聚焦测试文件**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js test/plugin.test.js
```

Expected: PASS

- [ ] **Step 2: 运行完整测试套件**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 3: 运行类型检查与构建**

Run:

```bash
npm run typecheck && npm run build
```

Expected: PASS

- [ ] **Step 4: 人工核对改动范围**

确认实现代码只涉及：

- `src/loop-safety-plugin.ts`
- `src/plugin-hooks.ts`
- `test/loop-safety-plugin.test.js`
- `test/plugin.test.js`

并明确未新增下列范围外行为：

- 没有尝试解决 root-session `title` / `summary` internal flow 注入
- 没有加入 prompt 文本匹配
- 没有修改 upstream snapshot、README、菜单、store 或网络重试逻辑

- [ ] **Step 5: 人工核对新增测试名与断言范围，确认没有扩大到 root-session internal flow**

逐项检查新增测试与实现说明，只允许出现以下语义：

- `derived session`
- `parentID`
- `session ancestry lookup`
- `compaction bypass`
- `fail open`

明确确认没有新增任何以下内容：

- `title`
- `summary`
- `root internal agent`
- “root session internal flow 自动跳过”之类表述

- [ ] **Step 6: 如需合并实现提交，补一个回归验证提交**

如果前两块已经分别提交，这一步只在确实还有未提交验证性调整时执行；否则留空，不要为了形式新增空提交。

## Final Verification Checklist

- [ ] `npm run build && node --test test/loop-safety-plugin.test.js test/plugin.test.js`
- [ ] `npm test`
- [ ] `npm run typecheck && npm run build`
- [ ] child/derived session 仅凭 `session.parentID` 被识别并跳过注入
- [ ] compaction bypass 仍优先于 derived-session lookup
- [ ] lookup 失败时保持 fail-open，不报错、不默认跳过
- [ ] 非 Copilot provider 与 loop safety disabled 路径不会执行多余 session lookup
- [ ] 文档与测试都没有暗示 root-session internal agent 问题已被解决

## Handoff Notes

- 这是一次最小行为扩展，不要顺手重构 `applyLoopSafetyPolicy()` 或重写 compaction bypass 机制。
- 如果需要新增 helper，优先放在现有文件内部并保持职责单一；不要为这次改动拆出新模块，除非当前文件因此明显失控。
- 测试命名应直接体现 `derived session`、`parentID`、`fail open`、`compaction bypass priority` 等语义，避免将来读测试时误以为本次覆盖了 root-session internal agent。
- 若 reviewer 质疑“为什么不顺手修 title”，请以 spec 为准：当前计划只解决 child/derived session 干扰，root-session internal flow 缺少同等级别的稳定结构信号。
