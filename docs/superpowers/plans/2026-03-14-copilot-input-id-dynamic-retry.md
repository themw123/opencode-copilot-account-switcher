# Copilot Input ID Dynamic Retry Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `input[*].id too long` 修复流程在长会话里支持大量超长 id 候选的逐轮推进，并在日志中明确记录每轮清理后服务端报错是否发生了变化。

**Architecture:** 保留 `src/copilot-network-retry.ts` 作为唯一修复入口，但把固定小重试上限改成“按剩余超长 id 候选数动态决定轮次，并受 `HARD_LIMIT` 保护”。同时为每轮 retry 增加结构化进展日志，显式比较上一轮与当前轮的报错索引、报错消息与候选数量，并用严格双条件决定是否继续。

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin retry wrapper, structured debug logging

---

## Execution Notes

- 所有测试依旧从 `dist/` 导入，所以每次执行测试都必须先跑 `npm run build`。
- 必须坚持 TDD：先写失败测试，确认它为正确原因失败，再写最小实现。
- 不能回退到“发送前预清理所有超长 id”或“一次删掉所有长 id”。
- 这次改动的核心不是只把固定上限改大，而是把“是否继续下一轮”的依据显式落到日志与状态比较上。

## File Map

- Modify: `src/copilot-network-retry.ts`
  - 将固定重试上限改成动态上限 + 硬封顶
  - 新增每轮进展日志与严格双条件停机逻辑
  - 保留并增强 session repair 失败日志
- Test: `test/copilot-network-retry.test.js`
  - 增加大量候选动态推进测试
  - 增加报错变化链条日志测试
  - 增加“候选未减少/报错未变化”停机测试
- Reference: `docs/superpowers/specs/2026-03-14-copilot-input-id-dynamic-retry-design.md`
  - 本次实现必须对齐 spec 里的动态上限、严格双条件停机与进展日志字段设计

## Chunk 1: Dynamic Retry Budget

### Task 1: 用失败测试锁定“按候选数动态决定轮次，而不是固定 3/4 次”

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，复现大量候选时固定小上限会提前停住**

在 `test/copilot-network-retry.test.js` 新增一个用例，要求：

- payload 中有 6 个以上超长 `id`
- fake provider 每次都返回当前仍存在的第一个长 id 的 too-long 报错
- 最终应该一直修到所有长 id 都被移除，而不是在第 3 或第 4 轮提前停住

测试名建议：

```js
test("keeps repairing while remaining long-id candidates still justify more retries", async () => {
  // assert final response is 200
  // assert outgoing payloads show remaining long ids count decreases like [6,5,4,3,2,1,0]
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，当前实现会因为固定小上限提前返回 400

- [ ] **Step 3: 写最小实现，把固定上限改为动态轮次预算**

在 `src/copilot-network-retry.ts`：

- 保留一个高硬上限，如 `HARD_LIMIT = 64`
- 新增 helper 计算当前 payload 剩余超长 id 候选数
- 每轮根据剩余候选数动态决定是否还有继续资格，而不是单纯 `for attempt < constant`

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 按剩余候选动态推进超长 input id 重试"
```

## Chunk 2: Progress Logging And Stop Conditions

### Task 2: 用失败测试锁定“清理后服务端报错是否变化”的进展日志

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，要求日志能记录报错变化链条**

在 debug 模式下新增测试，模拟：

- 第一轮报错 `input[3].id`
- 第二轮报错 `input[5].id`
- 第三轮报错 `input[7].id`

断言日志包含：

- `input-id retry progress`
- `attempt`
- `previousServerReportedIndex`
- `currentServerReportedIndex`
- `serverIndexChanged`
- `previousErrorMessagePreview`
- `currentErrorMessagePreview`
- `remainingLongIdCandidatesBefore`
- `remainingLongIdCandidatesAfter`

测试名建议：

```js
test("writes retry progress logs that show server error index changes across attempts", async () => {})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，当前实现没有 progress 日志

- [ ] **Step 3: 写最小实现，新增 progress 日志结构**

在 `src/copilot-network-retry.ts`：

- 为每轮 retry 保存上一轮的报错索引、报错消息 preview、failingId preview、剩余候选数
- 在收到下一轮 too-long 响应后输出 `input-id retry progress`
- 只记录 preview，不写完整 id / 完整长错误体

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(debug): 记录超长 input id 重试推进链路"
```

### Task 3: 用失败测试锁定“严格双条件停机”

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写两个失败测试，分别覆盖停机场景**

新增测试：

```js
test("stops retrying when remaining long-id candidates do not decrease", async () => {})
test("stops retrying when server error details do not change after a cleanup", async () => {})
```

断言：

- 响应停在 400
- 不会无限重试
- `input-id retry progress` 中包含明确 `stopReason`

建议 `stopReason` 至少覆盖：

- `remaining-candidates-not-reduced`
- `server-error-unchanged`

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，当前实现没有这套双条件停机逻辑

- [ ] **Step 3: 写最小实现，加入严格双条件停机**

在 `src/copilot-network-retry.ts`：

- 只有“候选减少”且“报错索引或报错消息变化”时才允许继续
- 任何一个条件不满足都立刻返回当前 400
- 同时写入 `stopReason`

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(copilot): 为超长 input id 重试增加严格停机条件"
```

## Chunk 3: Session Repair Failure Visibility

### Task 4: 锁定 session patch 失败时的可观测性仍然完整

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `src/copilot-network-retry.ts`

- [ ] **Step 1: 写失败测试，要求 patch 失败时同时保留失败日志和进展日志**

新增测试，模拟：

- `patchPart` 抛错
- payload retry 仍然继续
- 下一轮报错发生变化

断言日志同时出现：

- `input-id retry session repair failed`
- `input-id retry progress`

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: FAIL，如果当前日志上下文不完整或顺序不对

- [ ] **Step 3: 写最小实现，补全失败路径日志上下文**

在 `src/copilot-network-retry.ts`：

- 让 session repair 失败日志包含必要上下文（sessionID、错误摘要）
- 保证失败后后续进展日志仍然可见

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test test/copilot-network-retry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js
git commit -m "fix(debug): 补全会话回写失败后的重试上下文日志"
```

## Chunk 4: Whole-Suite Verification

### Task 5: 运行完整验证并确认发包结果未回退

**Files:**
- Modify: `src/copilot-network-retry.ts`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 跑完整测试**

Run: `npm test`
Expected: PASS，全部测试通过

- [ ] **Step 2: 跑发包预检**

Run: `npm pack --dry-run`
Expected: PASS，产物清单正常

- [ ] **Step 3: 提交最终修复**

如果前面按任务粒度已提交，这一步可以只补最后整体验证后的收尾提交；如果执行时选择压缩提交，则至少保证提交信息准确描述这次修复目的。

建议 message：

```bash
git add src/copilot-network-retry.ts test/copilot-network-retry.test.js docs/superpowers/specs/2026-03-14-copilot-input-id-dynamic-retry-design.md docs/superpowers/plans/2026-03-14-copilot-input-id-dynamic-retry.md
git commit -m "fix(copilot): 为长会话超长 input id 重试增加动态推进与进展日志"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-03-14-copilot-input-id-dynamic-retry.md`. Ready to execute?
