# Guided Loop Safety Wait-State Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 Guided Loop Safety 的固定注入 policy，使其更明确约束 idle / wait-state 持续使用 `question` 工具、禁止把重复等待当成停问理由，并禁止在错误复盘中质疑报告策略本身。

**Architecture:** 保持现有 prompt 注入实现与测试结构不变，只在 `src/loop-safety-plugin.ts` 中重写固定 `LOOP_SAFETY_POLICY` 字符串，并在 `test/loop-safety-plugin.test.js` 中同步更新精确文本断言。`isCopilotProvider()`、`applyLoopSafetyPolicy()`、`createLoopSafetySystemTransform()` 的逻辑、Copilot-only 注入、幂等追加与 fail-open store 读取全部保持原样。

**Tech Stack:** TypeScript, Node.js, OpenCode plugin hooks, Node built-in test runner (`node:test`)

---

## File Map

- Modify: `src/loop-safety-plugin.ts`
  - 重写固定 `LOOP_SAFETY_POLICY` 文本，把规则按 reporting contract、post-report flow、wait-state discipline、reflection/delegation guardrails 重新组织
- Modify: `test/loop-safety-plugin.test.js`
  - 更新 `EXPECTED_POLICY`，继续锁定完整文本与现有幂等/开关/provider 行为
- Reference: `docs/superpowers/specs/2026-03-14-guided-loop-safety-wait-state-design.md`
  - 作为实现与测试预期来源

## Chunk 1: Lock The New Policy Text In Tests

### Task 1: 先把新 policy 文本写进测试，确认当前实现变红

**Files:**
- Modify: `test/loop-safety-plugin.test.js`
- Reference: `docs/superpowers/specs/2026-03-14-guided-loop-safety-wait-state-design.md`

- [ ] **Step 1: 将 `EXPECTED_POLICY` 改为新的等待态重构版本**

把 `test/loop-safety-plugin.test.js` 中的 `EXPECTED_POLICY` 更新为符合 spec 的完整固定文本。文本必须至少明确表达以下语义：

- `question` 工具是所有用户可见报告的强制通道
- 成功报告后只能继续工作或再次通过 `question` 进入等待态
- idle / wait-state 下必须继续调用 `question` 工具以维持用户控制权
- 重复等待不是停止提问的理由
- 不得把错误归因到报告策略本身

保持测试文件中其他断言结构不变，先只替换文本常量。

- [ ] **Step 2: 运行聚焦测试，确认当前源码先失败**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js
```

Expected: FAIL，且失败原因应是 `LOOP_SAFETY_POLICY` 与新 `EXPECTED_POLICY` 不一致，而不是导入或构建错误。

## Chunk 2: Update The Injected Policy Constant

### Task 2: 仅重写 `LOOP_SAFETY_POLICY`，不改变注入逻辑

**Files:**
- Modify: `src/loop-safety-plugin.ts`

- [ ] **Step 1: 重写固定 policy 文本**

在 `src/loop-safety-plugin.ts` 中，只更新 `LOOP_SAFETY_POLICY` 的多行字符串内容，使其按 spec 重组为更清晰的执行顺序。

实现要求：

- 保留开头标题 `Guided Loop Safety Policy`
- 继续使用固定整段字符串，不做动态拼接
- 明确写出 `question` tool 的报告通道与用户控制权语义
- 明确写出 post-report 的两种合法分支：继续工作，或继续通过 `question` 进入等待态
- 明确写出 idle / wait-state 下必须继续调用 `question`，以及重复等待不是停问理由
- 明确写出错误复盘时不得质疑报告策略本身
- 继续保留 `task` / subagent 节制规则

- [ ] **Step 2: 不要改动其余函数逻辑**

确认以下符号只做格式化无关的最小触碰，不能改变其行为：

- `isCopilotProvider()`
- `applyLoopSafetyPolicy()`
- `createLoopSafetySystemTransform()`

若编辑器自动调整空白或换行可以接受，但不得改变任何条件判断、数组处理或 store 读取路径。

- [ ] **Step 3: 再跑聚焦测试，确认改绿**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js
```

Expected: PASS。

## Chunk 3: Regression Verification

### Task 3: 验证原有注入行为没有回归

**Files:**
- Modify: none
- Test: `test/loop-safety-plugin.test.js`

- [ ] **Step 1: 运行完整单测套件**

Run:

```bash
npm test
```

Expected: PASS。

- [ ] **Step 2: 运行类型检查与构建**

Run:

```bash
npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 3: 人工核对范围控制**

确认实现代码改动只涉及：

- `src/loop-safety-plugin.ts`
- `test/loop-safety-plugin.test.js`

文档文件属于本次设计/计划产物，不计入实现代码范围；同时确认未顺手修改菜单、README 或其他与本次等待态策略无关的文件。

## Final Verification Checklist

- [ ] `npm run build && node --test test/loop-safety-plugin.test.js`
- [ ] `npm test`
- [ ] `npm run typecheck && npm run build`
- [ ] `src/loop-safety-plugin.ts` 中只有 `LOOP_SAFETY_POLICY` 文本发生语义变更
- [ ] 新 policy 文本明确覆盖等待态持续提问、重复等待不构成停问理由、不得质疑策略本身
- [ ] 其余注入逻辑、Copilot-only 限制、幂等行为与 fail-open 行为不变

## Handoff Notes

- 这是 prompt 注入文本重构，不是实现逻辑改造；优先最小化代码范围。
- 不要借机修改 `README.md`、`src/ui/menu.ts` 或其它测试文件。
- 如果需要新增或删改句子，先以 spec 为准，再同步到测试常量，避免源码与测试来回漂移。
- 若最终需要请求代码审阅，重点请 reviewer 检查 policy 文本是否准确表达等待态控制权与错误复盘边界，而不是讨论菜单或其他历史功能。
