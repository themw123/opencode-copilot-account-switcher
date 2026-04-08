# WeChat Dead-Letter 独立轨迹设计

## 背景

原始 `2026-03-23-wechat-broker-bridge-design.md` 对恢复链路提出了两层要求：

1. 活跃 request 生命周期需要能走到 `expired` / `cleaned`；
2. dead-letter 需要作为独立排障轨迹保留固定窗口，并且不参与任何活跃路由。

当前仓库已经补齐了 request 生命周期、实例 stale 导致的 scope 级过期、broker 启动清理、idle 退出以及恢复观测事件，但 dead-letter 仍然没有作为一条独立轨迹存在。现在的 `expired` / `cleaned` 记录仍然混在 `requests/question|permission/*.json` 里，只能算生命周期状态本身，不能算原始设计意义上的 dead-letter。

## 目标

1. 为 WeChat broker 建立独立的 dead-letter 存储轨迹。
2. 让 dead-letter 只承担排障/审计职责，不进入任何活跃路由、handle 查找或 idle 判定。
3. 为需要排障追踪的终态分支写入 dead-letter 记录。
4. 为 dead-letter 提供默认 7 天保留、启动清理和周期清理。
5. 用最小测试覆盖证明 dead-letter 与 active request 彻底隔离。

## 非目标

1. 本轮不实现 `/recover`、菜单恢复入口、消息重放或 replay 机制。
2. 不把所有终态请求都写成 dead-letter。
3. 不改变现有 active request 文件作为生命周期真相源的职责。
4. 不把 dead-letter 反向接回 request 路由或 broker idle 判定。

## 方案选择

### 方案 A：独立 dead-letter 轨迹

做法：

- 在 `wechat/` 状态根下新增独立 dead-letter 目录。
- 保持 `request-store` 继续管理活跃 request 生命周期。
- broker 在指定终态分支额外落一份 dead-letter 记录。

优点：

- 最贴近原始设计里“dead-letter 只用于排障”的边界。
- 与 active request 职责分离，后续再补人工恢复时不会被生命周期文件语义拖住。

缺点：

- 会新增一套存储路径和清理逻辑。

### 方案 B：复用 `cleaned/expired` 文件，不新增 dead-letter 目录

做法：

- 继续依赖现有 `requests/*.json` 文件里的 `expired` / `cleaned` 状态。
- 仅补更多诊断字段。

优点：

- 改动最小。

缺点：

- 语义仍然混杂：生命周期状态文件和排障轨迹没有边界。
- 后续人工恢复仍会被迫直接依赖 active request 文件布局。

### 方案 C：只做轻量索引，正文仍在 request 文件

做法：

- 新建 dead-letter 索引文件，只记录 routeKey / reason / 时间；
- 详细正文仍回读 request 文件。

优点：

- 比全量复制记录更省空间。

缺点：

- 清理顺序和依赖关系更复杂。
- request 文件被 purge 后，索引会丢失意义或要求额外关联机制。

### 结论

采用方案 A。dead-letter 必须先成为独立轨迹，后续人工恢复才能建立在清晰边界上。

## 设计细节

### 1. 存储边界

active request 与 dead-letter 分离：

- active request 继续放在：
  - `wechat/requests/question/*.json`
  - `wechat/requests/permission/*.json`
- dead-letter 新增独立目录，例如：
  - `wechat/dead-letter/question/*.json`
  - `wechat/dead-letter/permission/*.json`

约束：

1. dead-letter 文件永远不参与 `findOpenRequest*`、`listActiveRequests()`、idle 判定或 handle 路由。
2. active request 被清理后，dead-letter 仍然可以独立保留到保留窗口结束。
3. dead-letter 清理不影响 active request 生命周期。

### 2. 记录模型

dead-letter 记录至少包含：

```ts
type WechatDeadLetterRecord = {
  kind: "question" | "permission"
  routeKey: string
  requestID: string
  handle: string
  scopeKey?: string
  finalStatus: "expired" | "cleaned"
  reason:
    | "instanceStale"
    | "startupCleanup"
    | "runtimeCleanup"
    | "manualCleanup"
    | "futureRecoveryFailed"
  createdAt: number
  finalizedAt: number
  wechatAccountId?: string
  userId?: string
  instanceID?: string
  sessionID?: string
}
```

说明：

- `finalStatus` 反映 request 最终落在哪个生命周期节点；
- `reason` 反映为什么需要进入排障轨迹；
- `instanceID/sessionID` 允许缺省，因为不是所有来源都能稳定拿到这两个字段。

### 3. 写入时机

本轮不为所有终态写 dead-letter，只覆盖需要排障追踪的分支：

1. 因实例 stale 而触发的 scope 批量 `expired`
2. broker 启动清理时处理出来的历史失效请求
3. broker 周期清理中认定为应保留排障痕迹的请求
4. 未来明确标记为 `futureRecoveryFailed` 的恢复失败分支

本轮明确不写 dead-letter 的情况：

1. 正常成功 `answered`
2. 正常用户拒绝 `rejected`
3. 只做常规 `cleaned` 而没有排障价值的普通终态

### 4. 清理语义

默认 dead-letter 保留窗口：`7 天`。

清理策略：

1. broker 启动时立即清理超过窗口的 dead-letter
2. broker 运行期间周期性清理超过窗口的 dead-letter
3. dead-letter 清理使用独立扫描，不复用 active request 的 purge 逻辑

这样可以保证：

- active request 生命周期和 dead-letter 保留窗口不会互相污染；
- 启动后不会残留无界增长的历史排障文件。

### 5. 观测与查询

这轮不做外部恢复入口，但要留最小可观测能力：

1. broker 侧诊断事件可补：
   - `deadLetterWritten`
   - `deadLetterPurged`
2. 可增加最小读取 helper，用于测试和后续状态检查，例如：
   - `listDeadLetters(kind?)`
   - `deadLetterPath(kind, routeKey)`

这些 helper 只服务测试和内部排障，不构成用户可见功能。

## 测试策略

至少覆盖：

1. dead-letter 写入只发生在指定失效分支，而不是所有终态
2. dead-letter 写入后，active request 查找结果不受影响
3. broker 启动会立即 purge 超期 dead-letter
4. 周期清理会删除超期 dead-letter
5. `listActiveRequests()` / idle 判定不会把 dead-letter 当作阻塞项

## 成功判定

完成后应满足：

1. dead-letter 已经成为独立于 active request 的 broker 排障轨迹
2. 原始设计里的“dead-letter 只用于排障，不参与活跃路由”已经在代码层真实成立
3. dead-letter 有固定保留窗口，且启动/周期清理都可工作
4. 当前实现仍未引入人工恢复动作，但已经为下一条“人工恢复”线建立干净边界
