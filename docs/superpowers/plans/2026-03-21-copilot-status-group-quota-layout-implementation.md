# /copilot-status 分组配额布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/copilot-status` 成功 toast 改成基于 `[default]` / `[model-id]` 的 premium 配额分组视图，并按 50 宽三列规则稳定排版。

**Architecture:** 保留现有 `handleStatusCommand(...)` 刷新与持久化流程，只重写 `src/status-command.ts` 中的成功消息拼装和去 active 化错误文案。排版逻辑拆成小函数：组收集、账号块渲染、50 宽三列行拼装、中间省略，测试集中锁定内容语义、顺序与布局预算。

**Tech Stack:** TypeScript, Node.js built-in test runner, existing toast command pipeline.

---

### Task 1: 先用失败测试锁定新的成功 toast 语义

**Files:**
- Modify: `test/status-command.test.js`
- Modify: `src/status-command.ts`

- [ ] **Step 1: 写失败测试，去掉 active/chat/completions 视角**

在 `test/status-command.test.js` 新增一个成功场景测试，至少断言：

- 成功 toast 不再包含 `current active`
- 成功 toast 不再包含 `chat`
- 成功 toast 不再包含 `completions`
- 成功 toast 包含 `[default]`
- 成功 toast 包含至少一个 `[model-id]`

可参考结构：

```js
test("status command success shows grouped premium quota view instead of active summary", async () => {
  const calls = []
  const { handleStatusCommand } = await import("../dist/status-command.js")

  await assert.rejects(
    handleStatusCommand({
      client: { tui: { showToast: async (options) => calls.push(options) } },
      loadStore: async () => ({
        active: "alice",
        activeAccountNames: ["alice", "bob"],
        modelAccountAssignments: { "gpt-5.4": ["bob", "alice"] },
        accounts: {
          alice: { name: "alice", refresh: "r", access: "a", expires: 0 },
          bob: { name: "bob", refresh: "r2", access: "a2", expires: 0 },
        },
      }),
      writeStore: async () => {},
      refreshQuota: async (store) => {
        store.accounts.alice = {
          ...store.accounts.alice,
          quota: { snapshots: { premium: { remaining: 300, entitlement: 300 } } },
        }
        return { type: "success", name: "alice", entry: store.accounts.alice }
      },
    }),
    (error) => error?.name === "StatusCommandHandledError",
  )

  const message = calls.at(-1)?.body?.message ?? ""
  assert.doesNotMatch(message, /current active/i)
  assert.doesNotMatch(message, /chat/i)
  assert.doesNotMatch(message, /completions/i)
  assert.match(message, /\[default\]/)
  assert.match(message, /\[gpt-5\.4\]/)
})
```

- [ ] **Step 2: 运行针对性测试，确认先失败**

Run: `node --test test/status-command.test.js --test-name-pattern "grouped premium quota view|status command success"`

Expected: FAIL，提示当前实现仍输出 active summary 或旧字段。

- [ ] **Step 3: 只写最小实现，让成功 toast 改成分组 premium 视图**

在 `src/status-command.ts`：

- 删除成功消息里的 `current active` / `chat` / `completions` / `updated at`
- 新增最小分组拼装函数，输出 `[default]` 和 `[model-id]`
- 先不做最终布局细节，只让测试转绿

- [ ] **Step 4: 重跑针对性测试，确认转绿**

Run: `node --test test/status-command.test.js --test-name-pattern "grouped premium quota view|status command success"`

Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add test/status-command.test.js src/status-command.ts
git commit -m "test(status): 锁定分组 premium 配额展示语义"
```

### Task 2: 用 TDD 锁定 50 宽三列布局和中间省略规则

**Files:**
- Modify: `test/status-command.test.js`
- Modify: `src/status-command.ts`

- [ ] **Step 1: 写失败测试，覆盖三列布局与 2000 配额场景**

新增测试至少断言：

- `[default]` 标题后的一行能放 3 个账号块
- 同一行总字符数为 `50`
- 存在 `2000/2000` 时仍不超过 `50`
- 末行不足 3 个账号时仍按补齐规则保持 `50`

建议按行拆断言，例如：

```js
const lines = message.split("\n")
assert.equal(lines[1]?.length, 50)
assert.equal(lines[3]?.length, 50)
```

- [ ] **Step 2: 在同一轮 RED 中补一个用户名中间省略测试**

新增测试至少断言：

- 超长用户名不会原样出现
- 输出中保留前缀和后缀
- 中间出现 `...`

- [ ] **Step 3: 跑这组布局测试，确认先失败**

Run: `node --test test/status-command.test.js --test-name-pattern "50|三列|ellipsis|省略|grouped premium quota view"`

Expected: FAIL，提示长度预算或省略规则尚未满足。

- [ ] **Step 4: 在 `src/status-command.ts` 拆出排版辅助函数并做最小实现**

实现时拆成几个小函数，避免把所有逻辑塞进 `buildSuccessMessage(...)`：

- `formatPremiumQuota(...)`
- `truncateMiddle(...)`
- `renderAccountCell(...)`
- `renderAccountRow(...)`
- `renderAccountGrid(...)`

实现要求：

- 每行 3 列，列宽固定
- 整行宽度固定 `50`
- 动态调整只发生在单个账号块内部
- quota 过长时优先保留 quota 并省略用户名
- 用户名超长时使用中间省略

- [ ] **Step 5: 重跑这组布局测试，确认转绿**

Run: `node --test test/status-command.test.js --test-name-pattern "50|三列|ellipsis|省略|grouped premium quota view"`

Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add test/status-command.test.js src/status-command.ts
git commit -m "feat(status): 增加分组配额三列布局渲染"
```

### Task 3: 锁定排序、空组和去 active 化错误文案

**Files:**
- Modify: `test/status-command.test.js`
- Modify: `src/status-command.ts`

- [ ] **Step 1: 写失败测试，覆盖输出顺序**

新增测试至少断言：

- `[default]` 内账号顺序跟随 `activeAccountNames`
- 模型分组按 key 字典序输出
- 模型分组内账号顺序跟随原数组

- [ ] **Step 2: 写失败测试，覆盖空组显示**

新增测试至少断言：

- 默认组为空时输出 `[default]` 下一行 `(none)`
- 路由组整体为空时输出 `[routes] (none)`

- [ ] **Step 3: 写失败测试，覆盖去 active 化错误文案**

新增测试至少断言：

- 原先 `active account` 风格错误消息不再出现
- 新错误消息改为“默认组/可刷新账号缺失”语义

- [ ] **Step 4: 跑这组三类测试，确认先失败**

Run: `node --test test/status-command.test.js --test-name-pattern "default|routes|active account|排序|order|none"`

Expected: FAIL

- [ ] **Step 5: 做最小实现，让顺序、空组与错误文案转绿**

在 `src/status-command.ts`：

- 明确默认组与模型组的遍历顺序
- 加入空组输出
- 把缺 active 的用户可见错误文案替换成去 active 化表达

- [ ] **Step 6: 重跑这组三类测试，确认转绿**

Run: `node --test test/status-command.test.js --test-name-pattern "default|routes|active account|排序|order|none"`

Expected: PASS

- [ ] **Step 7: 提交这一小步**

```bash
git add test/status-command.test.js src/status-command.ts
git commit -m "fix(status): 收紧分组顺序与空态文案"
```

### Task 4: 全量验证并整理交付证据

**Files:**
- Modify: `test/status-command.test.js`
- Modify: `src/status-command.ts`

- [ ] **Step 1: 运行整个 status command 测试文件**

Run: `node --test test/status-command.test.js`

Expected: PASS

- [ ] **Step 2: 运行完整项目测试**

Run: `npm test`

Expected: PASS

- [ ] **Step 3: 检查最终 diff 只包含本轮相关文件**

Run: `git diff --stat HEAD~3..HEAD`

Expected: 主要只涉及 `src/status-command.ts`、`test/status-command.test.js`，以及必要文档。

- [ ] **Step 4: 检查工作树状态**

Run: `git status --short --branch`

Expected: 工作树干净，或只剩本轮待提交改动。

- [ ] **Step 5: 准备交付说明**

说明里必须覆盖：

- 为什么成功 toast 不再围绕 active 展示
- 50 宽三列布局是如何稳定控制的
- 为什么这轮先不扩 quota 刷新机制 scope
