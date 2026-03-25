# 阶段 A：`openclaw-weixin` 最小 Compat Host 风险收敛设计

## 背景

阶段 A 的目标不变：

1. 验证真实 `@tencent-weixin/openclaw-weixin` 是否能被最小 compat host 承载；
2. 验证 slash-only 路径是否可控；
3. 验证非 slash 消息是否会被 fail-fast 并回发固定告警；
4. 用真实微信账号手测收集阶段 B 必需的真实响应结构。

当前阶段 A 已完成最小宿主、slash-only guard、`self-test` 和 `real-account --dry-run`。

当前缺口是：真实账号手测还没有被收敛成一个可执行闭环。为解决这一点，阶段 A 的真实手测主流程统一收敛为 guided smoke 脚本，而不是继续分散在人工步骤里。

## 阶段目标

阶段 A 仍然只证明四件事：

1. 真实包可以通过公开插件入口在最小 compat host 下启动；
2. slash-only guard 能把 `/status`、`/reply`、`/allow` 收口到 stub/no-op 路径；
3. 非 slash 文本会触发固定中文告警，并验证真实回发链路；
4. 真实账号手测能留下可引用、可脱敏、可复核的响应样本。

## 非目标

阶段 A 不做：

1. broker / bridge / token store / request store；
2. 真正的 `/status` 聚合；
3. `question` / permission 回复闭环；
4. 正式事件通知系统；
5. 阶段 B/C/D 的业务逻辑。

## 命令入口

阶段 A 的命令入口分为三层：

- `wechat:smoke:self-test`
  - 宿主与 guard 自检入口
- `wechat:smoke:real-account -- --dry-run`
  - 真实手测前准备检查入口
- `wechat:smoke:guided`
  - **唯一真实账号手测闭环入口**

换句话说：

- `self-test` 和 `real-account --dry-run` 继续存在；
- 但真正的真实账号手测必须通过 `wechat:smoke:guided` 执行。

## 最小 compat host 边界

阶段 A 的最小 compat host 仍然维持三类接口边界：

### 必需接口

- 真实插件默认导出的 `register(api)`
- `runtime`
- `registerChannel()`
- gateway `startAccount` 所需最小上下文
- 非空 `channelRuntime`

### 可 stub / no-op 接口

- slash-only 路径未触达的 routing/session/reply 能力
- guided smoke 下只用于采样、不用于正式业务的最小运行时能力

### 禁止接口

- 普通微信文本继续进入 AI reply
- 在阶段 A 中生成正式业务回复
- 用本地伪插件对象冒充真实公开入口

## guided smoke 的角色

guided smoke 不是新的阶段目标，而是阶段 A 真实账号手测的统一执行器。

它负责：

1. 预检与 `self-test`
2. 二维码登录
3. slash 命令采样
4. 非 slash `10/10` 验证
5. 证据写盘与 `go-no-go` 更新

它不负责：

- 阶段 B 的正式业务语义
- broker 生命周期
- 真实 AI reply

## 交付物

阶段 A 的交付物仍固定为：

- `docs/superpowers/wechat-stage-a/compat-host-contract.md`
- `docs/superpowers/wechat-stage-a/api-samples-sanitized.md`
- `docs/superpowers/wechat-stage-a/go-no-go.md`
- `docs/superpowers/wechat-stage-a/evidence/README.md`

其中：

- `compat-host-contract.md` 是最小宿主契约；
- `api-samples-sanitized.md` 记录脱敏后的真实样本与字段说明；
- `go-no-go.md` 记录阶段 A 结论；
- `evidence/` 保存每次 guided run 的编号证据。

如果 guided smoke 在执行中发现新的最小宿主要求，必须同步更新 `compat-host-contract.md`。

## 状态与结论口径

必须区分：

- **运行状态**：`dry-run` / `ready` / `running` / `blocked` / `completed`
- **最终结论**：`go` / `no-go` / `known-unknown`

并且必须统一字段含义：

- 文档逐项检查可以写 `pass` / `fail` / `known-unknown`
- 阶段最终结论只能写 `go` / `no-go` / `known-unknown`

## 阶段 A 硬门槛

只有同时满足以下条件，阶段 A 才允许结束为 `go`：

1. `compat host + 自检 3/3 连续成功`
2. `/status`、`/reply`、`/allow` 真实采样落档
3. `非 slash 拒绝 + 告警回发 10/10 连续成功`
4. `阶段 B 关键字段清单完整，无关键字段缺失`
5. `go-no-go.md` 最终结论为 `go`

其中阶段 B 关键字段至少包括：

- 登录后认证相关字段
- `getupdates` 中的 `msgs`、`get_updates_buf`、`context_token`
- 命令消息入站中的用户标识与消息内容结构
- 告警回发成功与失败时的响应形态

## 失败判定

1. 二维码启动失败或等待超时
   - 运行状态：`blocked`
   - 最终结论：`known-unknown`

2. slash 三条命令任一未完成采样
   - 运行状态：`blocked`
   - 最终结论：`known-unknown`

3. 非 slash `10/10` 任一次失败
   - 运行状态：`completed`
   - 最终结论：`no-go`

4. 关键字段不完整
   - 最终结论：`known-unknown` 或 `no-go`
   - 不允许进入阶段 B

## 结论

阶段 A 现在的关键不再是“有没有 dry-run”，而是“能不能通过一个 guided smoke 命令把真实账号手测完整跑完并留下证据”。

因此，阶段 A 的正式设计现在统一为：

> 最小 compat host + slash-only guard + guided smoke 真实账号手测闭环。
