# Codex 独立菜单与多账号切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 OpenAI/Codex provider 增加独立菜单、多账号登录与账号切换能力，并让 `openai` 入口直接进入 Codex 菜单、`GitHub Copilot` 入口继续直接进入 Copilot 菜单。

**Architecture:** 保持 Codex 与 Copilot 菜单入口独立，但把当前 `src/plugin.ts` 里的 Copilot 菜单主循环抽成共享 runtime。Copilot 与 Codex 通过 provider adapter 注入差异：auth provider id、store、OAuth 登录、snapshot 刷新、菜单能力裁剪与切换行为。入口装配上，`github-copilot` 只挂 Copilot 菜单，`openai` 直接挂 Codex 菜单；Codex 继续沿用 OpenAI OAuth 与 `/codex-status` 现有 status/snapshot 路径，不接入 Copilot routing 或 model assignment 语义。

**Tech Stack:** TypeScript、Node 内置 `node:test`、现有 OpenCode plugin SDK、现有 `src/ui/menu.ts` / `src/plugin-actions.ts` / `src/codex-status-command.ts` / `src/codex-store.ts`

---

## 文件结构

### 新建文件

- `src/menu-runtime.ts`
  - 共享菜单 runtime；封装 bootstrap、菜单循环、通用 action、auto refresh 调度。
- `src/providers/copilot-menu-adapter.ts`
  - 把当前 Copilot `runMenu()` 中的 provider-specific 逻辑挪成 adapter。
- `src/providers/codex-menu-adapter.ts`
  - Codex provider adapter；负责 `openai` auth bootstrap、OAuth 登录、snapshot 刷新、切换账号。
- `test/menu-runtime.test.js`
  - 共享 runtime 的合同测试。
- `test/codex-menu-adapter.test.js`
  - Codex adapter 的新增行为测试。

### 重点修改文件

- `src/plugin.ts`
  - 移除硬编码 Copilot `runMenu()` 大循环，改为调用共享 runtime + Copilot adapter，并把 `openai` provider 装配到 Codex 菜单入口。
- `src/ui/menu.ts`
  - 支持 provider-specific 菜单能力裁剪与文案，不再默认渲染全部 Copilot 动作。
- `src/plugin-actions.ts`
  - 保留全局开关型 action，避免把 provider-specific 行为塞进共享 action 文件。
- `src/codex-store.ts`
  - 从单账号快照结构升级为多账号池结构，并保留旧结构读取兼容。
- `src/codex-status-command.ts`
  - 通过统一 store helper 读写新旧 Codex store；必要时补共享 snapshot 写入入口。
- `src/providers/descriptor.ts`
  - 给 Codex provider 补齐菜单能力入口。
- `src/providers/registry.ts`
  - 打开或接通 Codex provider 的菜单装配路径。
- `test/plugin.test.js`
  - Copilot 菜单/装配回归测试继续放这里。
- `test/store.test.js`
  - 如共享 store helper 变化影响 Copilot store，补充回归。
- `test/codex-store.test.js`
  - 补 Codex store 迁移与新结构持久化测试。

---

### Task 1: 抽共享菜单 runtime 合同与最小骨架

**Files:**
- Create: `src/menu-runtime.ts`
- Create: `test/menu-runtime.test.js`
- Modify: `src/plugin.ts`

- [ ] **Step 1: 写共享 runtime 的失败测试**

```js
test("menu runtime bootstraps auth import only once when store is empty", async () => {})
test("menu runtime handles switch/remove/remove-all via shared flow", async () => {})
test("menu runtime only triggers auto refresh when interval elapses", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/menu-runtime.test.js`
Expected: FAIL，提示 `menu-runtime` 未实现或导出缺失。

- [ ] **Step 3: 在 `src/menu-runtime.ts` 写最小类型与骨架**

```ts
export type ProviderMenuAdapter = {
  key: string
  loadStore: () => Promise<unknown>
  writeStore: (store: unknown, meta?: unknown) => Promise<void>
  bootstrapAuthImport: (store: unknown) => Promise<boolean>
  authorizeNewAccount: () => Promise<unknown>
  refreshSnapshots: (store: unknown) => Promise<void>
  toMenuInfo: (store: unknown) => Promise<AccountInfo[]>
  switchAccount: (entry: unknown) => Promise<void>
  applyAction?: (ctx: unknown) => Promise<boolean>
}

export async function runProviderMenu() {
  throw new Error("not implemented")
}
```

- [ ] **Step 4: 最小实现 bootstrap / 菜单循环 / 通用 action 顺序**

```ts
if (await adapter.bootstrapAuthImport(store)) {
  await adapter.writeStore(store, meta)
}
```

- [ ] **Step 5: 运行聚焦测试确认转绿**

Run: `node --test test/menu-runtime.test.js`
Expected: PASS

---

### Task 2: 把菜单 UI 改成 provider 能力裁剪模式

**Files:**
- Modify: `src/ui/menu.ts`
- Test: `test/menu.test.js`

- [ ] **Step 1: 写失败测试覆盖 Copilot/Codex 菜单项裁剪**

```js
test("buildMenuItems hides Copilot-only actions for Codex provider", async () => {})
test("buildMenuItems keeps existing Copilot action ordering unchanged", async () => {})
test("showAccountActions keeps Codex account submenu free of Copilot-only wording", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/menu.test.js`
Expected: FAIL，Codex 仍出现 Copilot 专属动作。

- [ ] **Step 3: 给 `buildMenuItems()` 增加 provider capabilities 输入**

```ts
buildMenuItems({
  provider: "codex",
  capabilities: { loopSafety: false, networkRetry: false, modelGroups: false },
})
```

- [ ] **Step 4: 保持 Copilot 排序与中文文案不回退**

```ts
const actions = input.provider === "codex" ? codexActions : copilotActions
```

- [ ] **Step 5: 运行聚焦测试确认转绿**

Run: `node --test test/menu.test.js`
Expected: PASS

---

### Task 3: 把 Copilot 迁移到 adapter，但保持现有行为不变

**Files:**
- Create: `src/providers/copilot-menu-adapter.ts`
- Modify: `src/plugin.ts`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试覆盖 Copilot 仍走原有切换/导入/刷新行为**

```js
test("copilot menu runtime keeps switch-account behavior after adapter migration", async () => {})
test("copilot menu runtime keeps import-auth bootstrap behavior", async () => {})
test("copilot menu runtime keeps quota refresh, models refresh, and debug meta writes", async () => {})
test("copilot menu runtime keeps existing menu toggle actions", async () => {})
```

- [ ] **Step 2: 运行聚焦测试确认红灯**

Run: `node --test test/plugin.test.js --test-name-pattern "copilot menu runtime|switch-account|import-auth"`
Expected: FAIL，说明 `plugin.ts` 仍依赖旧的硬编码 `runMenu()`。

- [ ] **Step 3: 把 `plugin.ts` 的 Copilot provider-specific 逻辑搬进 adapter**

```ts
export function createCopilotMenuAdapter(input: { client: AuthClient }) {
  return {
    key: "copilot",
    bootstrapAuthImport,
    authorizeNewAccount,
    refreshSnapshots,
    switchAccount,
    toMenuInfo,
  }
}
```

- [ ] **Step 4: 让 `plugin.ts` 改为调用共享 runtime + Copilot adapter**

```ts
const adapter = createCopilotMenuAdapter({ client })
const entry = await runProviderMenu({ adapter, showMenu })
```

- [ ] **Step 5: 运行 Copilot 回归测试确认转绿**

Run: `node --test test/plugin.test.js`
Expected: PASS

---

### Task 4: 升级 `codex-store` 到多账号池，并保留旧结构兼容

**Files:**
- Modify: `src/codex-store.ts`
- Modify: `test/codex-store.test.js`
- Modify: `src/codex-status-command.ts`

- [ ] **Step 1: 先写 store 迁移失败测试**

```js
test("codex store upgrades legacy single-snapshot data into default account entry", async () => {})
test("codex store preserves bootstrap import markers in multi-account shape", async () => {})
test("codex store marks bootstrapAuthImportTried even when auth.json has no importable openai account", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/codex-store.test.js`
Expected: FAIL，旧结构无法提升或新字段被丢弃。

- [ ] **Step 3: 在 `src/codex-store.ts` 加兼容 reader 与新结构 writer**

```ts
if (!source.accounts && source.activeAccountId) {
  return {
    accounts: {
      imported: { ...legacySnapshot }
    },
    active: "imported",
  }
}
```

- [ ] **Step 4: 让 `codex-status-command` 通过统一 helper 读写新旧结构**

```ts
const store = await readCodexStore()
const next = upsertCodexSnapshot(store, snapshot)
```

- [ ] **Step 5: 运行聚焦测试确认转绿**

Run: `node --test test/codex-store.test.js test/codex-status-command.test.js --test-name-pattern "codex store|legacy|snapshot"`
Expected: PASS

---

### Task 5: 实现 Codex adapter 的 bootstrap / OAuth / snapshot / switch

**Files:**
- Create: `src/providers/codex-menu-adapter.ts`
- Modify: `src/codex-status-command.ts`
- Modify: `src/codex-status-fetcher.ts`
- Create: `test/codex-menu-adapter.test.js`

- [ ] **Step 1: 写 Codex adapter 失败测试**

```js
test("codex adapter bootstraps openai auth from auth.json only once", async () => {})
test("codex adapter switchAccount writes only to openai provider", async () => {})
test("codex adapter refreshSnapshots maps plan 5h and week into menu info", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/codex-menu-adapter.test.js`
Expected: FAIL，Codex adapter 尚不存在。

- [ ] **Step 3: 实现 `bootstrapAuthImport()` 与 `switchAccount()`**

```ts
await client.auth.set({
  path: { id: "openai" },
  body: { type: "oauth", refresh, access, expires, accountId },
})
```

- [ ] **Step 4: 实现 `authorizeNewAccount()`，复用上游 Codex OAuth 代码**

```ts
const tokens = await runCodexOauth()
return normalizeCodexAccount(tokens)
```

- [ ] **Step 5: 实现 `refreshSnapshots()` / `toMenuInfo()`，复用 `/codex-status` 现有 fetcher 语义**

```ts
const status = await fetchCodexStatus({ oauth, accountId })
entry.snapshot = {
  plan: status.identity.plan,
  usage5h: { remainingPercent: status.windows.primary.remaining },
  usageWeek: { remainingPercent: status.windows.secondary.remaining },
}
```

- [ ] **Step 6: 运行聚焦测试确认转绿**

Run: `node --test test/codex-menu-adapter.test.js test/codex-status-command.test.js test/codex-status-fetcher.test.js`
Expected: PASS

---

### Task 6: 接入 Codex 独立菜单入口并完成整体验证

**Files:**
- Modify: `src/providers/descriptor.ts`
- Modify: `src/providers/registry.ts`
- Modify: `src/plugin.ts`
- Modify: `test/codex-plugin-config.test.js`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试覆盖 provider 入口装配修正**

```js
test("github-copilot auth methods no longer expose Codex menu entry", async () => {})
test("openai auth provider is wired to the Codex menu flow", async () => {})
test("codex menu path does not expose Copilot-only menu actions", async () => {})
test("codex remove and remove-all do not modify Copilot store", async () => {})
```

- [ ] **Step 2: 运行失败测试确认红灯**

Run: `node --test test/codex-plugin-config.test.js test/plugin.test.js --test-name-pattern "codex menu|openai auth|github-copilot auth methods|menu entry"`
Expected: FAIL，当前实现仍把 Codex 挂在 `github-copilot` 的 methods 里，或 `openai` 尚未直接接到 Codex 菜单。

- [ ] **Step 3: 保留 descriptor / registry 能力声明，并修正 provider auth 装配**

```ts
githubCopilot.methods = [copilotMethod]
openai.methods = [codexMethod]
```

- [ ] **Step 4: 让 `plugin.ts` 为 `openai` provider 调用共享 runtime + Codex adapter**

```ts
auth: { provider: "openai", methods: [codexMethod] }
```

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: PASS，0 fail

- [ ] **Step 6: 真实手动验收**

在 OpenCode 里实际打开 Codex provider 菜单并逐项检查：
- 选择 `GitHub Copilot` 后直接进入 Copilot 菜单，不再出现“Copilot / Codex”二级选择
- 选择 `OpenAI` 后直接进入 Codex 菜单
- Codex 菜单首启时会自动导入 `auth.json` 的 `openai`
- 新增账号会走上游 OAuth
- 切换账号只影响 `openai` provider
- 菜单里能看到 `plan / 5h / week` snapshot
- 删除 Codex 账号不会影响 Copilot 账号池

- [ ] **Step 7: 提交实现**

```bash
git add src/menu-runtime.ts src/providers/copilot-menu-adapter.ts src/providers/codex-menu-adapter.ts src/codex-store.ts src/plugin.ts src/ui/menu.ts src/providers/descriptor.ts src/providers/registry.ts test/menu-runtime.test.js test/codex-menu-adapter.test.js test/codex-store.test.js test/codex-plugin-config.test.js test/plugin.test.js
git commit -m "feat(codex): 新增独立菜单与多账号切换能力"
```

---

## 执行备注

- 先抽骨架，再迁 Copilot，再接 Codex，不要反过来做；
- 任何一步只要 Copilot 回归失败，先修回归再继续下一步；
- `codex-store` 迁移 helper 必须被菜单与 `/codex-status` 共用，避免出现两套兼容逻辑；
- Codex adapter 的 `switchAccount()` 测试必须明确断言：不会写 `github-copilot` / `github-copilot-enterprise`。
