# Guided Loop Safety Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Loop Safety 升级为更易理解的 Guided Loop Safety，使用更严格的 question-first policy、更清晰的菜单文案与 README 说明，同时保持现有持久化字段与最小改动范围。

**Architecture:** 保持现有插件结构与运行时入口不变，只在既有文件上做聚焦更新：重写 `src/loop-safety-plugin.ts` 中的固定 policy 文本，更新 `src/ui/menu.ts` 的用户可见命名与 hint，修正 `README.md` 的功能说明与命令示例，并同步更新 Node 测试的预期文本。已有 `loopSafetyEnabled` 持久化字段、`applyMenuAction()`、`buildPluginHooks()` 和菜单接线逻辑保持不变。

**Tech Stack:** TypeScript, Node.js 20+, OpenCode plugin hooks, 现有菜单/store 工具, Node built-in test runner (`node:test`)

---

## File Map

- Modify: `src/loop-safety-plugin.ts`
  - 将固定 policy 升级为 `Guided Loop Safety Policy`，改为严格 `question-first` 规则，并加入多问题合并、按主题分组、分页/分批汇报、减少无谓 `task/subagent` 的细则
- Modify: `src/ui/menu.ts`
  - 将用户可见命名改为 `guided loop safety`，并把 hint 改为更可理解的效果说明
- Modify: `README.md`
  - 将功能描述升级为 `Guided Loop Safety`，同步更严格的行为说明，并修正示例命令为 `opencode auth login --provider github-copilot`
- Modify: `test/loop-safety-plugin.test.js`
  - 更新 `EXPECTED_POLICY`，验证新的精确 policy 文本仍然幂等、Copilot-only、生效一次
- Modify: `test/menu.test.js`
  - 更新菜单文案和 hint 预期，验证位置关系仍然不变
- Optional verify: `test/plugin.test.js`
  - 若插件测试中引用了旧命名或旧说明，则同步更新；否则仅重新跑通过即可

## Chunk 1: Policy And Menu Renaming

### Task 1: 先写失败测试，锁定新的 policy 与菜单文案

**Files:**
- Modify: `test/loop-safety-plugin.test.js`
- Modify: `test/menu.test.js`

- [ ] **Step 1: 更新 policy 常量测试为新的严格文本**

把 `test/loop-safety-plugin.test.js` 中的 `EXPECTED_POLICY` 改成新的精确文本：

```js
const EXPECTED_POLICY = `Guided Loop Safety Policy
- When the question tool is available and permitted in the current session, all user-facing reports must be delivered through the question tool.
- The question tool is considered available and permitted when it appears in the active tool list and the current session has not denied its use.
- Direct assistant text is allowed only when the question tool is unavailable, denied, or absent from the current session.
- When reporting multiple related items, prefer a single question tool call with multiple well-grouped questions instead of multiple separate interruptions.
- Group related items into clear question batches such as current progress, key findings, and next-step choices.
- For long or complex reports, split the report into paginated or sequential question batches instead of overloading one large message.
- Present the highest-priority information first and defer secondary details to later question batches when needed.
- Even when no explicit decision is required, prefer brief question-tool status updates over direct assistant text whenever the tool is available.
- Avoid unnecessary question frequency; combine small related updates when a single question call can cover them clearly.
- Dispatching task or subagent work is expensive and should be avoided unless it materially improves the result.
- Materially improves the result means clearly beneficial cases such as parallel analysis of independent areas; it does not include routine local searches, small file reads, or straightforward edits.
- If task or subagent delegation is used, keep the number minimal and explain the reason briefly through the question tool when available.`
```

- [ ] **Step 2: 更新菜单测试为新的 Guided 命名和 hint**

把 `test/menu.test.js` 中的预期更新为：

```js
test("buildMenuItems shows Enable guided loop safety when disabled", () => {
  // ...
  const toggle = items.find((item) => item.label === "Enable guided loop safety")
  assert.ok(toggle)
  assert.equal(toggle?.hint, "Prompt-guided: fewer report interruptions, fewer unnecessary subagents")
})

test("buildMenuItems shows Disable guided loop safety when enabled", () => {
  // ...
  const toggle = items.find((item) => item.label === "Disable guided loop safety")
  assert.ok(toggle)
})
```

并同步更新位置断言中的 label 文本。

- [ ] **Step 3: 运行测试，确认它们先失败**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js test/menu.test.js
```

Expected: FAIL，失败原因应是当前源码里的 policy 常量、菜单 label 或 hint 仍然是旧文本，而不是导入错误或无关错误。

### Task 2: 最小实现新的 Guided 文案与严格 policy

**Files:**
- Modify: `src/loop-safety-plugin.ts`
- Modify: `src/ui/menu.ts`

- [ ] **Step 1: 最小更新 policy 常量**

在 `src/loop-safety-plugin.ts` 中，仅替换 `LOOP_SAFETY_POLICY` 的固定文本为新的 `Guided Loop Safety Policy` 文本。

要求：

- 不改 `isCopilotProvider()`
- 不改 `applyLoopSafetyPolicy()` 的幂等逻辑
- 不改 `createLoopSafetySystemTransform()` 的读 store 与 append 机制
- 只更新 policy 文本本身

- [ ] **Step 2: 最小更新菜单文案**

在 `src/ui/menu.ts` 中仅改用户可见文案：

- `Enable loop safety` -> `Enable guided loop safety`
- `Disable loop safety` -> `Disable guided loop safety`
- `Copilot only` -> `Prompt-guided: fewer report interruptions, fewer unnecessary subagents`

位置、action type、store 逻辑都保持不变。

- [ ] **Step 3: 运行聚焦测试，确认改绿**

Run:

```bash
npm run build && node --test test/loop-safety-plugin.test.js test/menu.test.js
```

Expected: PASS。

- [ ] **Step 4: 运行插件集成与现有 store 测试，确认没有回归**

Run:

```bash
npm run build && node --test test/plugin.test.js test/store.test.js
```

Expected: PASS。

## Chunk 2: README And Command Clarity

### Task 3: 更新 README 的功能说明与正确命令

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 先改 README 中的英文命令示例**

将所有面向用户的示例命令：

```bash
opencode auth login github-copilot
```

替换为：

```bash
opencode auth login --provider github-copilot
```

- [ ] **Step 2: 再改英文 Usage 文案**

把英文 Usage 中的菜单项说明改成更清晰的 `Guided Loop Safety` 表述，例如：

```md
- **Guided Loop Safety** — prompt-guided reporting that favors `question`, reduces report interruptions, and avoids unnecessary subagent calls
```

并补一句说明：

```md
If you want stricter question-first reporting and fewer unnecessary subagent calls in GitHub Copilot sessions, enable Guided Loop Safety from the account menu.
```

- [ ] **Step 3: 同步更新中文 Usage 文案**

把中文对应说明改成：

```md
- **Guided Loop Safety 开关** — 通过提示词引导模型优先使用 `question` 汇报、减少汇报打断，并避免不必要的子代理调用
```

并补一句说明：

```md
如果你希望 GitHub Copilot 会话更严格地优先使用 `question` 工具汇报、减少汇报打断，并避免不必要的子代理调用，可以在账号菜单中开启 Guided Loop Safety。
```

- [ ] **Step 4: 运行完整自动化验证**

Run:

```bash
npm test && npm run typecheck && npm run build
```

Expected: PASS。

## Final Verification Checklist

- [ ] `npm run build && node --test test/loop-safety-plugin.test.js test/menu.test.js`
- [ ] `npm run build && node --test test/plugin.test.js test/store.test.js`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] README 中所有 `github-copilot` 登录示例已改为 `--provider` 形式
- [ ] 菜单文案已统一为 `Guided Loop Safety`
- [ ] 固定 policy 文本已统一为严格 `question-first`

## Handoff Notes

- 这次是聚焦文案与固定 policy 文本升级，不应顺手重构既有架构。
- 继续复用 `loopSafetyEnabled` 持久化字段，不新增迁移。
- 若某个测试只因为旧命名而失败，优先更新测试预期，不要扩大实现范围。
- 手工 smoke test 继续使用正确命令：`opencode auth login --provider github-copilot`。
