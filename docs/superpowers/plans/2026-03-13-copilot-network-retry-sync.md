# Copilot Network Retry Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 GitHub Copilot provider 增加一个默认关闭的可选网络重试开关，在尽量复用官方 request fetch 行为的前提下，对瞬时网络错误与证书类错误做最小范围重试，并建立由脚本生成/校验 upstream `copilot.ts` 快照的同步流程。

**Architecture:** 在仓库中提交一份由脚本生成的官方 `opencode/packages/opencode/src/plugin/copilot.ts` 快照文件，生成脚本负责自动拉取/读取 upstream 源文件，并按固定规则注入来源注释、单一 `LOCAL_SHIMS` 区块和显式导出入口，避免手工编辑影响快照内容。运行时仅在开关开启时通过我们自己的 `auth.loader` 覆盖 `provider.options.fetch`，先调用快照适配层生成与 upstream 一致的 `baseURL` / `apiKey` / `fetch`，再在最后一跳叠加窄范围 retry/backoff。同步脚本同时提供 check 模式，对比本地快照与 upstream 源文件差异，降低行为漂移风险。

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin hooks, GitHub Copilot auth loader, 本地同步检查脚本

---

## Execution Notes

- 当前测试从 `dist/` 导入构建产物，因此所有测试步骤都必须先运行 `npm run build`，再执行对应的 `node --test ...`。
- `src/upstream/copilot-plugin.snapshot.ts` 是脚本生成产物，不允许手工维护逻辑主体；允许差异仅包括来源注释块、单一 `LOCAL_SHIMS` 区块和脚本追加的显式导出入口。
- 同步脚本必须既支持“写入/刷新 snapshot”，也支持“只检查当前 snapshot 是否与指定 upstream 源一致”的 check 模式。
- retry 仅允许作用于可安全重放的 Copilot 请求；对无法安全重放的 `Request`/body，必须直接透传且不重试。

---

## File Map

- Create: `src/copilot-network-retry.ts`
  - 定义重试错误判定、退避策略、fetch retry 包装器
- Create: `src/upstream/copilot-plugin.snapshot.ts`
  - 由同步脚本生成的官方 `copilot.ts` 快照，保留来源注释与 upstream commit 信息
- Create: `src/upstream/copilot-loader-adapter.ts`
  - 从 snapshot 暴露一个稳定、窄范围的运行时适配 API，返回 `baseURL` / `apiKey` / `fetch`
- Create: `scripts/sync-copilot-upstream.mjs`
  - 拉取/读取 upstream `copilot.ts`、生成 snapshot，并支持 check 模式
- Modify: `src/store.ts`
  - 持久化新开关，例如 `networkRetryEnabled?: boolean`
- Modify: `src/ui/menu.ts`
  - 新增菜单项与风险 hint
- Modify: `src/plugin-actions.ts`
  - 处理新开关 toggle
- Modify: `src/plugin-hooks.ts`
  - 支持在保留现有 `experimental.chat.system.transform` 的同时注入新的 `auth.loader`
- Modify: `src/plugin.ts`
  - 接线新 loader 与菜单状态
- Modify: `src/index.ts`
  - 导出必要测试入口
- Modify: `README.md`
  - 说明新开关、风险提示、行为边界、同步机制概览
- Test: `test/copilot-network-retry.test.js`
  - 覆盖 retry 判定、fetch 包装、开关行为
- Test: `test/store.test.js`
  - 覆盖新字段默认值与持久化兼容性
- Test: `test/menu.test.js`
  - 覆盖菜单项文案、位置、风险提示
- Test: `test/plugin.test.js`
  - 覆盖 plugin hooks 同时暴露 transform 和 auth.loader、开关开启/关闭时的 fetch 覆盖行为

## Chunk 1: Store And Menu Surface

### Task 1: 持久化可选网络重试开关

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.js`

- [ ] **Step 1: 写失败测试，要求新字段默认关闭且兼容旧 store**

在 `test/store.test.js` 新增覆盖：

```js
test("parseStore defaults networkRetryEnabled to false when missing", () => {
  const parsed = parseStore('{"accounts":{}}')
  assert.equal(parsed.networkRetryEnabled, false)
})
```

- [ ] **Step 2: 运行单测确认失败**

Run: `npm run build && node --test test/store.test.js`
Expected: FAIL，提示 `networkRetryEnabled` 缺失或值不匹配

- [ ] **Step 3: 最小实现 store 字段**

在 `src/store.ts`：
- 给 `StoreFile` 增加 `networkRetryEnabled?: boolean`
- 在 `parseStore` 中将缺失值规范化为 `false`
- 保持 `loopSafetyEnabled` 的现有兼容逻辑不变

- [ ] **Step 4: 运行单测确认通过**

Run: `npm run build && node --test test/store.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store.ts test/store.test.js
git commit -m "feat(store): 新增 Copilot 网络重试开关"
```

### Task 2: 在菜单中暴露风险明确的开关

**Files:**
- Modify: `src/ui/menu.ts`
- Modify: `src/plugin-actions.ts`
- Modify: `src/plugin.ts`
- Test: `test/menu.test.js`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写失败测试，定义菜单文案与位置**

在 `test/menu.test.js` 新增：

```js
test("buildMenuItems shows Enable Copilot network retry when disabled", () => {
  const items = buildMenuItems({
    accounts: [],
    refresh: { enabled: false, minutes: 15 },
    lastQuotaRefresh: undefined,
    loopSafetyEnabled: false,
    networkRetryEnabled: false,
  })
  const toggle = items.find((item) => item.label === "Enable Copilot network retry")
  assert.ok(toggle)
  assert.match(toggle?.hint ?? "", /Overrides official fetch/)
})
```

再加位置测试，要求它位于 `Guided Loop Safety` 之后、分隔线之前。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/menu.test.js test/plugin.test.js`
Expected: FAIL，提示菜单项不存在或输入参数不匹配

- [ ] **Step 3: 最小实现菜单与 toggle action**

在 `src/ui/menu.ts`：
- 给 `MenuAction` 增加 `toggle-network-retry`
- 给 `buildMenuItems()` 输入增加 `networkRetryEnabled`
- 新增菜单项，文案示例：`Enable Copilot network retry` / `Disable Copilot network retry`
- hint 明确写风险，例如：`Overrides official fetch path; may drift from upstream`

在 `src/plugin-actions.ts`：
- 扩展 `applyMenuAction()` 处理 `toggle-network-retry`
- 翻转 `store.networkRetryEnabled`

在 `src/plugin.ts`：
- 菜单渲染时传入 `networkRetryEnabled`

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/menu.test.js test/plugin.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/menu.ts src/plugin-actions.ts src/plugin.ts test/menu.test.js test/plugin.test.js
git commit -m "feat(menu): 新增 Copilot 网络重试开关"
```

## Chunk 2: Upstream Snapshot And Adapter

### Task 3: 用脚本生成官方 copilot.ts 快照文件

**Files:**
- Create: `src/upstream/copilot-plugin.snapshot.ts`
- Create: `scripts/sync-copilot-upstream.mjs`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，要求同步脚本生成 snapshot 并暴露官方 loader/fetch 构造入口**

在 `test/copilot-network-retry.test.js` 新增：

```js
test("snapshot exposes official copilot loader factory", async () => {
  const mod = await import("../dist/upstream/copilot-plugin.snapshot.js")
  assert.equal(typeof mod.createOfficialCopilotLoader, "function")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，提示同步脚本、生成标记、模块或导出不存在

- [ ] **Step 3: 创建同步脚本并生成快照文件**

在 `scripts/sync-copilot-upstream.mjs`：
- 支持 `--source <file-or-url>`
- 支持刷新写入 `src/upstream/copilot-plugin.snapshot.ts`
- 支持 check 模式验证当前 snapshot 是否由脚本按固定规则生成
- 统一注入：来源仓库、原始路径、同步日期、upstream commit、单一 `LOCAL_SHIMS` 区块、显式导出入口

在 `src/upstream/copilot-plugin.snapshot.ts`：
- 由脚本生成，不手工维护主体逻辑
- 保留官方 `CopilotAuthPlugin` 主体结构
- 导出一个明确入口，如 `createOfficialCopilotLoader()`

同步边界约束：
- 除来源注释块、编译所需 shim 和脚本追加导出外，不主动手工改写官方逻辑结构
- 所有本地 shim 都集中放在显式标注区域，便于同步脚本剥离后再比较
- 对 snapshot 的任何结构调整都必须先改同步脚本，再重新生成文件

注意：
- 不在这里加 retry 逻辑
- 不混入我们的风险提示或 store 开关逻辑
- 目标是尽量保持可 diff 的“官方快照 + 脚本生成补丁”身份

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/sync-copilot-upstream.mjs src/upstream/copilot-plugin.snapshot.ts test/copilot-network-retry.test.js
git commit -m "feat(upstream): 引入官方 Copilot 插件快照"
```

### Task 4: 从快照中抽出最小适配层

**Files:**
- Create: `src/upstream/copilot-loader-adapter.ts`
- Modify: `src/index.ts`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，锁定稳定适配层契约**

在 `test/copilot-network-retry.test.js` 至少新增这些失败测试：

```js
test("loadOfficialCopilotConfig returns undefined for non oauth auth", async () => {
  const result = await loadOfficialCopilotConfig({
    getAuth: async () => ({ type: "token" }),
  })
  assert.equal(result, undefined)
})

test("loadOfficialCopilotConfig returns baseURL apiKey and fetch for oauth auth", async () => {
  const config = await loadOfficialCopilotConfig({
    getAuth: async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0, enterpriseUrl: "https://ghe.example.com" }),
  })
  assert.equal(config?.baseURL, "https://copilot-api.ghe.example.com")
  assert.equal(config?.apiKey, "")
  assert.equal(typeof config?.fetch, "function")
})

test("loadOfficialCopilotConfig preserves official provider.models mutation semantics", async () => {
  const provider = {
    models: {
      foo: { id: "claude", api: {}, cost: undefined },
    },
  }
  await loadOfficialCopilotConfig({
    getAuth: async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }),
    provider,
  })
  assert.equal(provider.models.foo.api.npm, "@ai-sdk/github-copilot")
  assert.deepEqual(provider.models.foo.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } })
})

test("adapter preserves official header injection", async () => {
  const calls = []
  const config = await loadOfficialCopilotConfig({
    getAuth: async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }),
    baseFetch: async (input, init) => {
      calls.push({ input, init })
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
  })
  await config.fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: { authorization: "bad", "x-api-key": "bad", "x-trace-id": "keep-me" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(calls[0].init.headers.Authorization, "Bearer r")
  assert.equal(calls[0].init.headers["Openai-Intent"], "conversation-edits")
  assert.equal(calls[0].init.headers["x-trace-id"], "keep-me")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，提示适配层不存在或 header 不匹配

- [ ] **Step 3: 实现最小适配层**

在 `src/upstream/copilot-loader-adapter.ts`：
- 包装 snapshot 暴露出的官方 loader/fetch 入口
- 定义插件自有输入/输出类型，不直接 re-export snapshot 内部类型名
- 提供主入口 `loadOfficialCopilotConfig(input)`，精确契约如下：
  - 入参：`getAuth`、可选 `baseFetch`、可选 `provider.models`、可选 `version`
  - 返回：`Promise<{ baseURL?: string; apiKey: string; fetch: (...) => Promise<Response> } | undefined>`
  - `getAuth()` 返回 `undefined` 或 `type !== "oauth"` 时返回 `undefined`
  - `provider.models` 若存在，必须保留官方对 `cost` 与 `api.npm` 的改写语义
  - `baseFetch` 缺失时回退到全局 `fetch`
  - `version` 缺失时回退到 snapshot 默认版本
- `createOfficialFetchAdapter()` 仅可作为 `loadOfficialCopilotConfig()` 的薄封装辅助，不得成为生产代码唯一接入点
- 除该适配层外，其他生产代码不得直接 import `src/upstream/copilot-plugin.snapshot.ts`

在 `src/index.ts`：
- 仅按测试需要 re-export 适配层入口，不 re-export snapshot 内部类型

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/upstream/copilot-loader-adapter.ts src/index.ts test/copilot-network-retry.test.js
git commit -m "feat(upstream): 提取官方 Copilot fetch 适配层"
```

## Chunk 3: Retry Wrapper And Hook Wiring

### Task 5: 实现窄范围 retry/backoff 包装器

**Files:**
- Create: `src/copilot-network-retry.ts`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，定义错误分类与重试次数**

在 `test/copilot-network-retry.test.js` 新增覆盖：

```js
test("retries transient and certificate-like errors up to 3 attempts", async () => {
  let attempts = 0
  const wrapped = createCopilotRetryingFetch(async () => {
    attempts += 1
    if (attempts < 3) throw new Error("unknown certificate")
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  })
  const res = await wrapped("https://api.githubcopilot.com/chat/completions", {})
  assert.equal(res.status, 200)
  assert.equal(attempts, 3)
})
```

再补一组：
- 非 Copilot URL 不重试
- 非瞬时错误不重试
- `AbortError` 不重试
- 不可安全重放的 `Request`/body 不重试

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL

- [ ] **Step 3: 最小实现 retry 包装器**

在 `src/copilot-network-retry.ts`：
- 实现 `isRetryableCopilotFetchError()`
- 纳入错误关键字：
  - `load failed`
  - `failed to fetch`
  - `network request failed`
  - `econnreset`
  - `etimedout`
  - `socket hang up`
  - `unknown certificate`
  - `self signed certificate`
  - `unable to verify the first certificate`
  - `self-signed certificate in certificate chain`
- 实现固定小退避，例如 200ms / 500ms / 1000ms
- 仅对 Copilot chat/responses/models/token 等相关 URL 生效，避免扩大影响面
- 为 `Request` 对象与 body 提供 clone/重建策略；若无法安全重放，则直接透传且不重试

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "feat(fetch): 新增 Copilot 网络重试包装"
```

### Task 6: 用 auth.loader 最小覆盖官方 fetch

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/plugin.ts`
- Modify: `test/plugin.test.js`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写失败测试，要求开关关闭时不覆盖 fetch，开启时覆盖 fetch**

在 `test/plugin.test.js` 新增：

```js
test("plugin auth loader keeps official behavior when network retry is disabled", async () => {
  const plugin = buildPluginHooks({ ... })
  assert.equal(typeof plugin.auth?.loader, "function")
  const options = await plugin.auth.loader(async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 }), {
    models: {},
  })
  assert.equal(typeof options.fetch, "function")
})
```

再补：
- `networkRetryEnabled: false` 时 fetch 不套 retry 包装标记
- `networkRetryEnabled: true` 时 fetch 走 retry 包装
- 现有 `experimental.chat.system.transform` 仍然存在

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/plugin.test.js test/copilot-network-retry.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 hook wiring**

在 `src/plugin.ts` / `src/plugin-hooks.ts`：
- 新增我们自己的 `auth.loader`
- loader 内部：
  - 读取 auth
  - 调用官方快照适配层生成官方 fetch 行为
  - 根据 `store.networkRetryEnabled` 决定是否套 retry 包装
  - 返回 `baseURL` / `apiKey` / `fetch`
- 同时保留现有 `auth.methods` 与 `experimental.chat.system.transform`

注意：
- 不改变现有账号菜单 authorize 逻辑
- 不改变 Guided Loop Safety 开关注入逻辑

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/plugin.test.js test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/plugin.ts src/plugin-hooks.ts test/plugin.test.js test/copilot-network-retry.test.js
git commit -m "feat(plugin): 通过 auth.loader 接入 Copilot 网络重试"
```

## Chunk 4: Sync Script And Docs

### Task 7: 扩展 upstream 快照同步脚本的 check 接口与 package script

**Files:**
- Modify: `scripts/sync-copilot-upstream.mjs`
- Test: `test/copilot-network-retry.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试，锁定脚本生成与 fail-fast 规则**

如果不方便直接用 node:test 执行脚本，可用子进程测试。至少覆盖：

```js
test("sync script reports mismatch when snapshot differs from source", async () => {
  // 写临时文件，执行脚本，断言输出包含 mismatch
})

test("sync script fails fast when loader anchor is missing", async () => {
  // 构造缺失 auth.loader 的 fixture upstream 源，断言脚本非零退出
})

test("sync script fails fast when multiple LOCAL_SHIMS blocks exist in snapshot", async () => {
  // 构造非法 snapshot，check 模式必须失败
})

test("sync script requires upstream commit and sync date for repository snapshot generation", async () => {
  // 正式输出到仓库 snapshot 路径时，缺少任一元数据都必须失败
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL

- [ ] **Step 3: 实现脚本与 package script**

在 `scripts/sync-copilot-upstream.mjs`：
- 支持 `--source <file-or-url>`
- 默认目标是我们本地 snapshot 文件
- 正式生成仓库 snapshot 时，必须要求并记录 `--upstream-commit` 与 `--sync-date`
- 输出：`in-sync` / `mismatch`
- mismatch 时输出简要 diff 摘要或首批差异行
- `--check` 比较对象是“当前 snapshot 全文件内容”与“脚本重新生成结果”是否完全一致
- 依赖固定锚点生成 snapshot；若锚点缺失、重复、无法唯一提取 loader，必须 fail-fast
- 若检测到多个 `LOCAL_SHIMS` 或多个脚本生成导出块，也必须 fail-fast

在 `package.json`：
- 增加 script，例如 `sync:copilot-snapshot` 与 `check:copilot-sync`

标准命令示例：

```bash
node scripts/sync-copilot-upstream.mjs --source <file-or-url> --output src/upstream/copilot-plugin.snapshot.ts --upstream-commit <sha> --sync-date <YYYY-MM-DD>
node scripts/sync-copilot-upstream.mjs --source <file-or-url> --output src/upstream/copilot-plugin.snapshot.ts --upstream-commit <sha> --sync-date <YYYY-MM-DD> --check
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/sync-copilot-upstream.mjs package.json test/copilot-network-retry.test.js
git commit -m "chore(sync): 新增 Copilot upstream 对比脚本"
```

### Task 8: 更新 README 与风险说明

**Files:**
- Modify: `README.md`
- Test: manual verification only

- [ ] **Step 1: 更新 README 的功能说明**

在 English / 中文中都补充：
- 新开关名称
- 默认关闭
- 仅覆盖 Copilot request fetch 路径
- 作用是对网络/证书类瞬时错误做有限重试
- 风险提示：可能与官方后续内部行为产生差异
- 同步机制：仓库内有官方快照与对比脚本

- [ ] **Step 2: 运行最小验证**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部通过

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs(readme): 说明 Copilot 网络重试开关与风险"
```

## Chunk 5: Final Verification

### Task 9: 全量验证并准备交付

**Files:**
- Verify only

- [ ] **Step 1: 运行完整测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 运行构建**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: 手工检查菜单文案与风险提示**

Run: `opencode auth login --provider github-copilot`
Expected:
- 菜单中出现新的网络重试开关
- 默认关闭
- 文案明确风险提示

- [ ] **Step 5: 手工检查同步脚本**

Run: `npm run check:copilot-sync -- --source <upstream-file-or-url> --output src/upstream/copilot-plugin.snapshot.ts --upstream-commit <sha> --sync-date <YYYY-MM-DD>`
Expected:
- 输出 `in-sync` 或 `mismatch`，且信息可读
- 成功时使用的 commit/date 与 snapshot 头部一致

- [ ] **Step 6: 汇报结果并等待下一步**

通过 `question` 工具汇报：
- 计划路径
- worktree 路径
- 测试基线结果
- 是否准备执行
