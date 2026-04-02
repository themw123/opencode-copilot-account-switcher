# WeChat Broker / Bridge 总体设计（基于当前实现重建）

## 背景

原始的 `2026-03-23-wechat-broker-bridge-design.md` 已无法在当前仓库、git 历史和本机 OpenCode / DCP 持久化中恢复。本文件不是对缺失原文的逐字复刻，而是基于当前代码、现存阶段 spec 和已经完成的阶段实现，反推收束出的总体设计。

这份文档的职责，不是重复阶段 A/B/C、JITI 入口、菜单 follow-up、compat 2.0.1 迁移的逐项验收细节，而是把这些工作统一解释成一条完整主线，并明确当前仍未闭环的下一阶段工作面。

## 目标

这份总体设计只回答四个问题：

1. 当前 WeChat 集成的整体架构是什么。
2. 已实现能力与预留能力分别落在哪些层。
3. 哪些边界应被视为长期稳定约束。
4. 尚未完成的微信通知业务，应沿哪条主线继续实现。

## 非目标

这份总体设计不做这些事情：

1. 不重写阶段 A/B/C 各自已经定稿的详细验收口径。
2. 不把当前代码包装成“原计划已全部完成”。
3. 不直接展开为实现步骤级别的操作清单；步骤拆解放到 phased implementation plan。
4. 不把 transport、polling、sync-buf 之类内部细节直接抬升成用户能力设计。

## 总体结论

当前系统应被定义为：

> WeChat 状态查看链路已经成立，`question` / `permission` / `sessionError` 通知发送链路已经接通，`/reply` / `/allow` 已升级为 handle 驱动闭环；当前主线缺口主要收敛在 Stage G 级别的恢复、死信、人工恢复与观测增强。

这意味着仓库已经具备：

- 真实微信入口。
- broker 单例基座。
- 基于 OpenCode live read 的 `/status` 聚合链路。
- 微信菜单、绑定流程和通知配置结构。
- 与 `@tencent-weixin/openclaw-weixin@2.0.1` 对齐的 compat 适配层。

当前仓库已经具备：

- `question` / `permission` / `sessionError` 的真实微信通知发送链路。
- 与 request / handle / 通知链路对齐的 `/reply` / `/allow` 稳定闭环。
- 最小可靠性语义：终态保留与清理、`sessionError` 未恢复前抑制重复发送、broker 重启后同一 open request 不重发。

当前仍未完整具备：

- 更复杂的重放与死信编排（超出最小保留/抑制语义）。
- 人工恢复操作面与可审计的恢复轨迹。
- 跨进程锁/竞争场景下更结构化的错误码与恢复策略。
- 更明确的旧 binding pending 迁移策略与批量修复能力。

## 架构主线

整体主线固定为：

`真实微信入口 -> broker 单例基座 -> bridge live snapshot -> /status 聚合 -> 菜单/绑定/配置面 -> 通知业务与回复闭环`

其中 upstream 依赖通过 compat 层被隔离，不直接泄漏到 UI 或业务层。

## 分层设计

### 1. Compat / Upstream Adapter 层

职责：

- 适配 `@tencent-weixin/openclaw-weixin@2.0.1` 的公开 helper、账号源、QR gateway、`getUpdates()`、`sendMessageWeixin()`、sync-buf 能力。
- 向仓库业务层暴露稳定的内部接口。

边界：

- 业务层不能猜测上游 helper 签名。
- UI 层不能直接感知上游对象 shape。
- 版本差异必须在 compat 层吸收，而不是分散到菜单、绑定、broker 或 bridge 层。

### 2. WeChat Ingress Runtime 层

职责：

- 在 broker 进程侧维护真实微信账号状态。
- 周期性轮询 `getUpdates()`。
- 识别入站 slash 文本。
- 把 `/status` 等命令交给 broker 处理。
- 通过 `sendMessageWeixin()` 把回复发回同一微信会话。

边界：

- 这里只负责 transport、polling 和 slash 入口。
- 非 slash 输入继续固定提示，不进入 AI reply。
- 该层不维护业务摘要中心，不直接决定通知业务策略。

### 3. Broker Foundation 层

职责：

- 维持单例 detached broker。
- 负责 launcher / client / server 生命周期。
- 处理实例注册、`sessionToken` 鉴权、`ping` / `heartbeat`。
- 维护共享状态目录与最小恢复语义。
- 负责对实例 fan-out / fan-in。

边界：

- broker 是运行时协调中心，不是长期业务 digest 中心。
- broker 负责聚合与路由，不负责把 session 状态做成长期缓存真相源。

### 4. Bridge Live Snapshot 层

职责：

- 在每个 OpenCode 实例内通过 `input.client` 实时读取 session、question、permission、todo、message / part。
- 生成实例级 snapshot 与 `/status` 需要的展示摘要。

边界：

- 状态计算应优先依赖 live read，而不是事件缓存。
- bridge 是状态观察者和摘要构造者，不承担微信 transport。

### 5. WeChat Feature Surface 层

职责：

- 向用户暴露已实现的微信能力。
- 当前至少包括：`/status`、微信菜单、绑定 / 重绑、绑定信息展示、通知配置结构。

边界：

- 这一层只负责用户入口、配置面和业务动作编排。
- 这一层不直接调用 upstream helper，不直接处理 IPC 协议。

### 6. Notification Business 层

职责：

- 将 `question`、`permission`、`session error` 等 OpenCode 事件路由为真实微信通知。
- 后续承接 `/reply` / `/allow` 的回复闭环。

边界：

- 当前主链已落地通知采集、发送与 handle 回复闭环。
- 该层必须建立在既有 broker、bridge、config 和 request / handle 基座之上，而不是旁路新增第二套架构。
- 仍需在 Stage G 持续补齐恢复、死信、人工恢复与观测能力。

## 核心依赖方向

依赖方向固定为：

`feature surface / notification business -> broker API -> bridge live snapshot or event ingress -> compat adapters -> upstream openclaw-weixin`

反向约束必须长期成立：

- UI 不直接碰 compat helper。
- broker 不直接接管长期 session digest。
- transport 层不直接决定通知业务策略。
- upstream 版本差异不外溢到用户界面。

## 已实现基线

### 阶段 A 基线

已经成立：

- 最小 compat host 已验证真实插件可启动。
- slash-only guard 已成立。
- 非 slash 输入会 fail-fast 并回固定中文提示。
- guided smoke 已覆盖真实账号手测、证据写盘和 go/no-go 结论。

### Broker / Bridge 基线

已经成立：

- detached broker、launcher / client / server、实例注册、`sessionToken`、`ping` / `heartbeat`、共享状态目录。
- bridge 生命周期接线与 `/status` 的 live snapshot 收集。

### 微信真实入口基线

已经成立：

- 真实微信 `/status` 已通过 JITI + public helper 路线接入。
- broker 能轮询微信入站并将 `/status` 回复发回当前会话。
- 非 slash 仍然不会进入 AI reply。

### 菜单 / 绑定 / 配置基线

已经成立：

- 微信菜单入口与子菜单结构。
- `wechat-bind` / `wechat-rebind` 的真实绑定流程。
- `primaryBinding` 与 `wechat.notifications` 配置结构。
- 已绑定信息展示与通知开关持久化。

### Compat 2.0.1 基线

已经成立：

- `@tencent-weixin/openclaw-weixin` 已迁移到 `2.0.1`。
- compat 适配层已按 wrapper / adapter 方式收口，并吸收上游 shape 差异。

## 未完成主线

### Stage G：可靠性、恢复与观测增强

当前缺口：

- 在最小可靠性之上补齐更复杂的重放、死信与人工恢复流程。
- 为跨进程并发/竞争补齐更结构化的错误码与恢复分支。
- 增强观测面（诊断、统计、恢复轨迹）并定义可操作的排障入口。
- 明确旧 binding 下 pending 记录的迁移/清理策略，避免历史数据长期漂移。

## 已实现关键数据流

### `/status` 链路

当前已经成立的数据流：

1. 微信运行时轮询真实入站消息。
2. 识别 `/status`。
3. broker 向实例广播状态收集请求。
4. 每个 bridge 通过 `input.client` 做 live snapshot。
5. bridge 生成实例级摘要返回 broker。
6. broker 聚合并格式化多实例状态文本。
7. 微信运行时把回复通过 `sendMessageWeixin()` 发回原会话。

这条链路的关键原则是：

- snapshot 以 live read 为准。
- broker 负责聚合，不负责长期缓存状态真相。
- 非 slash 不进入 AI reply。

### 菜单 / 绑定链路

当前已经成立的数据流：

1. 用户进入菜单中的微信子菜单。
2. 绑定或重绑动作进入真实绑定流程。
3. 绑定结果写入本地绑定状态。
4. 菜单展示当前主绑定账号信息与通知配置。

这条链路的关键原则是：

- 菜单展示用户可理解的绑定信息。
- transport 内部字段不进入主展示面。
- 设置结构优先为未来多账号扩展保留形态。

## 后续主线设计

后续实现必须沿同一架构继续，而不是另起一套旁路逻辑。

### 恢复与死信

在现有最小语义上补齐：

- 可重放与不可重放事件的分流。
- 死信记录、保留窗口与回放入口。
- 人工恢复时的状态机约束与审计字段。

### 观测与错误码

在现有诊断基础上补齐：

- 面向恢复路径的结构化错误码。
- 关键链路统计（发送、失败、抑制、恢复）。
- broker/bridge/runtime 跨层关联的排障上下文。

### 迁移与清理策略

需要明确：

- rebind 或历史 binding 变更后的 pending/终态记录处理策略。
- 旧记录与新 key 规则并存时的兼容与清理节奏。

## 分阶段路线

在新的 phased plan 中，既有阶段 A/B/C、JITI 入口、菜单 follow-up、compat 2.0.1 迁移，以及后续 Stage D/E/F 都已落地并视为 baseline，不再重复拆解实现任务。

当前后续阶段收敛为：

1. `Stage G`
   - 可靠性、恢复与观测增强。

验收顺序固定为：

1. 先补齐恢复与死信策略。
2. 再补人工恢复与结构化错误码。
3. 最后补观测与迁移清理策略闭环。

## 风险与约束

### 风险 1：把通知业务偷渡进 broker 状态中心

控制：

- 仍以 bridge live read 和事件标准化为边界。
- broker 只做协调、转发、聚合和最小恢复，不做长期业务真相源。

### 风险 2：UI 直接感知 upstream 变化

控制：

- 所有 upstream 版本差异继续由 compat 层吸收。
- 菜单、绑定和通知层只消费仓库内部稳定接口。

### 风险 3：恢复逻辑侵入已稳定主链，导致既有能力回归

控制：

- 保持 D/E/F 既有行为不回退。
- Stage G 改动优先通过新增恢复分支落地，避免改写稳定路径。

### 风险 4：恢复逻辑提前侵入业务实现

控制：

- 当前只要求最小恢复语义。
- 复杂重放、死信和观测在 Stage G 统一处理。

## 测试与验证原则

总体设计要求后续每一阶段都同时提供：

- adapter / wrapper 契约测试。
- broker / bridge 协作测试。
- 用户入口回归测试。

至少需要长期保持的验证面：

1. 真实 `/status` 入口与非 slash 固定提示回归。
2. broker 单例、注册、鉴权、活性与共享状态文件回归。
3. 微信绑定、重绑、菜单展示与配置持久化回归。
4. compat 2.0.1 helper 适配契约回归。
5. 后续新增的通知发送、回复闭环和恢复语义回归。

## 成功判定

当这份总体设计被满足时，系统应呈现为：

1. 微信入口、broker 基座、bridge live snapshot、菜单绑定面、compat 适配层职责清晰且边界稳定。
2. `/status` 继续依赖 live snapshot，而不是回退到中心化摘要缓存。
3. `question` / `permission` / `sessionError` 通知与 handle 驱动 `/reply` / `/allow` 闭环稳定可用。
4. 后续 phased plan 主要围绕 Stage G 的恢复、死信、人工恢复与观测增强推进，而无需重议总体架构。

## 关联文档

这份总体设计由以下现存文档共同支撑：

- `docs/superpowers/specs/2026-03-23-wechat-stage-a-compat-host-design.md`
- `docs/superpowers/specs/2026-03-23-wechat-stage-a-guided-smoke-design.md`
- `docs/superpowers/specs/2026-03-24-wechat-stage-b-broker-foundation-design.md`
- `docs/superpowers/specs/2026-03-25-wechat-stage-c-status-slice-design.md`
- `docs/superpowers/specs/2026-03-25-wechat-jiti-status-ingress-design.md`
- `docs/superpowers/specs/2026-03-25-wechat-menu-binding-followup-design.md`
- `docs/superpowers/specs/2026-03-26-wechat-compat-2x-migration-design.md`
