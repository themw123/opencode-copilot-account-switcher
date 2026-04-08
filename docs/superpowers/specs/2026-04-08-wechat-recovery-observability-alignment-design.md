# WeChat 恢复与观测对齐设计

## 背景

原始 `2026-03-23-wechat-broker-bridge-design.md` 把 broker/bridge 的恢复语义定义得比较完整，包括：

- `open -> answered|rejected|expired -> cleaned` 请求状态机
- dead-letter 保留与清理
- broker idle 退出不被历史请求永久阻塞
- broker 重启接管与实例状态清理
- bridge 在 broker 重连后的 full sync
- 恢复路径可诊断，而不是静默失败

当前仓库已经具备 WeChat 真实入口、`/status`、通知、handle 驱动回复、绑定和真实 host gate，但恢复/观测这条线仍未完整对齐原始设计。

## 目标

1. 把 request 生命周期完整收口到 `open -> answered|rejected|expired -> cleaned`。
2. 为 question/permission 请求补齐 dead-letter 保留和清理语义。
3. 让 broker 生命周期不再被僵尸请求永久阻塞，并能在重启后做最小一致性清理。
4. 让 bridge / broker 断线后具备最小 full sync 恢复能力。
5. 为恢复、过期、死信、重连这些路径补齐最小可用的结构化诊断输出。

## 非目标

1. 不在这一步实现新的可视化恢复 UI。
2. 不引入第二套独立 recovery 子系统。
3. 不重写现有通知、绑定、真实 host gate 主链。
4. 不在这一步扩展多操作者或多微信用户模型。

## 方案选择

### 方案 A：沿既有 store/launcher/bridge 补齐恢复语义

做法：

- 继续以 `request-store` 作为请求状态机真相源。
- 在 `broker-launcher` / `broker-server` 上补 broker 生命周期与重启清理分支。
- 在 `bridge` 上补 broker 重连后的 full sync。
- 用诊断事件/文件补最小观测面。

优点：

- 与当前实现最连续。
- 变更集中在现有边界内，风险最可控。
- 最符合“按原始设计对齐，但不另造一套系统”的原则。

缺点：

- 需要较细地梳理现有状态机边界。

### 方案 B：单独新建 recovery manager

做法：

- 新建专门 recovery 子系统，统一接管 expired、dead-letter、重连与观测。

优点：

- 概念上更集中。

缺点：

- 会引入新的中心层，容易和现有 `request-store` / `broker-launcher` / `bridge` 职责重叠。
- 风险明显高于方案 A。

### 结论

选方案 A。恢复与观测对齐必须沿当前架构增量落地，而不是再引入一个新中心层。

## 设计细节

### 1. request 生命周期

`request-store` 需要稳定支持以下状态：

- `open`
- `answered`
- `rejected`
- `expired`
- `cleaned`

规则：

1. bridge 首次同步 question/permission 时创建 `open` 记录。
2. broker 收到真实回复成功回执后进入 `answered` 或 `rejected`。
3. 若目标实例离线过久、请求超过 TTL，或 full sync 确认请求已不存在，则转为 `expired`。
4. `expired`/`answered`/`rejected` 记录进入终态保留窗口，之后转为 `cleaned` 或移出活动索引。

### 2. dead-letter 与保留窗口

需要把终态请求与 dead-letter 视为两个层次：

1. 活动索引
   - 只保留 `open` 与短期可恢复的 `expired`
2. dead-letter 记录
   - 用于排障和恢复追踪
   - 默认保留固定窗口

要求：

- dead-letter 清理必须可重复执行。
- 清理后不能再影响 broker idle 判定。

### 3. broker 生命周期

`broker-launcher` / `broker-server` 需要补齐：

1. 旧 pid 接管
   - `broker.json` 指向的旧 pid 不存在时允许覆盖接管
2. idle 退出判定
   - 只有“无实例在线”且“无活动 open 请求”同时成立，才允许 idle 退出
   - 已过期/已清理请求不能永久阻塞退出
3. 启动清理
   - broker 启动时扫描 stale instance、expired request、dead-letter 保留窗口

### 4. bridge 重连与 full sync

当 bridge 发现 broker 断线并重新连上后，需要跑一轮最小 full sync：

- `session.status()`
- `question.list()`
- `permission.list()`

这轮 full sync 的目标不是重建完整历史，而是把当前真实 open 状态重新灌回 broker，修正 broker 内存与磁盘状态。

### 5. 观测与错误路径

本次不做复杂 UI，但要补齐最小可诊断能力：

1. 结构化诊断事件
   - request expired
   - request cleaned
   - dead-letter written
   - broker takeover
   - broker idle blocked / unblocked
   - bridge resync started / completed / failed
2. 最小错误码或稳定错误标签
   - 让测试和排障不再依赖模糊字符串匹配

## 测试策略

至少需要覆盖：

1. `request-store` 状态迁移与清理
2. dead-letter 保留/过期删除
3. broker idle 退出不被 expired 请求卡死
4. broker 重启后 stale 状态清理
5. bridge 重连后的 full sync 能恢复 open 请求视图
6. 诊断事件在关键恢复分支上会被写出

## 成功判定

当这条对齐工作完成时，应满足：

1. 原始设计里的恢复状态机已经在当前代码中有真实实现。
2. 历史请求不会无限制阻塞 broker 生命周期。
3. broker/bridge 断线后能通过 full sync 回到最小一致状态。
4. 恢复、过期、死信、重连等关键路径具备基本可诊断性。
