# WeChat 恢复与观测对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WeChat broker/bridge 当前实现补齐到原始 2026-03-23 设计要求的恢复、dead-letter、broker 生命周期、full sync 和最小观测语义。

**Architecture:** 不引入新的 recovery 中心层，而是在既有 `request-store`、`broker-launcher`、`broker-server`、`bridge` 上补齐状态机和恢复分支。请求状态继续以 `request-store` 为真相源，broker 生命周期由 launcher/server 收口，bridge 通过重连后的 full sync 恢复最小一致性，观测面以结构化诊断事件和稳定错误标签为主。

**Tech Stack:** TypeScript, Node.js test runner, existing WeChat broker/bridge runtime, local state files under `wechat/`, existing diagnostics helpers

---

## 文件结构预分解

- `src/wechat/request-store.ts`
  - 补 `expired` / `cleaned` / dead-letter / 保留窗口与查询辅助
- `src/wechat/state-paths.ts`
  - 如有缺口，补 dead-letter 或恢复诊断文件路径 helper
- `src/wechat/broker-launcher.ts`
  - 补 broker takeover、idle 判断与 stale 状态清理
- `src/wechat/broker-server.ts`
  - 补 request 状态迁移、startup cleanup、恢复分支和诊断事件写入
- `src/wechat/bridge.ts`
  - 补 broker 重连后的 full sync
- `src/wechat/*diagnostics*.ts` 或现有诊断写盘 helper
  - 复用或扩展现有诊断输出，不新增 UI
- `test/wechat-request-store.test.js`
  - 扩展 request 生命周期与 dead-letter 测试
- `test/wechat-broker-lifecycle.test.js`
  - 扩展 broker takeover / idle / cleanup 测试
- `test/wechat-recovery.test.js`
  - 扩展 bridge 重连 full sync 与恢复链路测试

### Task 1: 收口 request 生命周期与 dead-letter 语义

**Files:**
- Modify: `src/wechat/request-store.ts`
- Modify: `src/wechat/state-paths.ts`（如需要新增 dead-letter 路径 helper）
- Test: `test/wechat-request-store.test.js`

- [ ] **Step 1: 写失败测试，锁定 `open -> answered|rejected|expired -> cleaned` 状态迁移**

至少加这些断言：

```js
test("request store moves open request into expired when ttl is exceeded", async () => {
  // 创建 open request
  // 推进时钟
  // 运行 cleanup
  // 断言状态变为 expired
})

test("request store moves terminal request into cleaned after retention window", async () => {
  // 创建 answered/rejected/expired 终态 request
  // 推进时钟
  // 运行 cleanup
  // 断言活动索引已移除，终态被标记 cleaned 或转入 dead-letter
})
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-request-store.test.js`
Expected: FAIL，因为当前 store 还没有完整状态迁移与清理语义。

- [ ] **Step 3: 实现最小 request 状态机补齐**

要求：

- `request-store.ts` 明确写出 `open`、`answered`、`rejected`、`expired`、`cleaned`
- 增加 dead-letter 持久化或终态归档 helper
- 增加按 retention 窗口清理终态请求的逻辑

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-request-store.test.js`
Expected: PASS。

### Task 2: 收口 broker 生命周期与 idle/takeover 语义

**Files:**
- Modify: `src/wechat/broker-launcher.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 写失败测试，锁定 old pid takeover 与 idle 不被僵尸请求阻塞**

至少加这些断言：

```js
test("broker launcher takes over when broker.json pid is stale", async () => {
  // 写入 stale broker.json
  // 启动 launcher
  // 断言允许 takeover
})

test("expired requests do not block broker idle shutdown", async () => {
  // 构造无 bridge 在线 + 仅 expired request
  // 断言 idle timer 可进入退出条件
})
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 launcher/server 生命周期补齐**

要求：

- `broker-launcher.ts` 明确 stale pid takeover 分支
- `broker-server.ts` 的 idle 判断只把活动 open request 算作阻塞项
- startup 时清理 stale instance / expired request / old dead-letter

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-broker-lifecycle.test.js`
Expected: PASS。

### Task 3: 补 bridge 重连后的 full sync

**Files:**
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-client.ts`（如当前重连入口在此处）
- Test: `test/wechat-recovery.test.js`

- [ ] **Step 1: 写失败测试，锁定 broker 重连后会重新同步 live question/permission/session 状态**

至少加这些断言：

```js
test("bridge performs full sync after broker reconnect", async () => {
  // 模拟 broker 断线再恢复
  // 断言 bridge 重新读取 session.status/question.list/permission.list
  // 断言最新 open 状态重新灌回 broker
})
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-recovery.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现最小 full sync 恢复逻辑**

要求：

- `bridge.ts` 在 broker 重连后执行一次完整 live read
- full sync 只重建“当前真实 open 视图”，不重播整个历史
- 失败时写诊断事件，不静默吞掉

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-recovery.test.js`
Expected: PASS。

### Task 4: 补最小观测与错误标签

**Files:**
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/bridge.ts`
- Modify: 现有诊断 helper 文件（按仓库现状确定）
- Test: `test/wechat-recovery.test.js`
- Test: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 写失败测试，锁定恢复链路会输出结构化诊断事件**

至少加这些断言：

```js
test("recovery diagnostics record request_expired and dead_letter_written events", async () => {
  // 触发 expired -> dead-letter
  // 断言诊断输出包含稳定 event/type 字段
})

test("bridge resync failure emits stable diagnostic code", async () => {
  // 模拟 full sync 失败
  // 断言输出稳定 code/tag
})
```

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-recovery.test.js test/wechat-broker-lifecycle.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现最小诊断输出**

要求：

- 为 `request_expired`、`request_cleaned`、`dead_letter_written`、`broker_takeover`、`bridge_resync_started/completed/failed` 提供稳定 event/tag
- 诊断优先写现有文件/记录通道，不新建 UI

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-recovery.test.js test/wechat-broker-lifecycle.test.js`
Expected: PASS。

### Task 5: 运行回归并检查文档口径

**Files:**
- Modify: `docs/superpowers/specs/2026-04-08-wechat-recovery-observability-alignment-design.md`（如实现后需要补充结果口径）
- Test: `test/wechat-request-store.test.js`
- Test: `test/wechat-broker-lifecycle.test.js`
- Test: `test/wechat-recovery.test.js`

- [ ] **Step 1: 跑恢复相关定向测试集合**

Run: `npm run build && node --test test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js test/wechat-recovery.test.js`
Expected: PASS。

- [ ] **Step 2: 跑仓库全量测试**

Run: `npm test`
Expected: PASS。

- [ ] **Step 3: 检查 spec 口径与实现是否一致**

核对要点：

- spec 中 4 条目标都能映射到实际变更
- 不再保留“已对齐但代码没实现”的措辞

- [ ] **Step 4: 若用户要求提交，再整理 commit**

建议提交顺序：

- `feat(wechat): 收口 broker 请求恢复语义`
- `feat(wechat): 补齐 bridge 重连全量同步`
- `docs(wechat): 更新恢复与观测对齐说明`
