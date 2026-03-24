# 阶段 B WeChat Broker 单例基座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地阶段 B 的真实 detached broker 基座，完成 connect-or-spawn、实例注册、最小鉴权、心跳保活和共享状态文件，同时严格不越界到 `/status`、事件通知或 `question` / permission 业务。

**Architecture:** 采用 `node:net` 本地 socket/Windows named pipe 作为 broker/bridge 间的本地 IPC，消息固定为 NDJSON 单行一帧。`broker-launcher` 负责 connect-or-spawn 与 `launch.lock` 竞争，`broker-entry`/`broker-server` 提供 detached broker 生命周期，stores 负责把 `operator`、`token`、`request` 和 `instances` 语义先稳定下来，Task 2 的所有测试只围绕单例、注册、鉴权、活性与持久化契约展开。

**Tech Stack:** TypeScript, Node.js test runner, `node:net`, file-based state under `~/.config/opencode/account-switcher/wechat/`, `@tencent-weixin/openclaw-weixin`（仅沿用阶段 A 已验证依赖，不在本阶段接入业务流）

---

## 文件结构预分解

- `src/store-paths.ts`
  - 新增 `wechat` 根目录 helper
- `src/wechat/state-paths.ts`
  - `wechat/` 根目录、`broker.json`、`launch.lock`、`operator.json`、`instances/`、`tokens/`、`requests/` 的路径 helper 与 ensure 能力
- `src/wechat/protocol.ts`
  - NDJSON message envelope、阶段 B 已实现消息、future message 类型、最小错误 payload 结构
- `src/wechat/handle.ts`
  - `routeKey` / `handle` 生成与校验
- `src/wechat/operator-store.ts`
  - `operator.json` 读写、首次绑定/拒绝/重置语义
- `src/wechat/ipc-auth.ts`
  - `sessionToken` 生成、连接内存映射、关键消息校验
- `src/wechat/token-store.ts`
  - `contextToken` 最近入站覆盖、`stale` 标记但不删除
- `src/wechat/request-store.ts`
  - request schema、`markCleaned()`、`purgeCleanedBefore()`、TTL 与 7 天保留
- `src/wechat/broker-client.ts`
  - 连接 broker、发送/接收 NDJSON、注册、`ping`、`heartbeat`
- `src/wechat/broker-server.ts`
  - broker IPC server、register/heartbeat/ping、未鉴权拒绝、future message `notImplemented`
- `src/wechat/broker-launcher.ts`
  - connect-or-spawn、`launch.lock` 独占创建、重试与 double-check
- `src/wechat/broker-entry.ts`
  - detached broker 入口、写 `broker.json`、退出清理
- `test/wechat-state-paths.test.js`
  - 路径和目录布局测试
- `test/wechat-operator-store.test.js`
  - 单操作者语义测试
- `test/wechat-token-store.test.js`
  - token 语义测试
- `test/wechat-request-store.test.js`
  - request 生命周期与 handle 测试
- `test/wechat-broker-lifecycle.test.js`
  - 单例 broker、注册、鉴权、心跳、future message 行为测试

## 实施约束

- 全程严格 TDD：先写失败测试，再做最小实现，再跑通过。
- 阶段 B 不修改 `src/plugin-hooks.ts`。
- 阶段 B 不创建 `src/wechat/bridge.ts`、`src/wechat/session-digest.ts`、`src/wechat/status-format.ts`、`src/wechat/command-parser.ts`。
- 只实现 spec 中已锁定的消息：`registerInstance`、`registerAck`、`heartbeat`、`ping`、`pong`、`error`。
- future message 类型必须存在，但阶段 B 统一遵循 `invalidMessage -> unauthorized -> notImplemented`。
- `sessionToken` 只保存在 broker 内存，不写盘。
- 状态目录权限验收：POSIX 目录最低 `0700`、文件最低 `0600`；Windows 走“当前用户可访问”的 best-effort 探测与断言。

### Task 1: 固定 WeChat 状态路径与目录权限边界

**Files:**
- Modify: `src/store-paths.ts`
- Create: `src/wechat/state-paths.ts`
- Test: `test/wechat-state-paths.test.js`

- [ ] **Step 1: 写失败测试，锁定 `wechat/` 根目录与路径布局**

在 `test/wechat-state-paths.test.js` 写这些断言：

- `wechat` 根目录固定落在 `~/.config/opencode/account-switcher/wechat/`
- `broker.json`、`launch.lock`、`operator.json`、`instances/`、`tokens/`、`requests/question/`、`requests/permission/` 的 helper 路径正确
- `instances/<id>.json`、`tokens/<wechatAccountId>/<userId>.json`、`requests/<kind>/<routeKey>.json` 的派生路径稳定
- ensure 目录函数会创建完整目录树

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-state-paths.test.js`
Expected: FAIL，因为 `wechat` 路径 helper 与目录 ensure 逻辑尚未实现。

- [ ] **Step 3: 实现 `wechat` 根目录 helper**

在 `src/store-paths.ts` 增加：

- `wechatConfigDir()`

要求：

- 只基于现有 `accountSwitcherConfigDir()` 拼接 `wechat`
- 不在这里混入任何 broker/request/token 细节

- [ ] **Step 4: 实现 `src/wechat/state-paths.ts` 最小路径层**

实现至少这些导出：

- `wechatStateRoot()`
- `brokerStatePath()`
- `launchLockPath()`
- `operatorStatePath()`
- `instancesDir()` / `instanceStatePath(instanceID)`
- `tokensDir()` / `tokenStatePath(wechatAccountId, userId)`
- `requestKindDir(kind)` / `requestStatePath(kind, routeKey)`
- `ensureWechatStateLayout()`

- [ ] **Step 5: 补权限相关测试**

在 `test/wechat-state-paths.test.js` 增加断言：

- POSIX 环境下，ensure 后目录/文件创建策略满足 `0700` / `0600` 最低标准，或对应 helper 明确返回要使用的 mode 常量
- Windows 环境下，测试至少能识别“当前用户可访问”的 best-effort 分支，不把它误当成 POSIX mode 测试

- [ ] **Step 6: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-state-paths.test.js`
Expected: PASS，说明路径布局和权限边界已固定。

### Task 2: 固定 operator/token/request/handle 的文件语义

**Files:**
- Create: `src/wechat/handle.ts`
- Create: `src/wechat/operator-store.ts`
- Create: `src/wechat/token-store.ts`
- Create: `src/wechat/request-store.ts`
- Test: `test/wechat-operator-store.test.js`
- Test: `test/wechat-token-store.test.js`
- Test: `test/wechat-request-store.test.js`

- [ ] **Step 1: 写 operator-store 的失败测试**

在 `test/wechat-operator-store.test.js` 写这些断言：

- 首次绑定 `wechatAccountId + userId` 成功
- 第二个用户绑定被拒绝
- 显式 reset 后允许重新绑定
- `operator.json` 落盘字段固定为 `wechatAccountId`、`userId`、`boundAt`

- [ ] **Step 2: 写 token-store 的失败测试**

在 `test/wechat-token-store.test.js` 写这些断言：

- 最近一次入站 token 覆盖旧记录
- `staleReason` 只打标，不删除文件
- 不存在固定 TTL 自动失效
- `tokens/<wechatAccountId>/<userId>.json` 字段固定为 `contextToken`、`updatedAt`、`source`、`sourceRef?`、`staleReason?`

- [ ] **Step 3: 写 request-store/handle 的失败测试**

在 `test/wechat-request-store.test.js` 写这些断言：

- `routeKey` 与 `handle` 生成稳定，handle 大小写不敏感
- 原始 `requestID` 不能直接被接受为 handle
- request 状态机支持 `open -> answered|rejected|expired -> cleaned`
- `markCleaned()` 进入保留态
- `purgeCleanedBefore()` 会物理删除超过 7 天窗口的 `cleaned` 文件
- 活动索引忽略 `cleaned` 记录

- [ ] **Step 4: 跑 stores 定向测试确认先失败**

Run: `npm run build && node --test test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js`
Expected: FAIL，因为 operator/token/request/handle 文件能力尚未实现。

- [ ] **Step 5: 实现 `src/wechat/handle.ts`**

至少实现：

- `createRouteKey()`
- `createHandle(kind, existingHandles)`
- `normalizeHandle(input)`
- `assertValidHandleInput(input)`

要求：

- `question` 与 permission 都能生成未来可复用的短码
- 不接受原始 requestID 直接作为 handle

- [ ] **Step 6: 实现 `src/wechat/operator-store.ts`**

至少实现：

- `readOperatorBinding()`
- `bindOperator()`
- `resetOperatorBinding()`

要求：

- 第二个用户被拒绝时返回明确错误
- 不引入自动抢占或多操作者语义

- [ ] **Step 7: 实现 `src/wechat/token-store.ts`**

至少实现：

- `readTokenState()`
- `upsertInboundToken()`
- `markTokenStale()`

要求：

- 最近入站覆盖旧 token
- stale 打标不删除
- 仅保留 spec 要求字段

- [ ] **Step 8: 实现 `src/wechat/request-store.ts`**

至少实现：

- `upsertRequest()`
- `markRequestAnswered()`
- `markRequestRejected()`
- `markRequestExpired()`
- `markCleaned()`
- `purgeCleanedBefore()`
- `listActiveRequests()`

要求：

- 所有 request 文件都以 `routeKey` 为文件名基础
- `cleaned` 仍保留文件直到 purge

- [ ] **Step 9: 跑 stores 定向测试确认转绿**

Run: `npm run build && node --test test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js`
Expected: PASS，说明阶段 B 的文件语义已固定。

### Task 3: 固定 IPC 协议与 `sessionToken` 鉴权边界

**Files:**
- Create: `src/wechat/protocol.ts`
- Create: `src/wechat/ipc-auth.ts`
- Modify: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 写 broker 协议与鉴权的失败测试**

在 `test/wechat-broker-lifecycle.test.js` 先写协议层断言：

- NDJSON 单行一帧规则被显式使用
- envelope 固定包含 `id`、`type`、`instanceID?`、`sessionToken?`、`payload`
- `error` payload 至少含 `code`、`message`、`requestId`
- `error.code` 至少覆盖 `unauthorized`、`invalidMessage`、`notImplemented`、`brokerUnavailable`
- future message 在未注册/未带 token 时返回 `unauthorized`
- future message 在鉴权通过后返回 `notImplemented`

- [ ] **Step 2: 跑 broker 生命周期测试确认先失败**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: FAIL，因为协议和鉴权边界尚未实现。

- [ ] **Step 3: 实现 `src/wechat/protocol.ts`**

至少实现：

- envelope 类型
- 已实现消息类型：`registerInstance`、`registerAck`、`heartbeat`、`ping`、`pong`、`error`
- 预留消息类型：`collectStatus`、`replyQuestion`、`rejectQuestion`、`replyPermission`、`showFallbackToast`
- `serializeEnvelope()` / `parseEnvelopeLine()`
- `createErrorEnvelope(code, message, requestId)`

要求：

- 只允许 NDJSON 单行一帧
- 裸换行必须通过 JSON 字符串转义

- [ ] **Step 4: 实现 `src/wechat/ipc-auth.ts`**

至少实现：

- `createSessionToken()`
- `registerConnection(instanceID, connectionRef)`
- `validateSessionToken(instanceID, token)`
- `revokeSessionToken(instanceID)`
- `isAuthRequired(type)`

要求：

- `registerInstance` / `ping` 不要求 token
- `heartbeat` 和所有 future business message 都要求 token
- broker 重启后旧 token 默认失效

- [ ] **Step 5: 跑 broker 生命周期测试确认部分转绿**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: 仍可能 FAIL 在 broker 生命周期本体，但协议/鉴权断言已开始成立。

### Task 4: 落地 detached broker server 与 `broker.json`

**Files:**
- Create: `src/wechat/broker-server.ts`
- Create: `src/wechat/broker-entry.ts`
- Modify: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 补 broker server 启动与 `broker.json` 的失败测试**

在 `test/wechat-broker-lifecycle.test.js` 增加断言：

- broker 启动后写出 `broker.json`
- `broker.json` 固定包含 `pid`、`endpoint`、`startedAt`、`version`
- `version` 记录插件包版本，只用于观测，不参与阻断
- endpoint 只允许当前 OS 用户访问；POSIX 强校验 mode，Windows 走 best-effort 当前用户访问探测
- `ping` 返回 `pong`
- broker 退出时会清理自己写出的 `broker.json`

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: FAIL，因为 broker server 与 entry 尚未实现。

- [ ] **Step 3: 实现 `src/wechat/broker-server.ts` 最小 server**

至少实现：

- 启动 `node:net` server
- 接收 NDJSON 帧
- 处理 `ping`
- 处理 `registerInstance`
- 对 future message 执行 `invalidMessage -> unauthorized -> notImplemented`
- 对 `heartbeat` 执行 token 校验
- 在能力允许的前提下收紧 endpoint 访问到当前 OS 用户

- [ ] **Step 4: 实现 `src/wechat/broker-entry.ts` detached 入口**

至少实现：

- 解析启动参数或环境
- 创建 endpoint
- 启动 broker server
- 写出 `broker.json`
- 进程退出时清理 `broker.json`

要求：

- 明确 broker-entry 的 endpoint 传递方式（CLI 参数或环境变量二选一并固定）
- stale `broker.json` 场景下，client/launcher 首次连接失败要能归一成 `brokerUnavailable`，随后才进入重拉

- [ ] **Step 5: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: PASS 掉 `broker.json`、`ping/pong`、future message 错误优先级相关断言。

### Task 5: 落地 launcher/client、实例注册与心跳状态机

**Files:**
- Create: `src/wechat/broker-client.ts`
- Create: `src/wechat/broker-launcher.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 写 launcher/client 的失败测试**

在 `test/wechat-broker-lifecycle.test.js` 增加断言：

- 两个 launcher 并发时只会有一个 broker 被真正拉起
- `launch.lock` 采用独占创建锁文件，内容至少含 `pid` 和 `acquiredAt`
- 锁持有者消失后，后续 launcher 可重新竞争并完成 spawn
- client 能完成真实 `registerInstance -> registerAck(sessionToken, registeredAt, brokerPid)` 往返
- 同连接 + 同 `instanceID` 注册幂等
- 新连接 + 同 `instanceID` 注册会接管并使旧 token 失效
- 不同 `instanceID` + 同 `pid` 允许共存

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: FAIL，因为 connect-or-spawn、重复注册和接管语义尚未实现。

- [ ] **Step 3: 实现 `src/wechat/broker-client.ts`**

至少实现：

- `connect(endpoint)`
- `ping()`
- `registerInstance(meta)`
- `heartbeat()`
- 保存当前 `sessionToken`

要求：

- 注册成功后缓存 `sessionToken`、`registeredAt`、`brokerPid`
- 连接断开后不得继续发送需要 token 的关键消息

- [ ] **Step 4: 实现 `src/wechat/broker-launcher.ts`**

至少实现：

- 读取 `broker.json`
- 尝试连接并 `ping`
- 竞争 `launch.lock`
- 抢锁后做 double-check
- spawn detached `broker-entry`
- 固定短退避重试（例如 `250ms` 量级）

- [ ] **Step 5: 扩展 `src/wechat/broker-server.ts` 的注册状态机**

实现这些语义：

- 同连接 + 同 `instanceID` 返回幂等注册结果
- 新连接 + 同 `instanceID` 接管旧映射并生成新 token
- `pid` 只是观测字段，不做唯一键
- `registerAck` 最少返回 `sessionToken`、`registeredAt`、`brokerPid`

- [ ] **Step 6: 跑 broker 生命周期测试确认转绿**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: PASS，说明单例 broker、注册往返与重复注册语义成立。

### Task 6: 落地 `instances/` 心跳持久化与 stale 恢复

**Files:**
- Modify: `src/wechat/broker-server.ts`
- Modify: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 写 `instances/` 心跳持久化的失败测试**

在 `test/wechat-broker-lifecycle.test.js` 增加断言：

- 注册成功立即写入 `instances/<instanceID>.json`
- 字段固定为 `instanceID`、`pid`、`displayName`、`projectDir`、`connectedAt`、`lastHeartbeatAt`、`status`、`staleSince?`
- broker 周期扫描在超时后把状态转成 `stale`
- 后续合法 `heartbeat` 会把 `stale` 恢复成 `connected` 并清空 `staleSince`
- 默认超时阈值为 `30_000ms`，测试可覆盖

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: FAIL，因为 `instances/` 持久化与 stale 恢复尚未实现。

- [ ] **Step 3: 实现 broker 内部实例快照写盘**

要求：

- 注册成功立即写文件
- `heartbeat` 刷新 `lastHeartbeatAt`
- 状态初始为 `connected`

- [ ] **Step 4: 实现 broker 周期扫描与 stale 恢复**

要求：

- 默认阈值常量为 `30_000ms`
- 周期扫描负责 `connected -> stale`
- 合法后续 `heartbeat` 负责 `stale -> connected`
- 阶段 B 不做自动删除和 resync

- [ ] **Step 5: 跑 broker 生命周期测试确认转绿**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: PASS，说明保活与 `instances/` 快照语义成立。

### Task 7: 做阶段 B 全量验收

**Files:**
- Modify: `src/store-paths.ts`
- Create: `src/wechat/state-paths.ts`
- Create: `src/wechat/protocol.ts`
- Create: `src/wechat/handle.ts`
- Create: `src/wechat/operator-store.ts`
- Create: `src/wechat/ipc-auth.ts`
- Create: `src/wechat/token-store.ts`
- Create: `src/wechat/request-store.ts`
- Create: `src/wechat/broker-client.ts`
- Create: `src/wechat/broker-server.ts`
- Create: `src/wechat/broker-launcher.ts`
- Create: `src/wechat/broker-entry.ts`
- Test: `test/wechat-state-paths.test.js`
- Test: `test/wechat-operator-store.test.js`
- Test: `test/wechat-token-store.test.js`
- Test: `test/wechat-request-store.test.js`
- Test: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 运行阶段 B 全量定向测试**

Run: `npm run build && node --test test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js`
Expected: PASS。

- [ ] **Step 1.5: 验证 stale broker 恢复路径**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: 其中 stale `broker.json` 场景先产生可识别的 `brokerUnavailable`，随后 launcher 能完成重拉并恢复连接。

- [ ] **Step 2: 运行阶段 A 回归，确认没有破坏既有链路**

Run: `npm run build && node --test test/wechat-openclaw-host.test.js test/wechat-openclaw-smoke.test.js test/wechat-openclaw-guided-smoke.test.js test/wechat-openclaw-task3.test.js`
Expected: PASS。

- [ ] **Step 3: 检查 diff 边界**

Run: `git diff -- src/store-paths.ts src/wechat/state-paths.ts src/wechat/protocol.ts src/wechat/handle.ts src/wechat/operator-store.ts src/wechat/ipc-auth.ts src/wechat/token-store.ts src/wechat/request-store.ts src/wechat/broker-client.ts src/wechat/broker-server.ts src/wechat/broker-launcher.ts src/wechat/broker-entry.ts test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js`
Expected: 只包含阶段 B broker 基座与共享状态改动，不包含 `src/plugin-hooks.ts` 或 Task 3 业务逻辑。

## 阶段 B 完成判定

只有同时满足以下条件，阶段 B 才算完成：

1. `test/wechat-state-paths.test.js` 通过
2. `test/wechat-operator-store.test.js` 通过
3. `test/wechat-token-store.test.js` 通过
4. `test/wechat-request-store.test.js` 通过
5. `test/wechat-broker-lifecycle.test.js` 通过
6. future message 的错误优先级符合 `invalidMessage -> unauthorized -> notImplemented`
7. 双 launcher 并发只拉起一个 detached broker
8. `instances/<instanceID>.json` 能完成 `connected -> stale -> connected` 状态转换
9. `src/plugin-hooks.ts` 未被改动
10. `/status`、事件通知、`question` / permission 业务仍未被提前实现
