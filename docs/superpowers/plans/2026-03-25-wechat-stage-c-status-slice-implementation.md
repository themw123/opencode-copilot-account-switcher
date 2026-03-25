# 阶段 C WeChat `/status` 纵向切片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 WeChat `/status` 纵向切片，让 broker 能向多个 OpenCode 实例收集插件侧 live snapshot，并返回多实例状态汇总。

**Architecture:** 本阶段不使用事件缓存做摘要，而是由每个实例内的 bridge 在收到 `collectStatus` 时调用 `input.client` 做实时读取。`session-digest.ts` 负责把真实 `Session` / `SessionStatus` / `QuestionRequest` / `PermissionRequest` / `Todo` / `Message+Part` 结构分类成可展示的 session 摘要；broker 只负责 fan-out / fan-in、超时标记和 `/status` 文案聚合。

**Tech Stack:** TypeScript, Node.js test runner, `@opencode-ai/plugin`, `@opencode-ai/sdk`, 现有 WeChat broker IPC (`node:net` / named pipe), file-based broker state from stage B

---

## 文件结构预分解

- `src/wechat/protocol.ts`
  - 扩展阶段 C 会真实使用的 `collectStatus` / `statusSnapshot` IPC message 类型
- `src/wechat/broker-client.ts`
  - 增加 bridge 侧处理 `collectStatus` 请求并回送 `statusSnapshot`
- `src/wechat/broker-server.ts`
  - 增加广播收集、1.5s 聚合窗口、`timeout/unreachable` 标记
- `src/wechat/session-digest.ts`
  - 新建纯函数分类层；输入真实 SDK live 数据，输出 `SessionDigest`
- `src/wechat/bridge.ts`
  - 新建 live snapshot 采集层；调用 `input.client` 的 `session / question / permission / todo / messages` 读面
- `src/wechat/status-format.ts`
  - 新建微信 `/status` 文案格式化层
- `src/wechat/command-parser.ts`
  - 新建最小 slash parser；本阶段只支持 `/status`
- `src/plugin-hooks.ts`
  - 首次接入 bridge 生命周期；只接 `/status` 纵向切片
- `test/wechat-session-digest.test.js`
  - 新建 / 扩展 live snapshot 分类测试
- `test/wechat-status-flow.test.js`
  - 新建 broker 聚合、局部降级、top 3 截断、文案测试
- `test/wechat-plugin-hooks-status.test.js`
  - 新建 `plugin-hooks` 最小接线测试，避免把通知或回复闭环提前带进来

## 实施约束

- 全程严格 TDD：先写失败测试，再做最小实现，再跑通过。
- 阶段 C 可以首次修改 `src/plugin-hooks.ts`，但只允许接 `/status` 相关 bridge 生命周期。
- 阶段 C 不实现事件通知。
- 阶段 C 不实现 `question` / `permission` 回复。
- 阶段 C 不把 broker 做成摘要缓存中心。
- 阶段 C 不展示 slash command / 最近 command。
- `session-digest.ts` 必须直接围绕真实 SDK / 样本结构编写，不能先造中间事件模型。
- 如需 git 提交，只能在用户明确要求时进行；本计划中的 checkpoint 仅用于检查 diff 边界，不自动提交。

## 读取面约束（实现前必须记住）

- `permission.list()` 与 `question.list()` 是一等、强语义、可直接展示的数据源。
- `session.status()` 返回按 `sessionID` 索引的状态映射。
- `session.todo(sessionID)` 返回当前 todo 列表。
- `session.messages(sessionID)` 返回 `Array<{ info: Message; parts: Part[] }>`，要从真实 part 结构中恢复 running / completed tool，以及 `tool="question"`、`tool="todowrite"` 等已观察到的 action 形态。
- `highlights` 是可并行展示的切片集合，不是只保留单个 `latestAction` winner。

### Task 1: 固定阶段 C 的 IPC 契约与聚合测试外壳

**Files:**
- Modify: `src/wechat/protocol.ts`
- Modify: `src/wechat/broker-client.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定 `collectStatus` / `statusSnapshot` 往返契约**

在 `test/wechat-status-flow.test.js` 先写这些断言：

- broker 能向在线实例发 `collectStatus(requestID)`；
- bridge 能回 `statusSnapshot(requestID, snapshot)`；
- broker 聚合窗口固定为 `1.5s`；
- 未回包实例被标记 `timeout/unreachable`；
- broker 只聚合 snapshot，不自己计算 digest。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: FAIL，因为阶段 C 的 collectStatus 协议和聚合尚未实现。

- [ ] **Step 3: 扩展 `src/wechat/protocol.ts`**

至少实现：

- `collectStatus`
- `statusSnapshot`
- 对应 envelope payload 类型

约束：

- 延续阶段 B 的 NDJSON 单行一帧规则；
- 不破坏既有 `registerInstance` / `heartbeat` / `ping` 行为；
- `statusSnapshot` 必须带 `requestID`，避免并发聚合串包。

- [ ] **Step 4: 在 `src/wechat/broker-client.ts` 增加最小 status 请求处理骨架**

至少实现：

- 注册 `collectStatus` handler
- 回送 `statusSnapshot`
- 单连接内支持多次 `collectStatus` 请求

- [ ] **Step 5: 在 `src/wechat/broker-server.ts` 实现最小聚合骨架**

至少实现：

- 广播 `collectStatus(requestID)`
- 收集 `statusSnapshot`
- 1.5s 窗口超时
- 标记未响应实例为 `timeout/unreachable`

- [ ] **Step 6: 跑定向测试确认协议层转绿**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: 至少 `collectStatus` 往返、聚合窗口和超时实例断言通过；文案与 digest 相关断言仍可继续失败。

### Task 2: 固定 `session-digest.ts` 的真实数据分类规则

**Files:**
- Create: `src/wechat/session-digest.ts`
- Test: `test/wechat-session-digest.test.js`

- [ ] **Step 1: 写失败测试，锁定真实数据结构输入与 `highlights` 规则**

在 `test/wechat-session-digest.test.js` 写这些断言：

- 输入直接使用真实 SDK 形态：`Session`、`SessionStatus`、`QuestionRequest[]`、`PermissionRequest[]`、`Todo[]`、`Array<{ info, parts }>`；
- `permission` 与 `question` 都能独立进入 `highlights`，不是二选一；
- `running tool`、`completed tool`、`todo` 可以与 `permission` / `question` 并行展示；
- `highlights` 顺序固定为 `permission -> question -> running-tool -> completed-tool -> todo -> status`；
- 真实 `tool="question"` 和 `tool="todowrite"` part 形态能被正确分类；
- `status` 固定作为尾部切片存在，不覆盖前面的切片。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-session-digest.test.js`
Expected: FAIL，因为 live snapshot 分类器尚未实现。

- [ ] **Step 3: 实现 `src/wechat/session-digest.ts` 的最小纯函数接口**

至少实现：

- `groupQuestionsBySession()`
- `groupPermissionsBySession()`
- `buildSessionDigest()`
- `pickRecentSessions()`

约束：

- 只做纯函数，不依赖 I/O；
- 不引入事件缓存；
- `SessionDigest.unavailable` 只表达 session 级 `messages` / `todo` 缺失。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-session-digest.test.js`
Expected: PASS，说明阶段 C 的真实数据分类规则已固定。

### Task 3: 实现 bridge live snapshot 采集

**Files:**
- Create: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-client.ts`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定 bridge 的 live 读取顺序与降级语义**

在 `test/wechat-status-flow.test.js` 增加断言：

- bridge 调用 `session.list()` 选最近活跃 session；
- bridge 调用 `session.status()` 并按 `sessionID` 回填；
- bridge 调用 `question.list()` / `permission.list()` 并按 `sessionID` 分桶；
- bridge 调用 `session.todo(sessionID)` / `session.messages(sessionID)`；
- `messages()` 失败时仍可返回 `permission` / `question` / `status`；
- `permission.list()` 失败只标实例级 unavailable，不导致整实例失败。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: FAIL，因为 bridge live snapshot 尚未实现。

- [ ] **Step 3: 实现 `src/wechat/bridge.ts` 最小采集器**

至少实现：

- `createWechatBridge()`
- `collectStatusSnapshot()`
- 内部并发读取 `session/status/question/permission/todo/messages`

约束：

- `permission.list()` / `question.list()` 是一等数据源，不当成弱摘要；
- 实例级 unavailable 与 session 级 unavailable 必须分开表达；
- snapshot 中每实例最多保留 3 个最近活跃 session。

- [ ] **Step 4: 将 bridge 接到 `broker-client` 的 `collectStatus` handler**

要求：

- `collectStatus` 时才触发 live 读取；
- 不维护后台事件订阅状态；
- 同一个 bridge 可重复响应多个请求。

- [ ] **Step 5: 跑定向测试确认 bridge 层转绿**

Run: `npm run build && node --test test/wechat-session-digest.test.js test/wechat-status-flow.test.js`
Expected: PASS 掉 live 读取顺序、分桶和降级相关断言；格式化与 hooks 接线断言仍可继续失败。

### Task 4: 实现 `/status` 文案与 broker 聚合输出

**Files:**
- Create: `src/wechat/status-format.ts`
- Create: `src/wechat/command-parser.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定 `/status` 文案边界**

在 `test/wechat-status-flow.test.js` 增加断言：

- 每个实例最多展示 3 个最近活跃 session；
- `permission / question / tool / todo / status` 可并行展示；
- 不展示 slash command / 最近 command；
- `timeout/unreachable` 有固定文案；
- session 级 unavailable 有局部降级文案；
- 实例级 unavailable 不等价于实例离线。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: FAIL，因为 `/status` 文案和最终聚合输出尚未实现。

- [ ] **Step 3: 实现 `src/wechat/status-format.ts`**

至少实现：

- `formatInstanceStatusSnapshot()`
- `formatAggregatedStatusReply()`

要求：

- `highlights` 按 spec 固定顺序渲染；
- `status` 作为尾部切片保留；
- 不因为 `messages()` 缺失而隐藏 `permission` / `question`。

- [ ] **Step 4: 实现 `src/wechat/command-parser.ts` 的最小 `/status` 解析**

至少实现：

- `parseWechatSlashCommand()`

要求：

- 只识别 `/status`；
- 对 `/reply` / `/allow` 保持未实现，不提前接业务。

- [ ] **Step 5: 在 `src/wechat/broker-server.ts` 接入格式化输出**

要求：

- broker 完成聚合后直接调用 formatter；
- broker 仍不计算 digest，只消费 bridge snapshot；
- 不提前写通知逻辑。

- [ ] **Step 6: 跑定向测试确认 `/status` 切片转绿**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: PASS，说明 `/status` 汇总、并行展示和降级文案成立。

### Task 5: 最小接入 `plugin-hooks.ts`

**Files:**
- Create: `test/wechat-plugin-hooks-status.test.js`
- Modify: `src/plugin-hooks.ts`
- Modify: `src/wechat/bridge.ts`

- [ ] **Step 1: 写失败测试，锁定 `plugin-hooks` 只接 `/status` 生命周期**

在 `test/wechat-plugin-hooks-status.test.js` 写这些断言：

- 插件启动时会创建 bridge，并带入真实 `input.client` / `input.project` / `input.directory` / `serverUrl`；
- hooks 只接 `/status` 这条收集链路；
- 不接事件通知；
- 不接 `question` / `permission` 回复。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-plugin-hooks-status.test.js`
Expected: FAIL，因为 `plugin-hooks` 尚未接入 bridge。

- [ ] **Step 3: 在 `src/plugin-hooks.ts` 做最小接线**

要求：

- 只实例化 bridge 生命周期；
- 只接 `/status` 需要的 broker 注册 / 收集路径；
- 不顺手订阅事件，不做通知，不做 question/permission reply。

- [ ] **Step 4: 跑定向测试确认 hooks 接线转绿**

Run: `npm run build && node --test test/wechat-plugin-hooks-status.test.js`
Expected: PASS。

### Task 6: 阶段 C 全量验收与边界检查

**Files:**
- Modify: `src/wechat/protocol.ts`
- Modify: `src/wechat/broker-client.ts`
- Modify: `src/wechat/broker-server.ts`
- Create: `src/wechat/session-digest.ts`
- Create: `src/wechat/bridge.ts`
- Create: `src/wechat/status-format.ts`
- Create: `src/wechat/command-parser.ts`
- Modify: `src/plugin-hooks.ts`
- Test: `test/wechat-session-digest.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-plugin-hooks-status.test.js`

- [ ] **Step 1: 跑阶段 C 定向测试**

Run: `npm run build && node --test test/wechat-session-digest.test.js test/wechat-status-flow.test.js test/wechat-plugin-hooks-status.test.js`
Expected: PASS。

- [ ] **Step 2: 跑阶段 A / B 回归**

Run: `npm run build && node --test test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js test/wechat-openclaw-host.test.js test/wechat-openclaw-smoke.test.js test/wechat-openclaw-guided-smoke.test.js test/wechat-openclaw-task3.test.js`
Expected: PASS，确认阶段 C 没破坏已有 broker 基座与 compat host。

- [ ] **Step 3: 检查 diff 边界**

Run: `git diff -- src/wechat/protocol.ts src/wechat/broker-client.ts src/wechat/broker-server.ts src/wechat/session-digest.ts src/wechat/bridge.ts src/wechat/status-format.ts src/wechat/command-parser.ts src/plugin-hooks.ts test/wechat-session-digest.test.js test/wechat-status-flow.test.js test/wechat-plugin-hooks-status.test.js`
Expected: 只包含 `/status` 纵向切片，不包含通知、token stale fallback、`/reply`、`/allow`。

## 阶段 C 完成判定

只有同时满足以下条件，阶段 C 才算完成：

1. WeChat `/status` 能触发 broker 聚合。
2. bridge 主要基于 `input.client` live 读取真实状态。
3. `permission.list()` 与 `question.list()` 按 `sessionID` 分桶并直接展示。
4. `session.status()` 与 `session.todo()` 被纳入真实 snapshot。
5. `session.messages()` 的真实 `Part` 被用于恢复 running / completed tool 细节。
6. `permission / question / tool / todo / status` 可并行展示，而不是单一 `latestAction` winner。
7. 不展示 slash command / 最近 command。
8. broker 不持久化 digest，也不成为摘要中心。
9. `src/plugin-hooks.ts` 已接入 bridge，但未越界到通知或回复闭环。
10. 阶段 A / B 回归全部通过。
