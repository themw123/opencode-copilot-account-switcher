# 阶段 C：WeChat `/status` 纵向切片设计

## 背景

阶段 B 已经把 WeChat broker 单例基座落成真实 detached 运行时：launcher / client / server、实例注册、最小鉴权、`ping` / `heartbeat`、共享状态目录都已经成立。下一步的第一个用户可见能力，不是事件通知，也不是 `question` / permission 回复闭环，而是先把 `/status` 这条最核心的纵向切片打通。

本设计继续受以下上位文档约束：

- 总体设计：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\specs\2026-03-23-wechat-broker-bridge-design.md`
- 分阶段计划：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\plans\2026-03-23-wechat-broker-bridge-phased-implementation.md`
- 阶段 B 设计：`docs/superpowers/specs/2026-03-24-wechat-stage-b-broker-foundation-design.md`

但和原始分阶段计划不同，阶段 C 的 `/status` 实现方向已经在设计讨论中被重新收口：

- 摘要计算不能以 broker 为中心；
- 也不能默认依赖长期事件订阅缓存；
- 必须优先从插件侧可取得的 **真实当前状态** 出发，再做分类与格式化。

## 目标

阶段 C 只解决一个问题：

> 用户在微信发送 `/status` 时，broker 能向多个 OpenCode 实例收集真实当前状态，并返回可读的多实例状态汇总。

本阶段必须真正落成的能力：

1. WeChat `/status` 可以触发 broker 广播状态收集。
2. 每个实例内的 bridge 必须基于插件 runtime 提供的 `input.client` 做 live snapshot，而不是依赖 broker 持久化摘要。
3. `/status` 汇总必须能覆盖：
   - 当前 session 列表与元信息；
   - `busy | idle | retry` 状态；
   - pending `question`；
   - pending `permission`；
   - todo；
   - 最近 message / part 推导出的 running / completed tool。
4. broker 只负责 fan-out / fan-in、超时处理和格式化，不负责维护摘要状态机。
5. `/status` 最多返回每个实例 3 个最近活跃 session。

## 非目标

阶段 C 明确不做这些事情：

1. 不做微信事件通知。
2. 不做 token stale fallback toast。
3. 不做 `question` / `permission` 回复路由。
4. 不把 broker 改造成摘要缓存中心。
5. 不为了“最近 command”单独引入事件投影缓存。
6. 不提前做阶段 D / E 才需要的恢复、重放和业务闭环。

## 已确认的事实基础

阶段 C 的设计不是凭空假设，而是基于当前上游 SDK 契约和本机真实落盘样本共同收口：

### 1. 插件 runtime 自带完整 SDK client

`@opencode-ai/plugin` 的 `PluginInput` 明确提供：

- `client: ReturnType<typeof createOpencodeClient>`

这意味着阶段 C 的 bridge 可以直接调用 OpenCode 官方 SDK 的 live 读取接口，而不需要自己构造额外 client。

### 2. SDK 已经提供 `/status` 所需的大部分 live 读面

当前锁定版本下，至少存在这些读取能力：

- `client.session.list()`
- `client.session.get()`
- `client.session.status()`
- `client.session.todo(sessionID)`
- `client.session.messages(sessionID)`
- `client.question.list()`
- `client.permission.list()`

因此阶段 C 的核心 `/status` 不需要依赖事件先推送过来再缓存。

### 3. 真实落盘样本确认了哪些 action 会出现在 message / part 中

在本机 `opencode.db` 的真实样本里已经确认：

- `question` 的确会以 `part.type = "tool"`、`tool = "question"` 的形式落盘；
- `todowrite` 也会以 `tool` part 落盘；
- `todo` 同时还有独立的 `todo` 表；
- `step-start` / `step-finish` / `tool` / `text` 等 part 形态都是真实存在的；
- `session.permission` 字段存的是 session 级 permission ruleset，不是 pending permission 请求。

### 4. pending permission 不能以数据库快照为权威

设计讨论期间已经实际检查过本机当前数据库：

- `permission` 表在检查时为空；
- 最近 `part` 里也没有 `tool = "permission"` 的样本；
- 但这并不能推出“当前没有 live permission 请求”，只能说明持久化快照不足以作为阶段 C 的权威来源。

因此，阶段 C 对 pending permission 的单一可信来源必须是：

- `client.permission.list()`

同理，pending question 也优先信：

- `client.question.list()`

## 方案对比

### 方案 1：事件订阅驱动的本地 digest（放弃）

做法：

- `plugin-hooks` 订阅 `question.asked`、`permission.asked`、`todo.updated`、`session.status` 等事件；
- bridge 长期维护一个本地 reducer；
- `/status` 时只返回缓存摘要。

问题：

- 与“优先看真实当前状态”这一设计结论相冲突；
- 需要证明缓存与真实状态一致；
- 一旦 bridge 漏事件、broker 重启或实例中途恢复，摘要就可能漂移。

### 方案 2：broker 中心化摘要（放弃）

做法：

- bridge 只推原始事件给 broker；
- broker 维护所有实例的 digest；
- `/status` 直接读 broker 内存或 broker 持久化摘要。

问题：

- 把摘要中心从插件侧挪到了 broker，违背“broker 不做状态计算中心”的设计边界；
- 会把阶段 C 的复杂度抬高到接近后续通知 / 回复闭环阶段。

### 方案 3：插件侧 live snapshot 分类（选定）

做法：

- broker 收到 `/status` 后广播 `collectStatus`；
- 每个 bridge 当场调用 `input.client` 的 live 读取接口；
- 在插件侧基于真实 session / question / permission / todo / message / part 计算展示摘要；
- broker 只负责聚合、超时标记和格式化。

优势：

- 贴近真实当前状态；
- 不引入长期缓存一致性问题；
- 和阶段 B 的 broker 基座职责天然一致；
- 可以明确把“不可 live-read 的少数信息”排除出阶段 C，而不是靠事件缓存偷渡。

## 选定方案

采用方案 3：插件侧 live snapshot 分类。

阶段 C 的核心原则是：

> `/status` 只展示当前能够从真实 session 快照中恢复出来的状态；无法从当前读面可靠恢复的项目，不在本阶段硬做事件缓存补洞。

这意味着：

- `command.executed` / `tui.command.execute` 不作为阶段 C 的展示项；
- slash command 本身也不展示，因为这是用户手动触发动作，用户天然知道自己刚刚发了什么；
- 阶段 C 不再把状态压扁成“只能有一个 winner 的 `latestAction`”；
- `question`、`permission`、`todo`、message / part 中的 tool 级细节可以并行展示；
- 真正需要的是一个 **按显示顺序排列的摘要切片集合**，而不是单一优先级冠军。


## 总体结构

阶段 C 固定为 4 层：

1. **bridge live snapshot 层**
   - 调用 `input.client` 收集真实当前状态。
2. **session digest 分类层**
   - 不是事件 reducer，而是对 live snapshot 做纯函数分类。
3. **broker 聚合层**
   - 广播 `collectStatus`，等待窗口，合并结果，标记超时实例。
4. **微信文案层**
   - 把聚合后的多实例状态格式化成 `/status` 回复。

其中真正的状态计算中心明确在插件侧的 bridge / digest 分类层，而不是 broker。

## Live Snapshot 数据源

### bridge 的输入

bridge 不再以“事件增量”作为主输入，而是以这组 live 读面为主：

1. `input.project`
   - 当前实例 project 元信息。
2. `input.directory`
   - 当前实例目录。
3. `process.pid`
   - 当前实例进程号。
4. `client.session.list()`
   - 找本实例当前 session 列表，并按 `time.updated` 选最近活跃 session。
5. `client.session.status()`
   - 读取当前 session 的 `busy | idle | retry`。
6. `client.question.list()`
   - 读取当前 pending question。
7. `client.permission.list()`
   - 读取当前 pending permission。
8. `client.session.todo(sessionID)`
   - 读取该 session 当前 todo。
9. `client.session.messages(sessionID, { limit })`
   - 读取最近 message / part，恢复 running / completed tool 与真实 question tool part。

### bridge 的输出

bridge 对 broker 返回一个按实例维度聚合好的 live snapshot，至少包含：

```ts
type WechatInstanceStatusSnapshot = {
  instanceID: string
  instanceName: string
  pid: number
  projectName?: string
  directory: string
  collectedAt: number
  sessions: SessionDigest[]
  unavailable?: Array<"sessionStatus" | "questionList" | "permissionList" | "messages" | "todo">
}

type SessionDigest = {
  sessionID: string
  title: string
  directory: string
  updatedAt: number
  status: "busy" | "idle" | "retry" | "unknown"
  pendingQuestionCount: number
  pendingPermissionCount: number
  todoSummary?: {
    total: number
    inProgress: number
    completed: number
  }
  unavailable?: Array<"messages" | "todo">
  highlights: Array<{
    kind: "question" | "permission" | "running-tool" | "completed-tool" | "todo" | "status"
    text: string
  }>
}
```

注意：

- `SessionDigest` 是展示层对象，不是持久化状态机；
- 它每次都由当前 live snapshot 重新计算；
- broker 不保存它的长期副本。

## `session-digest.ts` 的职责重定义

阶段 C 仍保留 `src/wechat/session-digest.ts` 这个文件名，但语义已经改变：

- **不是** 事件 reducer；
- **不是** broker 摘要缓存；
- **而是** 一个面向真实上游数据结构的纯函数分类器。

它的输入必须直接围绕真实数据形态编写：

- `Session`
- `SessionStatus`
- `QuestionRequest[]`
- `PermissionRequest[]`
- `Todo[]`
- `Array<{ info: Message; parts: Part[] }>`

并且分类规则要以已观察到的真实 part 形态为依据：

- `tool = "question"`
- `tool = "todowrite"`
- `step-start`
- `step-finish`
- 真实 `tool.state.status`

不能先发明一套自定义事件 schema，再把真实数据硬映射进去。

## 摘要切片计算规则

阶段 C 的 `SessionDigest` 不再只保留一个 `latestAction`，而是输出一组可并行展示的 `highlights`。

这些 `highlights` 的生成顺序固定为：

1. **pending permission**
   - 依据：`client.permission.list()`
   - SDK 返回的 `PermissionRequest` 自带 `sessionID`，bridge 必须先按 `sessionID` 分桶，再回填到对应 `SessionDigest.pendingPermissionCount` 与 `highlights`。
   - 只要某 session 有 pending permission，就必须单独展示。
2. **pending question**
   - 依据：`client.question.list()`
   - SDK 返回的 `QuestionRequest` 自带 `sessionID`，bridge 必须先按 `sessionID` 分桶，再回填到对应 `SessionDigest.pendingQuestionCount` 与 `highlights`。
   - 只要某 session 有 pending question，也必须单独展示。
3. **running tool**
   - 依据：最近 message / part 中 `tool.state.status in { pending, running }`
4. **completed tool**
   - 依据：最近 message / part 中最新的 completed tool
5. **todo**
   - 依据：`client.session.todo(sessionID)`
6. **status**
   - 依据：`client.session.status()`
   - `client.session.status()` 返回的是以 `sessionID` 为 key 的状态映射，bridge 必须按 `sessionID` 回填到每个 `SessionDigest.status`。
   - `status` 始终作为尾部切片进入 `highlights`，用于兜底展示当前 `idle` / `retry` / `busy`；它不会覆盖前面的 `permission` / `question` / `tool` / `todo`，只是在这些切片之后追加展示。

这里的顺序是 **展示顺序**，不是互斥优先级。

例如，一个 session 如果同时存在：

- pending permission
- pending question
- running tool
- todo in progress

那么阶段 C 可以同时展示这 4 类信息，而不是只挑其中一个 winner。

明确不做：

- 不单独展示 slash command；
- 不为了 `command.executed` 单独维护事件缓存；
- 不把用户刚刚手动发的 `/status` 再当成状态亮点回显。

## `collectStatus` 流程

### broker -> bridge

阶段 C 让阶段 B 中预埋但未实现的 `collectStatus` 真正生效。

broker 收到微信 `/status` 后：

1. 刷新当前操作者上下文（本阶段只要求 `/status` 自身链路可用，不扩展到通知）；
2. 向所有在线 bridge 广播 `collectStatus(requestID)`；
3. 等待固定聚合窗口 `1.5s`；
4. 收集 bridge 回包；
5. 未回包实例记为 `timeout/unreachable`；
6. 将结果交给 `status-format.ts` 生成微信回复。

### bridge 内部

bridge 收到 `collectStatus(requestID)` 后：

1. 并发调用 live 读面；
2. 过滤出本实例最近活跃的 session；
3. 最多保留 3 个最近活跃 session；
4. 用 `session-digest.ts` 计算 `highlights`、计数与展示摘要；其中 `question.list()`、`permission.list()`、`session.status()` 都必须先按 `sessionID` 分桶，再与具体 session 绑定；
5. 返回实例级 snapshot。

## 失败语义与降级策略

阶段 C 的失败语义必须做到“局部失败不拖垮整体”：

### 单项读取失败

如果以下任一读取失败：

- `question.list()`
- `permission.list()`
- `session.todo()`
- `session.messages()`

bridge 的处理方式是：

- 对实例级读取失败（如 `question.list()` / `permission.list()` / `session.status()`）记录到实例级 `WechatInstanceStatusSnapshot.unavailable`；
- 对 session 级读取失败（如某个 `session.todo()` / `session.messages()`）记录到对应 `SessionDigest.unavailable`；
- 尽可能返回其它可用字段；
- 不因为一项失败就让整实例状态直接丢失。

### session 级数据不足

如果某 session 的 `messages()` 或 `todo()` 无法取得：

- 仍可基于 `question.list()`、`permission.list()`、`status()` 返回一份 **强语义、可直接展示** 的 session 摘要；
- 缺失的只是 tool 细节或 todo 细节，不影响 pending `permission` / `question` 这些一等状态的可信度；
- `SessionDigest.unavailable` 必须反映缺失项；
- `status-format.ts` 需要把这种情况渲染为该 session 的局部降级，而不是整实例 `timeout/unreachable`。

### bridge 整体失败

如果 bridge 本身 IPC 断开、超时、或整体 `collectStatus` 无法完成：

- broker 才把该实例标为 `timeout/unreachable`。

### broker 不持久化摘要

broker 不保存 `SessionDigest` 的持久化副本，也不在重启后尝试恢复旧 digest。

这保证了：

- 阶段 C 的 `/status` 总是“当前读到什么，就展示什么”；
- 不会引入“上一次缓存比当前真实状态更新/更旧”的双写一致性问题。

## 文件职责

### `src/wechat/session-digest.ts`

- 输入真实 SDK 数据结构；
- 输出每个 session 的展示摘要；
- 不订阅事件，不读写磁盘，不持有内存状态。

### `src/wechat/bridge.ts`

- 封装 live snapshot 采集；
- 调用 `input.client` 的 session / question / permission / todo / message 读面；
- 组装 `WechatInstanceStatusSnapshot`。

### `src/wechat/status-format.ts`

- 把 broker 聚合结果转换成微信文案；
- 负责 top 3 session 的展示和 unavailable / timeout 文案；
- 不承担数据采集。

### `src/wechat/command-parser.ts`

- 本阶段只解析 `/status`；
- 不提前支持 `/reply` / `/allow`。

### `src/wechat/broker-server.ts`

- 实现 `collectStatus` 广播与回包聚合；
- 标记 `timeout/unreachable`；
- 不计算 digest 规则。

### `src/wechat/broker-client.ts`

- 支持 bridge 侧响应 `collectStatus`；
- 不引入 `question` / permission 回复业务。

### `src/plugin-hooks.ts`

- 阶段 C 首次接入 bridge 生命周期；
- 只做最小接线：创建 bridge、注册 broker、允许 `/status` 这条状态收集链路跑通；
- 不顺手接入通知或等待态交互闭环。

## 测试策略

### `test/wechat-session-digest.test.js`

这份测试在阶段 C 改成 **live snapshot 分类测试**，不再验证事件 reducer。

至少覆盖：

1. `permission` 与 `question` 都能独立进入 `highlights`，不是二选一。
2. running tool、completed tool、todo 可以与 pending `permission` / `question` 并行展示。
3. `highlights` 的顺序固定为 `permission -> question -> running tool -> completed tool -> todo -> status`。
4. 当更高价值切片存在时，`status` 仍可作为兜底或尾部信息存在，而不是强制覆盖其它切片。
5. 分类逻辑基于真实 `Part` 形态工作，而不是依赖自造事件。

### `test/wechat-status-flow.test.js`

至少覆盖：

1. broker 广播 `collectStatus()` 后能收到多个 bridge 的 live snapshot。
2. 超时实例被标记 `timeout/unreachable`。
3. bridge 某一项 live 读取失败时，返回部分字段降级而不是整体失败。
4. 每个实例最多只展示 3 个最近活跃 session。
5. `/status` 文案不展示 slash command / 最近 command。

### `plugin-hooks` 接线测试

新增或扩展测试，锁定：

1. 阶段 C 会首次修改 `src/plugin-hooks.ts`；
2. 但只接 bridge 与 `/status`；
3. 不越界到事件通知；
4. 不越界到 `question` / permission 回复。

## 阶段 C 完成判定

只有同时满足以下条件，阶段 C 才算完成：

1. 微信 `/status` 能触发 broker 聚合。
2. bridge 主要基于 `input.client` live 读取真实状态。
3. `session-digest.ts` 以真实 SDK / 样本数据结构为输入，而不是事件 reducer。
4. pending `question` 来自 `question.list()`。
5. pending `permission` 来自 `permission.list()`。
6. todo 来自 `session.todo()`。
7. running / completed tool 来自 `session.messages()` 的真实 `Part`，并允许与 `permission` / `question` / `todo` 并行展示。
8. broker 不持久化 digest，也不成为状态计算中心。
9. `/status` 最多展示每实例 3 个最近活跃 session。
10. 本阶段仍未实现通知、token stale fallback、`/reply`、`/allow`。
