# 基于单例 Broker 的 OpenCode-WeChat Bridge PoC 设计

## 背景

当前需求不是单纯把 OpenCode 事件转发到一个通知渠道，而是希望同时满足三件事：

1. OpenCode 发生关键事件时，把通知发送到微信；
2. 微信可以主动触发状态报告；
3. 微信可以回复 OpenCode 里的 `question` / permission 等等待态交互。

用户已经明确给出一个重要约束：

- 不希望在本项目中自己实现微信私有或不稳定的通信接口；
- 优先复用 `@tencent-weixin/openclaw-weixin`，通过它暴露出的插件接入形态完成集成；
- 不走“逆向内部协议再自己重写微信 transport”的路线。

前期调研确认了两个关键事实：

- `opencode-notifier` 很适合帮助我们识别 OpenCode 侧真正要桥接的事件面，但它本身是单向本地通知插件，不适合直接承担双向微信桥；
- `@tencent-weixin/openclaw-weixin` 不是通用 SDK，而是 OpenClaw channel plugin。它天生假定由单一宿主管理账号级 `get_updates_buf` 游标和长轮询生命周期。

因此，如果每个 OpenCode 实例都各自启动一个微信 sidecar，会天然遇到同一微信账号被多个轮询器争抢 `get_updates_buf` 的问题，导致重复、漏消息或游标覆盖。PoC 必须先解决这个宿主与生命周期问题。

## 目标

1. 在不自研微信私有协议的前提下，复用 `@tencent-weixin/openclaw-weixin` 完成微信收发。
2. 支持 OpenCode 到微信的事件通知，至少覆盖：
   - `question.asked`
   - `permission.asked`
   - `session.status`
   - `session.idle`
   - `session.error`
   - 由 `message.part.updated` / `todo.updated` / `command.executed` 归纳出的最新动作摘要
3. 支持微信主动发送 `/status`，聚合同机多个 OpenCode 实例的状态。
4. 支持微信回复 `question` 与 permission，且真正执行仍走 OpenCode 官方 API。
5. 支持同一台机器上多个 OpenCode 实例同时运行，但微信 transport 始终只有一个真实轮询宿主。
6. 当 `context_token` 失效时，提供本地 fallback 提示，引导用户在微信发送 `/status` 重新激活。

## 非目标

1. PoC 不支持“在微信里自由聊天驱动 OpenCode AI”。
2. PoC 不支持多操作者、多订阅人、多微信用户广播。
3. PoC 不解决“从未给 bot 发过消息的冷启动主动推送”。
4. PoC 不实现完整 OpenClaw 宿主，也不承诺兼容 OpenClaw 全部 runtime 能力。
5. PoC 不改变本项目现有 Copilot/Codex 账号切换主线功能。

## 方案选择

本次在生命周期层面比较了三条路线：

### 方案 A：用户级单例 Broker

做法：

- 第一个 OpenCode 实例负责按需拉起一个用户级单例 broker；
- broker 独占微信轮询；
- 所有 OpenCode 实例通过本地 IPC 接入 broker。

优点：

- 真正解决多实例共享同一微信账号的问题；
- 仍然符合“插件随 OpenCode 起”的使用体验；
- 可以把微信协议面与 OpenCode API 面彻底解耦。

缺点：

- 需要多一个本地进程；
- 需要定义本地 IPC、锁和 crash recovery。

### 方案 B：实例内 leader 竞选

做法：

- 没有独立 broker；
- 多个插件实例中只有抢到锁的那个负责微信轮询，其余实例作为 follower。

优点：

- 进程更少；
- 理论上更贴近“没有额外常驻服务”。

缺点：

- leader 崩溃、锁续租、消息路由、重选时序都明显更复杂；
- 实现复杂度高于用户级单例 broker。

### 方案 C：外部独立服务

做法：

- 微信 broker 独立安装、独立启动；
- OpenCode 插件只做客户端。

优点：

- 架构最干净；
- 生命周期和多实例问题最简单。

缺点：

- 用户体验最差；
- 不符合“尽量随 OpenCode 自动工作”的预期。

### 选定方案：用户级单例 Broker

原因：

- 能在不牺牲多实例能力的前提下，保持较好的自动化体验；
- 可以把 `openclaw-weixin` 的宿主压力集中在一个地方；
- 可以把 OpenCode 侧状态、问答和 permission 映射成清晰的本地 bridge 协议。

## 设计细节

### 1. 总体组件边界

PoC 固定为四个组件：

1. `broker launcher`
   - 存在于每个 OpenCode 插件实例中；
   - 负责“尝试连接 broker -> 如不存在则竞争拉起 -> 成功后注册本实例”。
2. `singleton broker`
   - 用户级单例本地进程；
   - 独占微信轮询、共享 token 缓存、实例注册表、待处理请求映射。
3. `instance bridge`
   - 运行在每个 OpenCode 实例内；
   - 订阅本实例 OpenCode 官方事件，维护本地摘要，并响应 broker 的控制请求。
4. `shared local state`
   - 放在 `~/.config/opencode/account-switcher/wechat/`；
   - 存放 broker 元数据、锁、实例状态、token 缓存、待处理请求映射。

边界约束：

- 微信协议面只允许出现在 broker 中；
- OpenCode 官方 API 只允许由各实例 bridge 调用；
- broker 不直接执行任何 OpenCode 会话逻辑；
- bridge 不直接持有微信长轮询游标。

### 2. 本地状态目录与文件布局

PoC 统一使用：

```text
~/.config/opencode/account-switcher/wechat/
```

文件布局建议：

```text
broker.json
launch.lock
operator.json
instances/
  <instanceID>.json
tokens/
  <wechatAccountId>/
    <userId>.json
requests/
  question/
    <instanceID>__<requestID>.json
  permission/
    <instanceID>__<requestID>.json
```

各文件职责：

- `broker.json`
  - `pid`
  - `socketPath`
  - `startedAt`
  - `version`
- `launch.lock`
  - 防止多个实例并发拉起 broker
- `operator.json`
  - PoC 只支持单操作者，记录当前绑定的 `wechatAccountId` 与 `userId`
- `instances/<instanceID>.json`
  - 实例元信息与最近心跳
- `tokens/<wechatAccountId>/<userId>.json`
  - `contextToken`
  - `updatedAt`
  - `source`
  - `sourceRef?`
  - `staleReason?`
- `requests/question/<instanceID>__<requestID>.json`
  - question 到目标实例、目标 session 的映射
- `requests/permission/<instanceID>__<requestID>.json`
  - permission 到目标实例、目标 session 的映射

### 3. Broker 启动、连接与退出语义

默认语义：

- broker idle timeout：`5 分钟`
- 只有“无 bridge 在线”且“无未完成 question/permission”同时成立，才开始 idle 计时
- 请求状态机：`open -> answered|rejected|expired -> cleaned`
- 默认请求 TTL：`24 小时` 软上限；超过后不再阻止 broker idle 退出，只保留 dead-letter 记录用于排障

启动流程：

1. 插件实例启动时先尝试连接 `broker.json` 指向的 socket/pipe；
2. 如果连接失败，则竞争 `launch.lock`；
3. 抢到锁的实例负责拉起 detached broker；
4. 其余实例持续重试连接，不再重复拉起；
5. 连接成功后，bridge 调 `registerInstance(meta)` 完成注册。

退出流程：

1. broker 发现所有实例都失联或主动注销；
2. 若仍有待处理 question/permission，则继续存活；
3. 否则开始 5 分钟 idle 计时；
4. 期间若有实例重新注册，取消退出；
5. 真正退出前写回 `broker.json` 的清理状态。

请求清理语义：

- `open`：实例在线且请求仍待处理；
- `answered` / `rejected`：收到 bridge 成功回执后进入终态，等待清理；
- `expired`：实例离线过久、请求超过 TTL，或 bridge 在 full sync 中确认该请求已不存在；
- `cleaned`：从活动索引移除，仅保留短期 dead-letter 日志。

这样可以避免“僵尸请求永远阻止 broker 退出”。

dead-letter 保留策略：

- 默认保留 `7 天`；
- 启动时与周期清理任务都会删除超过保留期的 dead-letter 文件；
- dead-letter 只用于排障，不参与任何活跃路由。

### 4. Bridge 维护的本地摘要模型

每个 bridge 维护轻量 `session digest`：

```ts
type SessionDigest = {
  sessionID: string
  title: string
  status: "busy" | "idle" | "retry"
  latestAction: string
  pendingQuestionCount: number
  pendingPermissionCount: number
  updatedAt: number
}
```

事件来源：

- `session.status`
- `session.idle`
- `session.error`
- `message.part.updated`
- `todo.updated`
- `command.executed`
- `question.asked`
- `permission.asked`

“最新动作摘要”优先级：

1. 等待 `question`
2. 等待 permission
3. 运行中的 `tool.title`
4. 最近完成的 `tool.title`
5. 最近 `command.executed`
6. `todo.in_progress`
7. `idle`

这样 `/status` 汇总不需要每次完整回扫历史消息，只需桥接层持续更新摘要即可。

### 5. 事件通知推送流

流程：

1. bridge 收到关键事件；
2. bridge 更新本地 `session digest`；
3. 若事件属于可推送事件，则发送结构化通知给 broker；
4. broker 根据 `operator.json` 确定目标 `(wechatAccountId, userId)`；
5. broker 读取该目标的最新 `context_token`；
6. 通过微信 transport 发送通知；
7. 若发送失败，则：
   - 将 token 标记为 `stale`；
   - 调 `showFallbackToast()` 要求本地 bridge 提示用户；
   - fallback 文案固定为“微信会话可能已失效，请在微信发送 `/status` 重新激活”。

默认推送策略：

- `session.status: busy` 只更新状态，不立即推送；
- `question.asked` / `permission.asked` / `session.error` 立即推送；
- `session.idle` 根据最近状态变化做完成通知；
- 短时间重复事件由 broker 做去抖与合并。

### 6. 微信 `/status` 聚合流

流程：

1. broker 从微信侧收到 `/status`；
2. broker 刷新该操作者的最新 `context_token`；
3. broker 向所有在线 bridge 广播 `collectStatus(requestID)`；
4. 每个 bridge 返回：
   - `instanceName`
   - `pid`
   - `project`
   - `directory`
   - 最多 `N=3` 个最近活跃 session 的摘要
5. broker 等待 `1.5s` 聚合窗口；
6. broker 合并结果，形成一条或多条微信消息返回；
7. 未及时响应的实例记为 `timeout/unreachable`。

返回内容示例：

```text
[实例 A] repo-a
- Fix auth bug | s_123 | busy | 正在执行 Bash: npm test
- Release notes | s_456 | idle | 最近完成 tool: question

[实例 B] repo-b
- Codex sync | s_789 | retry | 等待 permission
```

### 7. `question` / permission 回复闭环

#### question

注册时：

```ts
type QuestionRoute = {
  requestID: string
  routeKey: string
  handle: string
  instanceID: string
  sessionID: string
  questions: Array<...>
  userId: string
  wechatAccountId: string
  createdAt: number
}
```

处理流：

1. bridge 看到 `question.asked`，写入 broker；
2. broker 为该请求生成一个全局唯一短码 `handle`，例如 `q-17`，并向微信发结构化提示，要求使用：

```text
/reply <qid> <answer...>
```

3. 这里的 `<qid>` 明确就是 `handle`，不是原始 `requestID`；broker 通过 `handle -> routeKey -> requestID` 反查唯一目标与答案；
4. broker 路由到目标 bridge；
5. 目标 bridge 调 OpenCode 官方 `question.reply()` 或 `question.reject()`；
6. 成功后 broker 关闭该请求映射；
7. 若实例离线、请求已失效或映射不存在，则回微信提示先发 `/status`。

`handle` 规则：

- 由 broker 生成；
- 推荐格式：前缀 `q-` 或 `p-` 加 4-6 位小写字母数字短码；
- 默认不区分大小写；
- 仅在对应请求存活期间有效，不复用到其他活跃请求；
- 若发生冲突，broker 必须重新生成，直到在当前活动请求集中唯一。

#### permission

注册时：

```ts
type PermissionRoute = {
  requestID: string
  routeKey: string
  handle: string
  instanceID: string
  sessionID: string
  title: string
  type: string
  metadata: Record<string, unknown>
  userId: string
  wechatAccountId: string
  createdAt: number
}
```

处理流：

1. bridge 看到 `permission.asked`，写入 broker；
2. broker 为该请求生成一个全局唯一短码 `handle`，例如 `p-08`，并向微信发结构化提示，要求使用：

```text
/allow <pid> once|always|reject
```

3. 这里的 `<pid>` 明确就是 `handle`，不是原始 `requestID`；broker 通过 `handle -> routeKey -> requestID` 反查唯一目标；
4. broker 路由到目标 bridge；
5. 目标 bridge 调 OpenCode 官方 `permission.reply()`；
6. 成功后 broker 关闭该映射。

PoC 约束：

- 不做自然语言理解；
- 只接受 slash 命令；
- 微信侧永远使用 broker 生成的全局唯一 `handle`，不直接暴露原始 `requestID`；
- 这样能把交互歧义降到最低。

### 8. 操作者与 `context_token` 模型

PoC 只支持单操作者语义：

- 当前用户首次用微信向 broker 发送 `/status` 或其他受支持指令时，broker 记录该 `wechatAccountId + userId` 到 `operator.json`；
- 后续所有通知默认都发给这个操作者。

绑定与切换规则：

- 初次绑定后，broker 会回微信确认“当前机器已绑定到该操作者”；
- 若后续有其他用户尝试操作，默认拒绝并提示“当前机器已绑定其他操作者”；
- 本地可以通过显式重置命令或删除 `operator.json` 解除绑定；
- PoC 不做自动抢占与多人切换，避免状态歧义。

`context_token` 策略：

- 键：`(wechatAccountId, userId)`
- 只信最近一次成功入站消息带来的 token
- 不预设固定 TTL
- 发送失败后标记 `stale`，但不立即删除历史记录
- 直到下一次微信入站消息刷新为止

token 元数据：

- `source` 固定记录来源类型，PoC 默认只允许 `wechat_inbound`
- `sourceRef` 可记录原始消息 ID 或调试线索
- 不再把 `sourceInstanceId` 作为必填字段，避免把“微信入站刷新 token”误写成某个 OpenCode 实例产生的状态

这样可以避免把“24 小时”之类未经证实的假设写死进系统语义。

### 9. `openclaw-weixin` 在 broker 内的承载方式

这里是 PoC 成败的关键收缩点。

PoC 明确只支持微信 slash 命令，不支持自由聊天。因此：

- broker 侧必须锁定 `@tencent-weixin/openclaw-weixin` 的精确版本或极窄 semver 范围，避免 compat host 随上游内部变动而静默失效；
- `openclaw-weixin` 仍然通过它公开的插件入口被加载；
- broker 提供一个最小 compat host 来调用其默认导出的 `register(api)`；
- compat host 只需要让插件能跑起微信轮询和 slash 命令路径；
- 不需要完整实现 OpenClaw 的 AI routing/session/reply 体系。

为什么这样有机会成立：

- 在 `process-message.ts` 中，slash 命令会先尝试处理；
- 只有未命中 slash 时，才继续进入 OpenClaw 的路由、session、reply 流；
- 这使得 PoC 可以把微信入口严格限制在 `/status`、`/reply`、`/allow` 等命令型交互上。

但仍需注意一点：

- 代码在 slash 处理前要求 `channelRuntime` 非空；
- 因此 compat host 不是“零宿主”，而是“最小宿主”；
- 需要提供最小 `runtime`、`registerChannel()` 和 `startAccount` 上下文，以及足以让 slash-only 流早返回的 no-op / stub `channelRuntime`。

PoC 对 compat host 的强约束：

1. 必须实现的宿主面
   - `register(api)` 调用入口
   - `runtime` 对象本身
   - `registerChannel()`
   - gateway `startAccount` 所需上下文
   - 非空 `channelRuntime`
2. 可用 no-op / stub 的宿主面
   - OpenClaw AI routing/session/reply 的大部分能力，但前提是 slash-only 路径没有越界调用
3. 禁止出现的行为
   - 任意自由聊天消息继续进入 OpenClaw AI reply 流
   - broker 在没有 bridge 参与的情况下自行生成 AI 回复
4. 保护措施
   - 只要检测到未命中 slash 且代码即将进入非 slash 路径，就立即拒绝消息并告警
   - 该拒绝必须回微信提示“PoC 当前仅支持命令型交互”

兼容性冒烟测试必须覆盖：

- 登录
- 长轮询重连
- `/status`
- `/reply`
- `/allow`
- token stale 后再次 `/status` 激活

这条路线满足用户原始约束：

- 我们没有自己实现微信私有协议；
- 我们是在包公开暴露的插件接入形态上承载它；
- 代价只是 broker 里要有一个最小 OpenClaw 兼容层。

### 10. 崩溃恢复与竞态控制

#### broker 崩溃

- bridge 检测到 IPC 断开后，按指数退避重连；
- 重连成功后执行全量 resync：
  - `session.status()`
  - `question.list()`
  - `permission.list()`
- 因此 question/permission 的真实状态不依赖 broker 内存。

#### bridge 崩溃

- broker 通过心跳超时把该实例标记为离线；
- `/status` 汇总中标记为 `timeout/unreachable`；
- 若该实例持有未完成 question/permission，则对应请求进入 `expired` 倒计时；
- 倒计时内返回给微信“该请求所在实例离线，请先恢复实例后再试”；
- 超过 TTL 后转为 dead-letter，不再阻止 broker idle 退出。

#### broker 重启接管

- 读取 `broker.json`，若旧 pid 已死则覆盖接管；
- 若旧 pid 仍活着，则不再拉起第二个 broker；
- 对 `instances/` 和 `requests/` 做启动时清理：
  - 过期心跳实例标记 stale
  - 已关闭请求在 resync 后删除
  - 已超时请求转为 dead-letter

#### token 竞争

- 每次入站微信消息刷新 token 时，都写入 `updatedAt` 与 `source/sourceRef`；
- broker 总是取最近的、未标记 stale 的 token；
- 因为 PoC 是单操作者模型，所以不存在多用户 token 冲突。

### 11. IPC 协议

本地 IPC 仅保留两组方向：

#### bridge -> broker

- `registerInstance(meta)`
- `heartbeat(stats)`
- `upsertSessionDigest(digest)`
- `removeSessionDigest(sessionID)`
- `upsertQuestion(request)`
- `closeQuestion(requestID)`
- `upsertPermission(request)`
- `closePermission(requestID)`
- `reportSendFallback(event)`

#### broker -> bridge

- `collectStatus(requestID)`
- `showFallbackToast(message, variant)`
- `replyQuestion(requestID, answers)`
- `rejectQuestion(requestID)`
- `replyPermission(requestID, reply, message?)`
- `ping()`

约束：

- broker 不主动修改 session 内容；
- 所有涉及 OpenCode 会话状态改变的动作都必须由 bridge 执行；
- 这样 broker 与 OpenCode 会话解耦最彻底。

### 12. IPC 安全与访问控制

PoC 不追求跨用户或跨机器安全模型，但必须明确“同机、同 OS 用户”是唯一信任边界。

最小安全要求：

1. IPC 端点只允许当前 OS 用户访问
   - Unix 使用 `600/700` 等价权限
   - Windows 使用当前用户 ACL
2. 状态目录同样只允许当前用户读写
3. `registerInstance()` 成功后，broker 下发短期会话凭证
4. 后续所有 broker/bridge 消息都必须携带该会话凭证
5. `replyQuestion` / `replyPermission` 等关键指令必须做来源校验与幂等检查

这样可以避免同机其他进程伪造 IPC 消息，越权批准 permission 或注入回复。

### 13. 验证策略

#### 单元测试

- `session digest` reducer
- token 状态机
- request 映射持久化
- IPC 编解码

#### 集成测试

- 两个 OpenCode 实例 + 一个 broker
- 验证 `/status` 聚合
- 验证 `question.reply`
- 验证 `permission.reply`
- 验证 broker 崩溃后 bridge 重连与 resync
- 验证微信误传原始 `requestID` 时被明确拒绝，并提示使用 `qid/pid handle`

#### 手动验证

- 故意让 token 失效，确认本地 toast 正确触发
- 在微信发送 `/status`，确认 token 被刷新
- 在不同实例中同时制造 question/permission，确认路由不会串台

## 风险与后续

### 1. `openclaw-weixin` 的最小宿主面仍可能比预期大

虽然 slash-only PoC 显著缩小了宿主范围，但仍需实际验证最小 compat host 是否足够让插件稳定运行。

### 2. `context_token` 的真实失效语义未知

目前只能以“发送失败后视为 stale”的方式建模，不能把未证实的 24 小时窗口写成强语义。

### 3. PoC 不支持微信自由聊天

这是主动收缩。如果未来要在微信里直接驱动 OpenCode 任务，则必须扩展 compat host 的 OpenClaw runtime 面。

### 4. Windows 命名管道 / 跨平台 IPC 细节仍需落到实现阶段确认

PoC 当前只定义语义，不提前锁死具体 IPC 传输实现。

## 结论

在“不要自研微信私有协议、优先复用 `openclaw-weixin`”的约束下，最现实的 PoC 路线是：

- 用用户级单例 broker 独占微信 transport；
- 用每个 OpenCode 实例内的 bridge 负责 OpenCode 官方 API 调用；
- 用本地 IPC 连接两者；
- 用 slash-only 交互把 `openclaw-weixin` 的宿主范围收缩到最小可行集。

这条路线能够同时满足：

- 事件通知到微信；
- 微信 `/status` 聚合同机多实例状态；
- 微信回复 `question` / permission；
- token 失效后的本地回退提示；
- 不自己实现微信私有通信接口。
