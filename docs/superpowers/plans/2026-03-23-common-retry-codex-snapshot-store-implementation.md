# Common Retry、Codex Snapshot 与 Store 归一化重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把通用开关从 Copilot 私有实现里抽离，建立 `common + codex + copilot` 三层 retry 结构，为 Codex 增加独立官方 snapshot / loader adapter，并统一 Common/Copilot/Codex store 的路径与迁移规则。

**Architecture:** 保留共享的 `buildPluginHooks` 编排层，但把 provider 官方 fetch、provider fetch enhancer、provider retry enhancer 全部改为 descriptor 注入能力。通用设置进入独立 `settings.json`，Copilot 与 Codex 菜单共享 `通用设置` section；Codex retry 通过自己的官方 snapshot adapter 和自己的 retry policy 接入，不再触达 Copilot adapter / routing / repair 语义。

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin hooks, upstream snapshot sync scripts

---

### Task 1: 拆出统一路径 helper 与独立通用设置 store

**Files:**
- Create: `src/store-paths.ts`
- Create: `src/common-settings-store.ts`
- Modify: `src/store.ts`
- Modify: `src/codex-store.ts`
- Test: `test/store.test.js`
- Test: `test/codex-store.test.js`
- Test: `test/common-settings-store.test.js`

- [ ] **Step 1: 先写失败测试**

在 `test/common-settings-store.test.js` 新增这些用例：
- 旧 Copilot store 中的通用字段会迁移到 `settings.json`；
- 新旧路径同时存在时，新路径优先、旧路径只补缺；
- `experimentalSlashCommandsEnabled` 与 `experimentalStatusSlashCommandEnabled` 同时存在时，以规范字段为准；
- 迁移逻辑幂等，重复启动不会把旧值回灌到新值。

并额外覆盖两类账号级冲突：
- Copilot / Codex 账号新旧文件同时存在时，旧路径绝不覆盖新路径已有账号数据；
- 部分文件已迁移、部分未迁移的混合态能稳定启动并收敛到新路径。

并在 `test/store.test.js`、`test/codex-store.test.js` 增加新路径 helper 相关断言。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `node --test test/common-settings-store.test.js test/store.test.js test/codex-store.test.js`
Expected: 新增用例失败，因为 `store-paths` / `common-settings-store` 还不存在，旧 store 也还未抽离通用字段。

- [ ] **Step 3: 做最小实现**

实现下列边界：
- `src/store-paths.ts` 统一返回
  - `~/.config/opencode/account-switcher/settings.json`
  - `~/.config/opencode/account-switcher/copilot-accounts.json`
  - `~/.config/opencode/account-switcher/codex-accounts.json`
- `src/common-settings-store.ts` 维护通用设置 schema、读写、legacy 归一化与旧 Copilot store 抽取迁移；
- `src/store.ts` 改为只维护 Copilot 账号与 Copilot 专属字段；
- `src/codex-store.ts` 改为走统一路径 helper；
- 新旧账号文件同时存在时，账号级数据始终以新路径为准；
- 新写入只写新路径，不再回写 legacy 字段。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `node --test test/common-settings-store.test.js test/store.test.js test/codex-store.test.js`
Expected: 新增迁移与路径测试通过。

- [ ] **Step 5: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/store-paths.ts src/common-settings-store.ts src/store.ts src/codex-store.ts test/common-settings-store.test.js test/store.test.js test/codex-store.test.js`
Expected: 只包含路径 helper、common settings store 与迁移相关变更。

### Task 2: 为 Codex 建立独立官方 snapshot / loader adapter

**Files:**
- Create: `src/upstream/codex-plugin.snapshot.ts`
- Create: `src/upstream/codex-loader-adapter.ts`
- Create: `scripts/sync-codex-upstream.mjs`
- Modify: `package.json`
- Test: `test/codex-loader-adapter.test.js`
- Test: `test/codex-plugin-config.test.js`
- Test: `test/sync-codex-upstream.test.js`

- [ ] **Step 1: 先写失败测试**

增加两类测试：
- `test/codex-loader-adapter.test.js`：断言 Codex adapter 能从官方 snapshot loader 产出 `fetch`，并保留 Codex provider 的 URL/header/auth 语义；
- `test/codex-plugin-config.test.js`：增加一个轻量集成 smoke test，确认 Codex adapter 能被 provider 装配链引用，而不是孤立存在；
- `test/sync-codex-upstream.test.js`：断言新同步脚本能从上游 `packages/opencode/src/plugin/codex.ts` 生成本地 snapshot，并在 drift 场景下失败。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `node --test test/codex-loader-adapter.test.js test/codex-plugin-config.test.js test/sync-codex-upstream.test.js`
Expected: 失败，因为 Codex snapshot、Codex loader adapter、Codex sync script 还不存在。

- [ ] **Step 3: 做最小实现**

实现下列文件：
- 参考 `src/upstream/copilot-plugin.snapshot.ts` / `src/upstream/copilot-loader-adapter.ts` 新建 Codex 对应文件；
- 参考 `scripts/sync-copilot-upstream.mjs` 新建 `scripts/sync-codex-upstream.mjs`，源路径改为上游 `packages/opencode/src/plugin/codex.ts`；
- 在 `package.json` 增加 Codex snapshot 同步/校验 script。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `node --test test/codex-loader-adapter.test.js test/codex-plugin-config.test.js test/sync-codex-upstream.test.js`
Expected: Codex loader adapter 和 Codex snapshot sync 测试通过。

- [ ] **Step 5: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/upstream/codex-plugin.snapshot.ts src/upstream/codex-loader-adapter.ts scripts/sync-codex-upstream.mjs package.json test/codex-loader-adapter.test.js test/sync-codex-upstream.test.js`
Expected: 只包含 Codex 官方 snapshot / adapter / sync script 相关改动。

### Task 3: 抽出 common retry helper，并新增 Codex retry policy

**Files:**
- Create: `src/retry/common-policy.ts`
- Create: `src/retry/codex-policy.ts`
- Create: `src/codex-network-retry.ts`
- Modify: `src/retry/copilot-policy.ts`
- Test: `test/codex-network-retry.test.js`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 先写失败测试**

在 `test/codex-network-retry.test.js` 增加这些断言：
- Codex transport / timeout / `429` / `5xx` 被判为 retryable；
- Codex `400/401/403` 不被判为 retryable；
- Codex 不会触发 Copilot session repair / payload cleanup 语义。

并在 `test/copilot-network-retry.test.js` 增加一条回归：接入 common helper 后，Copilot 现有 repair 行为不回退。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `node --test test/codex-network-retry.test.js test/copilot-network-retry.test.js`
Expected: Codex retry 文件缺失，新增用例失败。

- [ ] **Step 3: 做最小实现**

实现下列边界：
- `src/retry/common-policy.ts` 提供 provider 无关的 transient 分类 / 归一化 helper；
- `src/retry/copilot-policy.ts` 改为复用 common helper，但保留 Copilot 专属 repair / notifier / session 语义；
- `src/retry/codex-policy.ts` 只实现 Codex 自己的 transient retry 分类；
- `src/codex-network-retry.ts` 暴露 `createCodexRetryingFetch()`，通过 `network-retry-engine` 包装 Codex 官方 fetch。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `node --test test/codex-network-retry.test.js test/copilot-network-retry.test.js`
Expected: Codex retry 分类转绿，Copilot 回归仍通过。

- [ ] **Step 5: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/retry/common-policy.ts src/retry/codex-policy.ts src/codex-network-retry.ts src/retry/copilot-policy.ts test/codex-network-retry.test.js test/copilot-network-retry.test.js`
Expected: 只包含 retry 分层相关变更。

### Task 4: 重构 provider capability 与 hook 编排层

**Files:**
- Modify: `src/providers/descriptor.ts`
- Modify: `src/providers/registry.ts`
- Modify: `src/plugin-hooks.ts`
- Modify: `src/plugin.ts`
- Test: `test/plugin.test.js`
- Test: `test/codex-plugin-config.test.js`

- [ ] **Step 1: 先写失败测试**

补这些回归断言：
- OpenAI/Codex provider 启用 retry 后会走 Codex official adapter + Codex retry enhancer；
- OpenAI/Codex provider 不会触发 Copilot official adapter、Copilot routing enhancer、Copilot auth loader；
- `networkRetryEnabled` 打开时，Copilot 走 `common + copilot`，Codex 走 `common + codex`。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `node --test test/plugin.test.js test/codex-plugin-config.test.js`
Expected: 新增 provider capability / hook 隔离断言失败。

- [ ] **Step 3: 做最小实现**

按下面顺序改：
- descriptor / registry 增加 provider runtime capabilities；
- `plugin.ts` 组装 Copilot / Codex 各自的官方 adapter、fetch enhancer、retry enhancer；
- `buildPluginHooks` 只做编排：先 provider base fetch，再 provider fetch enhancer，再在 `networkRetryEnabled` 为真时挂 provider retry enhancer；
- 去掉对 Copilot 官方 adapter 的默认绑定假设；
- 保持 Copilot routing 只挂在 Copilot provider。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `node --test test/plugin.test.js test/codex-plugin-config.test.js`
Expected: OpenAI/Codex 与 Copilot 两条链路的隔离断言通过。

- [ ] **Step 5: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/providers/descriptor.ts src/providers/registry.ts src/plugin-hooks.ts src/plugin.ts test/plugin.test.js test/codex-plugin-config.test.js`
Expected: 只包含 provider capability 与 hook 编排重构。

### Task 5: 把通用开关从 Copilot 私有区提升为共享“通用设置”

**Files:**
- Create: `src/common-settings-actions.ts`
- Modify: `src/ui/menu.ts`
- Modify: `src/plugin.ts`
- Modify: `src/plugin-actions.ts`
- Test: `test/menu.test.js`
- Test: `test/plugin.test.js`
- Test: `test/codex-plugin-config.test.js`

- [ ] **Step 1: 先写失败测试**

增加这些断言：
- Copilot / Codex 菜单都显示 `通用设置`；
- `loopSafetyEnabled`、`loopSafetyProviderScope`、`experimentalSlashCommandsEnabled`、`networkRetryEnabled` 都出现在两个 provider 菜单；
- `syntheticAgentInitiatorEnabled` 仍只在 Copilot 菜单；
- `networkRetryEnabled` 文案变为全局语义，而不是 Copilot 私有语义。
- 明确对菜单顺序做稳定断言：`当前 provider 操作 -> 通用设置 -> provider 专属设置 -> 账号 -> 危险操作`。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `node --test test/menu.test.js test/plugin.test.js test/codex-plugin-config.test.js`
Expected: 新增菜单与 action 路径断言失败。

- [ ] **Step 3: 做最小实现**

实现下列改动：
- `src/common-settings-actions.ts` 负责读写独立通用设置 store；
- `src/ui/menu.ts` 改成 `当前 provider 操作 -> 通用设置 -> provider 专属设置 -> 账号 -> 危险操作`；
- `src/plugin.ts` 在 Copilot / Codex 两边都读取通用设置并注入菜单；
- 保留 `plugin-actions.ts` 里 Copilot 账号相关 action，但把通用开关切换迁移到 common settings actions。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `node --test test/menu.test.js test/plugin.test.js test/codex-plugin-config.test.js`
Expected: 菜单结构、能力归属与通用开关行为全部转绿。

- [ ] **Step 5: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/common-settings-actions.ts src/ui/menu.ts src/plugin.ts src/plugin-actions.ts test/menu.test.js test/plugin.test.js test/codex-plugin-config.test.js`
Expected: 只包含通用设置入口与菜单重构变更。

### Task 6: 全量验证与回归清点

**Files:**
- Verify only

- [ ] **Step 1: 跑新增定向测试集合**

Run: `node --test test/common-settings-store.test.js test/codex-loader-adapter.test.js test/sync-codex-upstream.test.js test/codex-network-retry.test.js test/menu.test.js test/plugin.test.js test/codex-plugin-config.test.js`
Expected: 全部通过。

- [ ] **Step 2: 跑完整测试**

Run: `npm test`
Expected: 全量通过。

- [ ] **Step 3: 检查最终改动范围**

Run: `git diff -- docs/superpowers/specs/2026-03-23-common-retry-codex-snapshot-store-design.md docs/superpowers/plans/2026-03-23-common-retry-codex-snapshot-store-implementation.md src scripts test package.json`
Expected: 只包含本次通用 retry / Codex snapshot / store 路径 / 菜单重构相关改动。

- [ ] **Step 4: 检查命名与负向断言是否到位**

确认新增代码、测试和文档统一使用“Codex provider”指代 `auth.provider = openai` 的 Codex 路径；同时确认测试里包含“Codex 不触达 Copilot official adapter / routing / session repair”这类负向断言。

- [ ] **Step 5: 记录执行结果（仅在用户明确要求时提交）**

整理测试结果、迁移策略和未决风险；若用户要求，再执行 git 提交。
