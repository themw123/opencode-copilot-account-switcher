# Copilot Plugin 1.2.26 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `copilot-account-switcher` 升级到 `@opencode-ai/plugin@^1.2.26`，验证并修复 session repair 在真实新版宿主中的持久化路径。

**Architecture:** 先升级依赖，使插件运行时与当前上游 `PluginInput` / v2 SDK API 对齐；再基于新版真实对象形状补充回归测试，确认 `serverUrl` 与 `client.part.update` 可用，并把 retry repair 收敛到稳定的持久修复路径。保留必要 fallback，但不再围绕旧版私有 SDK 结构做猜测式适配。

**Tech Stack:** TypeScript、Node test runner、`@opencode-ai/plugin@1.2.26`、`@opencode-ai/sdk@1.2.26`

---

## Chunk 1: 依赖与运行时接口对齐

### Task 1: 锁定升级后的依赖基线

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Check: `node_modules/@opencode-ai/plugin/package.json`
- Check: `node_modules/@opencode-ai/sdk/package.json`

- [ ] **Step 1: 确认依赖声明已经指向新版**

检查 `package.json` 中 `@opencode-ai/plugin` 是否为 `^1.2.26`。

- [ ] **Step 2: 运行安装以刷新锁文件和实际依赖**

Run: `npm install @opencode-ai/plugin@^1.2.26`
Expected: `package-lock.json` 更新，且安装成功无 vulnerabilities。

- [ ] **Step 3: 验证实际安装版本**

Run: `npm view @opencode-ai/plugin version && npm view @opencode-ai/sdk version`
Expected: 都显示 `1.2.26`。

- [ ] **Step 4: 校验新版导出形状**

读取：
- `node_modules/@opencode-ai/plugin/dist/index.d.ts`
- `node_modules/@opencode-ai/sdk/package.json`

确认：
- `PluginInput.serverUrl: URL` 存在
- SDK 已切到 `dist/v2/...` 导出体系

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): 升级 opencode 插件依赖到 1.2.26"
```

## Chunk 2: 用测试锁定新版 repair 通道

### Task 2: 为新版 `client.part.update` 持久修复补最小回归测试

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Check: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，覆盖新版宿主路径**

在 `test/copilot-network-retry.test.js` 中新增一个用例，模拟：
- `client.part.update` 可用
- `PluginInput.serverUrl` 可用
- 首次 `/responses` 返回 `input[*].id too long`
- `repairSessionPart()` 成功调用 `client.part.update`
- 随后 payload retry 成功

断言至少包括：
- `part.update` 被调用 1 次
- `part.update.part.metadata.openai.itemId === undefined`
- 原有 metadata 其余字段保留
- 第二次请求去掉目标 `input.id`

- [ ] **Step 2: 单测先跑红**

Run: `node --test test/copilot-network-retry.test.js`
Expected: 新增用例先失败；失败原因应是当前实现与新版真实调用约束不一致，而不是语法/导入错误。

- [ ] **Step 3: 如有必要，再补一个旧路径保护测试**

如果升级后旧 fallback 行为有变化风险，再补一个最小测试，确保：
- 当 `client.part.update` 缺失或抛出网络型错误时，仍可走 targeted payload retry

- [ ] **Step 4: Commit**

```bash
git add test/copilot-network-retry.test.js
git commit -m "test(retry): 锁定新版 session repair 通道行为"
```

## Chunk 3: 最小实现修复

### Task 3: 让 retry repair 优先命中新版持久修复接口

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Check: `src/plugin-hooks.ts`
- Check: `src/plugin.ts`

- [ ] **Step 1: 只改最小实现让新测试通过**

实现目标：
- `repairSessionPart()` 在新版依赖下优先使用 `ctx.client.part.update(...)`
- 使用新版 `serverUrl` / `directory` 约定时保持兼容
- 不引入对旧版私有 `_client` 之类内部结构的依赖

- [ ] **Step 2: 保留必要 fallback，但收紧错误边界**

确保：
- `client.part.update` 成功时，真实 session part 被持久修复
- `client.part.update` 抛网络型错误时，仍允许本次请求退回 payload retry
- 非网络型异常继续抛出，避免静默吞掉真正的 repair 失败

- [ ] **Step 3: 检查 `plugin-hooks` 传入上下文是否仍完整**

确认 `buildPluginHooks()` 在新版 `PluginInput` 下继续向 retry fetch 传递：
- `client`
- `directory`
- `serverUrl`

- [ ] **Step 4: 运行单测转绿**

Run: `node --test test/copilot-network-retry.test.js`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/copilot-network-retry.ts src/plugin-hooks.ts src/plugin.ts
git commit -m "fix(retry): 在新版 opencode sdk 中持久修复 session part"
```

## Chunk 4: 全量验证与收尾

### Task 4: 运行构建、类型检查、全量测试并记录结论

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-copilot-plugin-1-2-26-upgrade.md`

- [ ] **Step 1: 运行针对性验证**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: build 成功，retry 测试全绿。

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 3: 运行全量测试**

Run: `npm test`
Expected: 全部测试通过。

- [ ] **Step 4: 记录是否仍保留旧 fallback**

在最终说明里明确：
- 新版宿主的主路径是什么
- 旧 fallback 是否仍保留
- 为什么保留或删除

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-03-15-copilot-plugin-1-2-26-upgrade.md
git commit -m "docs(plan): 记录 opencode 1.2.26 升级与 retry 修复计划"
```
