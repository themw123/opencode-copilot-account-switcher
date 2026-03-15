# Copilot Compaction Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Copilot snapshot 与 upstream compaction 头逻辑漂移问题，补齐 debug 原始证据日志，并把 upstream dev 逐字节漂移检测纳入测试。

**Architecture:** 保持 `src/upstream/copilot-plugin.snapshot.ts` 为脚本纯机械生成物，直接复用 upstream `CopilotAuthPlugin` 本体而不是重组 `loader/chat.headers` 语义。同步脚本改为使用 canonical upstream 与真实 SHA，测试同时覆盖 snapshot 逐字节漂移、机械变换约束、official compaction 行为，以及 debug-only 证据日志链路。

**Tech Stack:** Node.js, TypeScript, `node:test`, GitHub API/`gh`, OpenCode Copilot plugin snapshot tooling

---

## Chunk 1: Snapshot 生成链路收敛为机械变换

### Task 1: 收紧 sync script 默认源与 metadata 规则

**Files:**
- Modify: `scripts/sync-copilot-upstream.mjs`
- Test: `test/copilot-sync.test.js`

- [ ] **Step 1: 新建 sync 测试文件并搬运现有 snapshot 相关测试**

创建 `test/copilot-sync.test.js`，把当前 `test/copilot-network-retry.test.js` 中与 snapshot/sync script 相关的测试迁移进去，保持原断言不变。

- [ ] **Step 2: 运行迁移后的相关测试确认基线一致**

Run: `npm run build && node --test test/copilot-sync.test.js`
Expected: PASS

- [ ] **Step 3: 写一个失败测试，断言默认源改为 canonical upstream**

在 `test/copilot-sync.test.js` 新增测试，读取 `scripts/sync-copilot-upstream.mjs` 或通过脚本行为断言默认远端 URL 是 `anomalyco/opencode`，并且不再优先使用本地兄弟仓库路径作为默认源。

- [ ] **Step 4: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "canonical upstream"`
Expected: FAIL，显示默认源仍是 `sst/opencode` 或本地候选路径逻辑仍存在。

- [ ] **Step 5: 最小修改 sync script**

在 `scripts/sync-copilot-upstream.mjs` 中：
- 删除默认本地兄弟仓库候选逻辑
- 将默认源固定为 `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/plugin/copilot.ts`
- 保留显式 `--source` 时的本地文件支持

- [ ] **Step 6: 写一个失败测试，断言仓库内 snapshot 输出在显式 `--source` 下仍要求 `--upstream-commit`**

在 `test/copilot-sync.test.js` 新增测试：当输出目标是仓库内 `src/upstream/copilot-plugin.snapshot.ts` 且显式传入 `--source <path>` 时，如果缺少 `--upstream-commit`，脚本应失败。

- [ ] **Step 7: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "upstream-commit"`
Expected: FAIL

- [ ] **Step 8: 最小修改 sync script**

保留并验证“仓库内 snapshot 输出 + 显式 source 仍必须带 `--upstream-commit`”的约束。

- [ ] **Step 9: 重新运行相关定向测试确认 GREEN**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "canonical upstream|upstream-commit"`
Expected: PASS

- [ ] **Step 10: 写一个失败测试，断言默认 dev 同步会写入真实 SHA metadata**

新增测试：mock/注入 GitHub API 或 `gh api` 查询结果，运行 sync script 生成临时 snapshot，断言 snapshot 头部 `Upstream commit:` 与查询得到的真实 SHA 一致。

- [ ] **Step 11: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "真实 SHA metadata"`
Expected: FAIL，显示脚本还未写入真实 SHA。

- [ ] **Step 12: 最小实现真实 SHA 解析**

在 `scripts/sync-copilot-upstream.mjs` 中增加一条明确路径：
- 默认 `dev` 模式下通过 GitHub API 或等价 git ref 查询解析真实 SHA
- 用该 SHA 对应 raw 文件生成 snapshot
- 将同一 SHA 写入 metadata

- [ ] **Step 13: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "真实 SHA metadata"`
Expected: PASS

- [ ] **Step 14: 提交本任务**

```bash
git add scripts/sync-copilot-upstream.mjs test/copilot-sync.test.js test/copilot-network-retry.test.js
git commit -m "refactor(sync): 收紧上游 Copilot 快照同步来源"
```

### Task 2: 移除语义副本 helper factory，改为直接消费 official plugin 本体

**Files:**
- Modify: `scripts/sync-copilot-upstream.mjs`
- Modify: `src/upstream/copilot-plugin.snapshot.ts` (generated)
- Modify: `src/upstream/copilot-loader-adapter.ts`
- Test: `test/copilot-sync.test.js`

- [ ] **Step 1: 写一个失败测试，断言 adapter 不再消费重组语义 helper factory**

新增测试，检查 `src/upstream/copilot-loader-adapter.ts` 不再依赖 `createOfficialCopilotLoader` / `createOfficialCopilotChatHeaders` 这类由脚本重组语义的导出。

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "helper factory"`
Expected: FAIL

- [ ] **Step 3: 最小修改 sync script，生成固定 marker 的 export bridge**

只为 direct consumption 生成最小 export bridge，并使用固定 marker（如 `GENERATED_EXPORT_BRIDGE_START/END`）。

- [ ] **Step 4: 重新生成 snapshot 并确认 bridge 结构存在**

Run: `npm run sync:copilot-snapshot -- --upstream-commit <真实-sha> --sync-date 2026-03-15`
Expected: `src/upstream/copilot-plugin.snapshot.ts` 更新为新的机械产物结构

- [ ] **Step 5: 写一个失败测试，断言 adapter 直接消费 `CopilotAuthPlugin` 本体**

新增测试检查 adapter 通过执行 official plugin 拿到 hooks，再读取 `auth.loader` 与 `chat.headers`。

- [ ] **Step 6: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "CopilotAuthPlugin"`
Expected: FAIL

- [ ] **Step 7: 最小修改 adapter**

实现目标：
- sync script 只保留机械变换与最小 export bridge
- `src/upstream/copilot-loader-adapter.ts` 直接 import snapshot 中导出的 `CopilotAuthPlugin`
- adapter 通过执行 official plugin 拿到 hooks，再读取 `auth.loader` 与 `chat.headers`

- [ ] **Step 8: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "helper factory|CopilotAuthPlugin"`
Expected: PASS

- [ ] **Step 9: 提交本任务**

```bash
git add scripts/sync-copilot-upstream.mjs src/upstream/copilot-plugin.snapshot.ts src/upstream/copilot-loader-adapter.ts test/copilot-sync.test.js
git commit -m "refactor(snapshot): 直接复用官方 Copilot 插件实现"
```

## Chunk 2: 漂移检测与机械变换约束测试

### Task 3: 新增 snapshot 逐字节漂移检测测试

**Files:**
- Modify: `test/copilot-sync.test.js`

- [ ] **Step 1: 写一个失败测试，拉取 upstream dev 并重新生成临时 snapshot**

测试需要：
- 拉取 `packages/opencode/src/plugin/copilot.ts`
- 用 sync script 生成临时 snapshot
- 与 `src/upstream/copilot-plugin.snapshot.ts` 做逐字节比较
- 网络失败与 drift 失败输出不同断言消息

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "逐字节漂移"`
Expected: FAIL

- [ ] **Step 3: 写一个失败测试，断言 `npm run check:copilot-sync` 与全量测试使用相同判定标准**

测试应覆盖：
- `--check` 路径也做逐字节比较
- 网络失败输出 `upstream fetch failed`
- 漂移失败输出 `snapshot drift detected`

- [ ] **Step 4: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "check mode"`
Expected: FAIL

- [ ] **Step 5: 最小实现生产脚本支撑**

在 `scripts/sync-copilot-upstream.mjs` 中实现 `--check` 路径与测试路径一致的门禁语义和错误分类。

- [ ] **Step 6: 重新运行相关定向测试确认 GREEN**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "逐字节漂移|check mode"`
Expected: PASS

- [ ] **Step 7: 提交本任务**

```bash
git add scripts/sync-copilot-upstream.mjs test/copilot-sync.test.js
git commit -m "test(sync): 增加上游快照逐字节漂移检测"
```

### Task 4: 新增机械变换约束测试

**Files:**
- Modify: `test/copilot-sync.test.js`

- [ ] **Step 1: 写一个失败测试，验证 snapshot 核心主体与 upstream 原文件逐字节一致**

测试规则必须写死：
- upstream 只移除 import block
- snapshot 只允许剥离 metadata、`LOCAL_SHIMS`、固定 marker 的 export bridge
- 白名单区块外的任何差异都 fail

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "机械变换约束"`
Expected: FAIL

- [ ] **Step 3: 最小实现测试 helper 与固定 marker 规则**

在测试中实现明确剥离规则，必要时同步修改 sync script 让 export bridge 使用固定 marker。

- [ ] **Step 4: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/copilot-sync.test.js --test-name-pattern "机械变换约束"`
Expected: PASS

- [ ] **Step 5: 提交本任务**

```bash
git add scripts/sync-copilot-upstream.mjs test/copilot-sync.test.js
git commit -m "test(sync): 固定快照机械变换白名单规则"
```

## Chunk 3: 官方 compaction 头逻辑与 debug 证据日志

### Task 5: 用 official plugin 本体修复 compaction `x-initiator`

**Files:**
- Modify: `src/upstream/copilot-loader-adapter.ts`
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写一个失败测试，验证 compaction message 场景会得到 `x-initiator=agent`**

在 `test/plugin.test.js` 中新增回归测试，构造：
- `incoming.message.id`
- `incoming.message.sessionID`
- `sdk.session.message(...)` 返回含 `part.type === "compaction"`
- 断言 plugin `chat.headers` 输出 `x-initiator=agent`

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "compaction"`
Expected: FAIL

- [ ] **Step 3: 最小修改 adapter / plugin 接线**

确保 `buildPluginHooks()` 通过 official plugin 本体拿到真实 `chat.headers`，不再丢失 compaction 分支。

- [ ] **Step 4: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "compaction"`
Expected: PASS

- [ ] **Step 5: 提交本任务**

```bash
git add src/upstream/copilot-loader-adapter.ts src/plugin-hooks.ts test/plugin.test.js
git commit -m "fix(headers): 同步官方 compaction agent 标记逻辑"
```

### Task 6: 补充 debug-only 原始证据与候选信号日志

**Files:**
- Modify: `src/plugin-hooks.ts`
- Modify: `src/copilot-network-retry.ts`
- Test: `test/plugin.test.js`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 写一个失败测试，验证 `chat.headers` debug 日志包含 evidence/candidates**

测试应断言在 debug 打开时会记录：
- `sessionID` / `message.id`
- 当前 message `parts.type[]`
- text part 的 `synthetic` 与固定 80 字符前缀预览
- recent messages 摘要固定为“当前 message + 前 3 条”
- `session_parent_id_present` 仅记录 presence，不记录原值
- headers before/after official
- `candidates` 区块

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "evidence|candidates"`
Expected: FAIL

- [ ] **Step 3: 写一个失败测试，验证 retry wrapper 日志包含包装前后 headers 且 debug 关联键会被移除**

测试应断言：
- wrapper 能拿到与 `chat.headers` 同一组 debug 证据
- 真正发网前内部 debug header 已被删掉
- 首发/重试请求均记录包装前后 headers 摘要

- [ ] **Step 4: 运行定向测试确认 RED**

Run: `npm run build && node --test test/copilot-network-retry.test.js --test-name-pattern "debug header|包装前后"`
Expected: FAIL

- [ ] **Step 5: 最小实现 debug-only 日志链路**

实现要求：
- 仅在 `OPENCODE_COPILOT_RETRY_DEBUG=1` 时启用
- `plugin-hooks` 记录 `evidence` / `candidates`
- 使用 debug-only 内部 header + `Map` 关联请求
- `copilot-network-retry.ts` 在发网前删除内部 debug header，并在 `finally` 清理关联缓存

- [ ] **Step 6: 重新运行两个定向测试确认 GREEN**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "evidence|candidates" && node --test test/copilot-network-retry.test.js --test-name-pattern "debug header|包装前后"`
Expected: PASS

- [ ] **Step 7: 提交本任务**

```bash
git add src/plugin-hooks.ts src/copilot-network-retry.ts test/plugin.test.js test/copilot-network-retry.test.js
git commit -m "feat(debug): 增加 Copilot 请求原始证据日志"
```

## Chunk 4: 全量验证

### Task 7: 跑全量验证并修复剩余问题

**Files:**
- Modify: `package.json` (仅当需要补测试脚本时)
- Modify: 任何前述任务涉及文件（仅用于修复验证暴露的问题）

- [ ] **Step 1: 运行类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: 运行全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: 运行 sync check 门禁**

Run: `npm run check:copilot-sync`
Expected: PASS

- [ ] **Step 4: 若任一步失败，只做最小修复并回到对应定向测试**

不要捆绑无关优化；按失败点最小调整。

- [ ] **Step 5: 重新运行全量验证确认全部通过**

Run: `npm run typecheck && npm test && npm run check:copilot-sync`
Expected: PASS

- [ ] **Step 6: 提交验证修复（如果该任务产生代码改动）**

```bash
git add <relevant-files>
git commit -m "test: 修正 Copilot compaction sync 全量验证问题"
```
