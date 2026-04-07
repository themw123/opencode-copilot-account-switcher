# WeChat Broker / Bridge Phased Implementation Plan

> 说明：本文件是原始 `2026-03-23-wechat-broker-bridge-phased-implementation.md` 缺失期间，基于当时仓库现状和已落地实现反推写出的重建稿。
> 它不是 2026-03-23 的原始计划版本；原始主计划现已恢复到同目录主路径。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重做既有阶段 A/B/C、JITI 入口、菜单绑定和 compat 2.0.1 迁移的前提下，补齐 WeChat 通知事件采集、真实发送链路、handle 驱动的 `/reply` / `/allow` 闭环，以及最小可靠性恢复语义。

**Architecture:** 继续沿既有 `bridge -> broker -> wechat ingress runtime` 架构推进，不新增旁路通知系统。桥接层负责基于 live read 生成通知候选，broker 负责标准化与持久化，运行时负责真实出站发送；回复闭环基于现有 `request-store` / `handle` 演进，不再使用“取第一条 pending 请求”的临时行为。

**Tech Stack:** TypeScript, Node.js test runner, existing broker client/server IPC, OpenCode SDK v2 live reads, `@tencent-weixin/openclaw-weixin@2.0.1` compat wrappers, existing WeChat state stores

---

## 文件结构预分解

- `src/wechat/notification-types.ts`
  - 新建；定义通知事件、通知记录、发送状态、幂等键输入与 UI 不可见的内部字段
- `src/wechat/notification-store.ts`
  - 新建；负责通知记录持久化、去重、状态迁移、过期清理
- `src/wechat/state-paths.ts`
  - 扩展通知状态目录与诊断文件路径 helper
- `src/wechat/bridge.ts`
  - 扩展桥接层 live read；从 `question.list`、`permission.list`、`session.status` 生成通知候选，并在注册后与心跳周期内按固定 IPC 消息推送 broker
- `src/wechat/protocol.ts`
  - 增加 bridge -> broker 的通知同步消息类型
- `src/wechat/broker-client.ts`
  - 支持桥接层主动推送通知候选
- `src/wechat/broker-server.ts`
  - 接收通知候选，标准化后写入 `notification-store` 与 `request-store`
- `src/wechat/notification-format.ts`
  - 新建；生成 question / permission / session error 微信文案
- `src/wechat/notification-dispatcher.ts`
  - 新建；从 store 拉取待发送通知，根据 `wechat.notifications` 与绑定状态发送，并回写发送结果
- `src/wechat/wechat-status-runtime.ts`
  - 扩展为可复用的 outbound sender 注入点；在轮询周期内顺带 drain 待发送通知
- `src/wechat/broker-entry.ts`
  - 把 dispatcher 接到现有 broker 微信运行时；把 `/reply` / `/allow` 从临时逻辑升级为 handle 驱动的稳定路由
- `src/wechat/request-store.ts`
  - 增加按 handle / requestID 查找 open 请求、标记 answered / rejected / expired 的辅助查询能力
- `src/wechat/command-parser.ts`
  - 从“只解析文本”升级到“解析 handle + payload”的 `/reply` / `/allow` 语法
- `src/common-settings-store.ts`
  - 如有必要，仅补通知 dispatcher 读取辅助，不改变既有配置结构
- `test/wechat-notification-store.test.js`
  - 新建；锁定通知记录 schema、状态迁移、清理与幂等键行为
- `test/wechat-notification-flow.test.js`
  - 新建；锁定 bridge 同步、broker 标准化、dispatcher 发送、配置开关与 session error 去重
- `test/wechat-request-store.test.js`
  - 扩展；锁定 handle 查询与状态回写
- `test/wechat-status-flow.test.js`
  - 扩展；锁定 `/reply q1 ...`、`/allow p1 ...` 新语法和 broker-entry 真实路由

## 实施约束

- 全程严格 TDD：先写失败测试，再做最小实现，再跑通过。
- 继续把 live read 视为 question / permission / session 状态的权威来源，不把 broker 改成长期业务摘要中心。
- 不直接从 UI 或 broker 触碰 upstream helper shape；仍通过 compat 层消费稳定接口。
- 通知发送必须尊重 `wechat.notifications.enabled/question/permission/sessionError` 与当前 `primaryBinding`。
- `/reply` / `/allow` 升级过程中，不允许保留“默认回复第一条 pending 请求”的模糊行为作为最终实现。
- 如需 git 提交，只能在用户明确要求时进行。

### Task 1: 固定通知事件模型与持久化语义

**Files:**
- Create: `src/wechat/notification-types.ts`
- Create: `src/wechat/notification-store.ts`
- Modify: `src/wechat/state-paths.ts`
- Test: `test/wechat-notification-store.test.js`

- [ ] **Step 1: 写失败测试，锁定通知记录模型、幂等键与状态迁移**

至少覆盖：

- `question` / `permission` / `sessionError` 三种 kind
- `pending -> sent -> resolved | failed | suppressed` 状态迁移
- 幂等键相同的 upsert 不重复造记录
- 终态记录保留后可被清理

示例目标结构：

```ts
type WechatNotificationKind = "question" | "permission" | "sessionError"

type WechatNotificationRecord = {
  key: string
  kind: WechatNotificationKind
  status: "pending" | "sent" | "resolved" | "failed" | "suppressed"
  instanceID: string
  sessionID?: string
  requestID?: string
  routeKey?: string
  handle?: string
  targetUserId: string
  createdAt: number
  sentAt?: number
  resolvedAt?: number
  failedAt?: number
}
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-notification-store.test.js`
Expected: FAIL，因为 `notification-store` 与路径 helper 尚未存在。

- [ ] **Step 3: 实现通知类型、状态目录和 store**

要求：

- 在 `state-paths.ts` 新增 `notifications/` 根目录 helper
- `notification-store.ts` 提供 `upsertNotification()`、`markNotificationSent()`、`markNotificationResolved()`、`markNotificationFailed()`、`listPendingNotifications()`、`purgeTerminalNotificationsBefore()`
- question / permission 记录允许携带 `routeKey` / `handle`
- session error 记录不依赖 `request-store`

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-notification-store.test.js`
Expected: PASS。

### Task 2: 让 bridge 把 live read 里的待通知对象同步给 broker

**Files:**
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/protocol.ts`
- Modify: `src/wechat/broker-client.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定 bridge -> broker 通知同步协议**

至少覆盖：

- `question.list()` 中的 pending question 会生成同步 payload
- `permission.list()` 中的 pending permission 会生成同步 payload
- `session.status()` 中 `retry` session 会生成 `sessionError` payload
- 首次注册后会立即同步一次，后续在 bridge 心跳周期内继续同步
- 重复同步同一对象时，broker 侧只会按幂等键更新，不会重复新增

示例协议扩展：

```ts
type SyncWechatNotificationsRequest = {
  id: string
  type: "syncWechatNotifications"
  payload: {
    instanceID: string
    notifications: WechatNotificationCandidate[]
  }
}
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-notification-flow.test.js`
Expected: FAIL，因为桥接层还不会同步通知候选。

- [ ] **Step 3: 实现 bridge 候选生成与 broker 接收**

要求：

- `bridge.ts` 在既有 live read 结果上追加通知候选构造，不重新引入第二套读取面
- `bridge.ts` 复用既有 heartbeat 周期做通知同步，避免新增旁路守护进程
- `protocol.ts` 增加 `syncWechatNotifications`
- `broker-client.ts` 在注册成功后和后续 heartbeat 周期支持主动上报通知候选
- `broker-server.ts` 接收候选并调用 `notification-store`

候选最小结构示例：

```ts
type WechatNotificationCandidate = {
  kind: "question" | "permission" | "sessionError"
  instanceID: string
  sessionID?: string
  requestID?: string
  title: string
  summary: string
  createdAt: number
}
```

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-notification-flow.test.js`
Expected: PASS，且同一候选重复上报不重复造记录。

### Task 3: 把 question / permission 候选接到 request-store 与 handle 模型

**Files:**
- Modify: `src/wechat/request-store.ts`
- Modify: `src/wechat/handle.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-request-store.test.js`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定 request-store 与通知候选的对齐规则**

至少覆盖：

- question / permission 候选第一次进入时生成稳定 `routeKey` 与 `handle`
- 同一 `requestID` 再次同步时复用原记录，不重排 handle
- 可以按 `handle` 找到当前 open 请求
- 终态请求不会被误当作可回复对象

示例新增查询接口：

```ts
async function findOpenRequestByHandle(input: {
  kind: "question" | "permission"
  handle: string
}): Promise<RequestRecord | undefined>
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-notification-flow.test.js`
Expected: FAIL，因为当前 `request-store` 还没有 handle 查询与候选对齐逻辑。

- [ ] **Step 3: 实现 request 对齐逻辑**

要求：

- `broker-server.ts` 在处理 `question` / `permission` 候选时同步 upsert `request-store`
- `handle.ts` 继续保持 `q1/p1` 前缀规则，不允许原始 `requestID` 直接作为 handle
- `request-store.ts` 新增按 `handle` / `requestID` 查询 open 请求的 helper

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-notification-flow.test.js`
Expected: PASS。

### Task 4: 接通真实微信通知发送链路

**Files:**
- Create: `src/wechat/notification-format.ts`
- Create: `src/wechat/notification-dispatcher.ts`
- Modify: `src/wechat/wechat-status-runtime.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/common-settings-store.ts`
- Test: `test/wechat-notification-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定 dispatcher 发送行为与开关语义**

至少覆盖：

- 总开关关闭时不发送任何通知
- `question` / `permission` / `sessionError` 各自受子开关控制
- 有 `primaryBinding.userId` 时才发送
- 发送成功后记录 `sent`
- 发送失败后记录 `failed`，且不在同一轮无限重试

示例格式化目标：

```ts
formatQuestionNotification({ handle: "q1", summary: "需要回答部署问题" })
// => "[Question q1] 需要回答部署问题\n使用 /reply q1 <内容> 回复"
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-notification-flow.test.js`
Expected: FAIL，因为 dispatcher 与格式化层尚未存在。

- [ ] **Step 3: 实现格式化器、dispatcher 与 runtime 注入点**

要求：

- `notification-format.ts` 统一生成三类通知文案
- `notification-dispatcher.ts` 基于 `common-settings-store` 和 `notification-store` 选择待发消息
- `wechat-status-runtime.ts` 增加可选 `drainOutboundMessages` 注入点，让 broker 生命周期可复用现有发送 helper
- `broker-entry.ts` 创建 dispatcher，并在 runtime 周期内 drain 通知

示例注入接口：

```ts
type OutboundWechatMessage = { to: string; text: string }

type DrainOutboundMessages = (send: (message: OutboundWechatMessage) => Promise<void>) => Promise<void>
```

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-notification-flow.test.js`
Expected: PASS，且发送记录按开关和绑定状态稳定变化。

### Task 5: 把 `/reply` / `/allow` 从临时实现升级为 handle 闭环

**Files:**
- Modify: `src/wechat/command-parser.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/wechat/request-store.ts`
- Modify: `src/wechat/notification-store.ts`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/wechat-request-store.test.js`

- [ ] **Step 1: 写失败测试，锁定 handle 语法与回复状态回写**

至少覆盖：

- `/reply q1 done` 会命中 handle 为 `q1` 的 open question
- `/allow p1 once approved` 会命中 handle 为 `p1` 的 open permission
- 未找到 handle 时返回稳定提示
- 回复成功后 `request-store` 标为 `answered` / `rejected`
- 对应通知记录标为 `resolved`

示例新语法：

```ts
parseWechatSlashCommand("/reply q1 deploy now")
// => { type: "reply", handle: "q1", text: "deploy now" }

parseWechatSlashCommand("/allow p1 always trusted")
// => { type: "allow", handle: "p1", reply: "always", message: "trusted" }
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-status-flow.test.js test/wechat-request-store.test.js`
Expected: FAIL，因为当前 parser 和 broker-entry 仍是“第一条 pending 请求”语义。

- [ ] **Step 3: 实现 handle 驱动的 reply / allow 路由**

要求：

- `command-parser.ts` 解析 handle
- `broker-entry.ts` 通过 `request-store` 查询对应 open 请求，再调用 `client.question.reply()` / `client.permission.reply()`
- 成功后回写 `request-store` 与 `notification-store`
- 未找到、已终态、handle 非法都返回稳定中文提示

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-status-flow.test.js test/wechat-request-store.test.js`
Expected: PASS。

### Task 6: 补齐最小可靠性、清理与回归验收

**Files:**
- Modify: `src/wechat/notification-store.ts`
- Modify: `src/wechat/notification-dispatcher.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-notification-store.test.js`
- Test: `test/wechat-notification-flow.test.js`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定去重、抑制与清理语义**

至少覆盖：

- 同一 `sessionError` 在未恢复前不会连续刷屏
- 已 `resolved` / `suppressed` / `failed` 且超过保留窗口的记录可清理
- broker 重启后重新同步同一 open request 时不会重发已发送通知，除非请求状态发生变化

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-notification-store.test.js test/wechat-notification-flow.test.js test/wechat-status-flow.test.js`
Expected: FAIL，因为当前还没有终态清理与重启后抑制语义。

- [ ] **Step 3: 实现最小恢复与清理逻辑**

要求：

- `notification-store.ts` 增加终态记录保留期清理
- `notification-dispatcher.ts` 对已发送且未变化的候选做抑制
- `broker-server.ts` 在重复同步时复用既有通知键，不重新生成 handle

- [ ] **Step 4: 跑阶段性回归集合确认转绿**

Run: `npm run build && node --test test/wechat-notification-store.test.js test/wechat-notification-flow.test.js test/wechat-request-store.test.js test/wechat-status-flow.test.js`
Expected: PASS。

### Task 7: 运行全量验证并更新相关文档引用

**Files:**
- Modify: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- Modify: `docs/superpowers/specs/2026-03-24-wechat-stage-b-broker-foundation-design.md`
- Modify: `docs/superpowers/specs/2026-03-25-wechat-stage-c-status-slice-design.md`
- Test: `test/wechat-notification-store.test.js`
- Test: `test/wechat-notification-flow.test.js`
- Test: `test/wechat-request-store.test.js`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 更新文档引用与实现后口径**

要求：

- 保留阶段 B/C 对这份总 spec 与 phased plan 的引用
- 在总体 spec 中把“最小 slash 入口”更新为实现后的闭环描述
- 不重写历史阶段，只补当前状态说明

- [ ] **Step 2: 跑微信相关定向测试集合**

Run: `npm run build && node --test test/wechat-notification-store.test.js test/wechat-notification-flow.test.js test/wechat-request-store.test.js test/wechat-status-flow.test.js`
Expected: PASS。

- [ ] **Step 3: 跑完整回归**

Run: `npm test`
Expected: PASS。

- [ ] **Step 4: 若用户要求提交，再按阶段整理 commit**

推荐 commit 边界：

- `feat(wechat): 收口通知事件模型与状态存储`
- `feat(wechat): 打通微信通知发送链路`
- `feat(wechat): 将回复命令升级为 handle 闭环`
- `docs(wechat): 更新总体设计与阶段引用`

默认不提交；只有用户明确要求时才执行。

## 自检清单

- 总 spec 里的未完成主线是否全部被 Task 2-6 覆盖。
- 计划是否明确承认当前 `/reply` / `/allow` 只是过渡实现，而不是从零开始。
- 所有新增文件路径是否指向真实仓库位置。
- 所有定向测试命令是否与现有 Node test runner 用法一致。
- 是否坚持先通知采集，再通知发送，再回复闭环，最后可靠性补齐。
