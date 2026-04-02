# 阶段 B：WeChat Broker 单例基座设计

## 背景

阶段 A 已经完成真实 `@tencent-weixin/openclaw-weixin` 最小 compat host 验证，以及 `wechat:smoke:guided` 的真实手测闭环。下一步不再验证“微信包能不能跑起来”，而是开始把总体设计里的单例 broker 路线落成真正可复用的本地基座。

本设计以两份已确认文档为上位约束：

- 总体设计：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\specs\2026-03-23-wechat-broker-bridge-design.md`
- 分阶段计划：`C:\Users\34404\Documents\GitHub\opencode-copilot-analysis\copilot-account-switcher\docs\superpowers\plans\2026-03-23-wechat-broker-bridge-phased-implementation.md`

其中当前阶段明确对应总体计划里的 Task 2，但用户已经确认本阶段不采用“最轻空骨架”，而是采用更完整的方案 3 收口：

- broker 必须是真实 detached 进程；
- launcher/client/server 必须完成真实往返；
- 实例注册、最小鉴权、`ping` / `heartbeat` 活性验证和共享状态文件必须真正成立；
- 但仍然不能越界进入 `/status` 聚合、事件通知、`question` / permission 路由这些 Task 3 之后的业务能力。

> 现状补充（不改变阶段 B 边界）：当前仓库已在该基座之上继续完成后续通知发送链路与 handle 驱动 `/reply` / `/allow` 闭环；本文件中的“非目标”仅用于描述阶段 B 当时不应提前实现的范围。

## 目标

阶段 B 只解决一个问题：

> 把 WeChat 集成从“阶段 A 的单脚本手测运行时”推进到“可真实拉起、可注册、可鉴权、可保活的 broker 单例基座”。

本阶段必须真正落成的能力：

1. 多个 launcher 并发启动时，同一用户目录下只能有一个 detached broker 被真正拉起。
2. broker 启动后写出可复用的 `broker.json`，后续 launcher 能基于它完成 `ping` 检测与复用。
3. client 与 server 之间必须完成真实 `registerInstance -> registerAck(sessionToken)` 往返。
4. broker 必须把实例元信息与心跳写入 `instances/<instanceID>.json`。
5. 未带 `sessionToken` 的关键 IPC 调用必须被拒绝。
6. `operator-store`、`token-store`、`request-store`、`handle` 的文件语义要先稳定下来，为后续 Task 3/4/5 复用。

## 非目标

阶段 B 明确不做这些事情：

1. 不接 `src/plugin-hooks.ts`，因此不会跟随 OpenCode 会话自动创建真实 bridge 生命周期。
2. 不实现 `session digest` reducer。
3. 不实现 `/status` 聚合、格式化和广播收集。
4. 不实现微信事件通知与 token stale fallback 的业务触发。
5. 不实现 `question` / `permission` 的路由、短码交互和 OpenCode 官方 API 调用。
6. 不提前实现 broker 崩溃后的 full resync、请求恢复和自动清理编排；阶段 B 只保留最小恢复语义。

## 方案对比

### 方案 1：只做文件骨架和假 broker

做法：

- 创建 `state-paths`、stores、protocol 类型和一些空实现；
- broker 不真正 detached 启动，或只做内存 fake server；
- 把后续注册、活性校验和共享状态都留给 Task 3 之后再补。

问题：

- 无法证明“多实例不会拉起多个 broker”这个 Task 2 的核心验收点；
- 后续 Task 3 会在一个过于乐观的假基座上继续堆逻辑；
- 不符合用户最终选定的方案 3。

### 方案 2：阶段 B 就接入 `plugin-hooks.ts`

做法：

- 在完成 broker 基座的同时，提前把 bridge 生命周期接到 `src/plugin-hooks.ts`；
- 虽然 `/status` 业务不做，但真实 OpenCode 实例启动时已经会自动 connect broker。

问题：

- 会把阶段边界拉模糊；
- 真实 bridge 生命周期、OpenCode 事件订阅和 broker 基座会混在一个提交窗口；
- 一旦 broker 基座还需要返工，会连带影响现有插件主路径。

### 方案 3：真实 broker 基座，但先不接 hooks（选定）

做法：

- broker 采用真实 detached 进程；
- launcher/client/server 完成真实 connect-or-spawn、注册、鉴权、保活；
- 所有共享状态文件 schema 先固定；
- `protocol.ts` 先预埋 Task 3/5 会用到的消息类型，但阶段 B 一律显式 `notImplemented`；
- `src/plugin-hooks.ts` 保持不动，bridge 生命周期留到 Task 3 再接。

优势：

- 阶段 B 是“真基座”而不是空壳；
- 又不会把 `/status`、question/permission 或 OpenCode 事件摘要提前塞进当前阶段；
- 便于把 Task 2 的测试严格收敛为“单例、注册、鉴权、状态文件”四类验收。

## 选定方案

采用方案 3：真实 broker 基座，但先不接 hooks。

这一选择把阶段 B 明确收口为：

- 先证明 broker 生命周期、共享状态与最小安全边界成立；
- 之后的 `/status`、事件通知、`question` / permission 闭环都只是在这个基座上继续长业务层，而不是返工底层形态。

## 总体结构

阶段 B 固定为 5 个层次：

1. **路径层**
   - `src/store-paths.ts`
   - `src/wechat/state-paths.ts`
   - 负责 `wechat/` 根目录与所有状态文件的绝对路径。
2. **持久化层**
   - `src/wechat/operator-store.ts`
   - `src/wechat/token-store.ts`
   - `src/wechat/request-store.ts`
   - `src/wechat/handle.ts`
   - 负责单操作者、token stale、request 生命周期和 routeKey/handle 规则。
3. **协议与鉴权层**
   - `src/wechat/protocol.ts`
   - `src/wechat/ipc-auth.ts`
   - 负责本地 IPC envelope、消息类型、会话凭证与未鉴权拒绝规则。
4. **broker 运行时层**
   - `src/wechat/broker-entry.ts`
   - `src/wechat/broker-server.ts`
   - 负责 detached broker 进程、server 生命周期、注册、心跳、`ping` / `pong`。
5. **launcher/client 层**
   - `src/wechat/broker-launcher.ts`
   - `src/wechat/broker-client.ts`
   - 负责 connect-or-spawn、锁竞争、连接恢复、注册与 token 携带。

`src/plugin-hooks.ts` 在本阶段保持完全不动。它不是阶段 B 的改动面。

## 共享状态目录与文件布局

阶段 B 固定目录：

```text
~/.config/opencode/account-switcher/wechat/
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
      <routeKey>.json
    permission/
      <routeKey>.json
```

约束：

- `src/store-paths.ts` 只新增 `wechat` 根目录 helper；
- `src/wechat/state-paths.ts` 统一负责所有路径拼装与 ensure 目录能力；
- 路径 helper 不混入业务读写；
- 本阶段不新增额外状态根目录，也不把微信状态混进现有 Copilot/Codex store。

## 文件职责

### `src/store-paths.ts`

- 只新增 `wechat` 根目录 helper；
- 保持现有其他 store helper 不变。

### `src/wechat/state-paths.ts`

- 产出 `broker.json`、`launch.lock`、`operator.json`、`instances/<id>.json`、`tokens/<wechatAccountId>/<userId>.json`、`requests/.../<routeKey>.json`；
- 提供目录 ensure 能力；
- 不承担业务读写和状态机。

### `src/wechat/protocol.ts`

- 固定本地 IPC message envelope；
- 固定阶段 B 会真实用到的消息类型；
- 预留 Task 3/5 未来消息类型，但阶段 B 不实现它们的业务处理。

### `src/wechat/ipc-auth.ts`

- 生成和校验 `sessionToken`；
- 明确注册前只允许 `registerInstance` / `ping`；
- 注册后关键消息必须携带合法 token；
- broker 重启后所有旧 token 自动失效。

### `src/wechat/operator-store.ts`

- 固定单操作者语义；
- 首次绑定成功后，其它微信用户默认拒绝；
- 直到显式 reset 才允许重新绑定。

### `src/wechat/token-store.ts`

- 固定 token 持久化模型；
- 只信最近一次成功入站刷新；
- `stale` 只打标，不删除文件；
- 阶段 B 不触发真实发送，但先把语义锁定。

### `src/wechat/request-store.ts`

- 固定 `question` / permission 请求的文件模型；
- 固定 `open -> answered|rejected|expired -> cleaned` 生命周期；
- 固定 `7 天` dead-letter 保留语义；
- 阶段 B 不做真实路由，只做文件状态与清理规则。

### `src/wechat/handle.ts`

- 固定 `routeKey` 与 `handle` 的生成与校验；
- 提前锁定大小写不敏感、不能接受原始 `requestID` 的规则；
- 为 Task 5 的 slash 命令留出稳定存储键。

### `src/wechat/broker-server.ts`

- 只负责启动、接收注册、下发 token、记录实例、接收心跳、响应 `ping`；
- 未鉴权关键调用必须拒绝；
- 未来消息类型统一回显式 `notImplemented`。

### `src/wechat/broker-client.ts`

- 只负责连接、注册、保存 `sessionToken`、发送 `heartbeat` / `ping`；
- 不实现 bridge 业务与 OpenCode API 调用。

### `src/wechat/broker-launcher.ts`

- 负责 connect-or-spawn；
- 读 `broker.json`；
- 竞争 `launch.lock`；
- double-check 防止双拉起；
- 对失效 broker 做最小重拉。

### `src/wechat/broker-entry.ts`

- 作为 detached broker 进程入口；
- 只负责启动 server、写 `broker.json`、处理退出清理。

## IPC 传输与消息模型

### 传输形态

阶段 B 固定使用 `node:net` 本地 IPC：

- POSIX：本地 socket path
- Windows：named pipe

`broker.json.endpoint` 保存一个对 client 来说可直接连接的 opaque endpoint 字符串，而不是 host/port 结构。

不采用 loopback HTTP，也不采用 `fork()` 父子专用 IPC。

### 消息帧

阶段 B 的消息统一为 JSON 消息帧，并且分帧规则固定为：

- 每条消息独占一行；
- 使用 UTF-8 编码；
- 以单个换行符 `\n` 作为帧边界；
- payload 内若包含换行，必须先经过 JSON 字符串转义，而不是直接写裸文本；
- client 和 server 都按 NDJSON 逐行读写，不允许改成长度前缀或其他自定义边界。

这样 `test/wechat-broker-lifecycle.test.js` 可以明确以“单行一帧”的规则验证 client/server 互通，而不会在实现阶段出现多种帧协议并存。

固定 envelope：

```ts
type BrokerEnvelope = {
  id: string
  type: string
  instanceID?: string
  sessionToken?: string
  payload: Record<string, unknown>
}
```

### 阶段 B 必须真实支持的消息

- `registerInstance`
- `registerAck`
- `heartbeat`
- `ping`
- `pong`
- `error`

### 预留但阶段 B 不实现的消息

- `collectStatus`
- `replyQuestion`
- `rejectQuestion`
- `replyPermission`
- `showFallbackToast`

这些未来消息在阶段 B 中必须显式返回 `notImplemented`，不能沉默忽略。

### 关键 IPC 调用清单

阶段 B 中，“关键 IPC 调用”固定指：

- `heartbeat`
- `collectStatus`
- `replyQuestion`
- `rejectQuestion`
- `replyPermission`
- `showFallbackToast`

也就是除了 `registerInstance`、`registerAck`、`ping`、`pong`、`error` 之外，其余所有 bridge/broker 业务消息都按关键调用处理。

关键调用统一要求：

- 必须携带合法 `sessionToken`；
- 未注册或 token 非法时，优先返回 `unauthorized`；
- 只有在鉴权通过之后，才继续判断该消息在阶段 B 中是否尚未实现，并返回 `notImplemented`。

换句话说，错误优先级固定为：

1. 先判消息结构是否合法；不合法返回 `invalidMessage`
2. 再判是否需要鉴权以及 token 是否有效；不满足返回 `unauthorized`
3. 最后才判该消息在阶段 B 是否尚未实现；若未实现返回 `notImplemented`

这样像“未携带 `sessionToken` 的 `replyQuestion`”这类请求，其标准行为唯一固定为 `unauthorized`，而不是 `notImplemented`。

### 错误消息

`error` payload 至少要能表达：

- `unauthorized`
- `invalidMessage`
- `notImplemented`
- `brokerUnavailable`

目标是让后续 Task 3/5 在扩展协议时，不需要重新发明错误边界。

## 单例 broker 启动与复用语义

### `broker.json`

阶段 B 固定字段：

```ts
type BrokerStateFile = {
  pid: number
  endpoint: string
  startedAt: number
  version: string
}
```

其中 `version` 固定记录当前插件包版本字符串，用于调试和排障，不承担阶段 B 的兼容协商语义。launcher 读取它时只记录，不做版本比较阻断。

语义：

- launcher 先读取 `broker.json`；
- 若 endpoint 可连通且 `ping` 成功，则直接复用；
- 若 pid 已死或 endpoint `ping` 不通，则视为失效 broker，可进入重拉流程；
- broker 正常退出时应清理自身写出的 `broker.json`；
- 若 crash 遗留旧文件，则由后续 launcher 通过 `pid + ping` 双重检查接管。

### `launch.lock`

`launch.lock` 只负责“同一时刻只能有一个 launcher 在做 spawn 判定”。

最小实现契约固定为：

- 通过独占创建锁文件获取锁，而不是复用普通存在性检查；
- 锁文件内容至少包含 `pid` 和 `acquiredAt`；
- 正常持有者在完成 spawn 判定后必须显式释放锁；
- 后续竞争者若发现锁文件仍在，但记录的持有者 `pid` 已不存在，可删除旧锁并重新竞争；
- 阶段 B 不实现复杂租约，只要求“持有者消失后，下一轮重试最终可以接管”。

最小语义：

1. launcher 发现 broker 不可复用后才尝试竞争锁；
2. 抢到锁后必须再次 double-check `broker.json` 与 `ping`；
3. double-check 仍确认 broker 不存在时，才真正 spawn detached `broker-entry`；
4. 未抢到锁的 launcher 只等待并重试连接，不得重复拉起第二个 broker。

补充恢复约定：

- 若锁持有者在 spawn 过程中异常退出，后续 launcher 可以在下一轮重试时重新竞争 `launch.lock`；
- 阶段 B 不实现复杂锁租约，只要求“锁持有者消失后，重试方最终能重新获得锁并完成一次新的 double-check”。
- 重试策略只要求固定短退避即可；实现计划可以用集中常量表达，例如 `250ms` 级别轮询，不要求指数退避。

阶段 B 的锁只需要满足单机同用户并发判定，不追求复杂租约系统。

### detached 启动

broker 必须是可脱离 launcher 生命周期独立存活的本地进程：

- launcher 负责 spawn；
- broker 负责自己写 `broker.json`；
- launcher 不负责在内存里长期托管 broker 状态。

这条约束是阶段 B 和阶段 A 最大的结构差异：阶段 B 不是手测脚本里的内嵌宿主，而是长期可复用的用户级单例进程。

## 实例注册、鉴权与活性验证

### `registerInstance`

注册是阶段 B 的第一条真实业务链路。

client 必须提供最小实例元信息：

- `instanceID`
- `pid`
- `displayName`
- `projectDir`

broker 收到后做三件事：

1. 建立当前连接与 `instanceID` 的内存映射；
2. 生成新的 `sessionToken`；
3. 把实例快照写入 `instances/<instanceID>.json`。

重复注册语义固定为：

- **同连接 + 同 `instanceID`**：视为幂等重放，broker 返回当前连接已持有的同一个 `registerAck` 语义，不创建第二份映射；
- **新连接 + 同 `instanceID`**：视为实例重连，新连接接管该 `instanceID`，broker 生成新的 `sessionToken`，旧连接与旧 token 立即失效；
- **不同 `instanceID` + 同 `pid`**：允许共存，`pid` 只作为观测字段，不作为唯一键；
- broker 的连接主键始终是 `instanceID`，不是 `pid`。

### `registerAck`

阶段 B 的 `registerAck` 至少返回：

- `sessionToken`
- `registeredAt`
- `brokerPid`

可选返回保活建议值，例如 `heartbeatIntervalMs`，但 token 必须是核心字段。

### `sessionToken`

`sessionToken` 的语义固定为：

- 只在 broker 内存里保存；
- 不写入任何共享状态文件；
- broker 重启后全部作废；
- 只有完成新的 `registerInstance` 才能获得新 token。

### `ping` / `pong`

`ping` 用于两类场景：

1. launcher 在注册前确认既有 broker 是否可复用；
2. client 在连接层做最小活性探测。

`ping` 可以在注册前调用，不要求携带 `sessionToken`。

### `heartbeat`

`heartbeat` 是阶段 B 唯一要求的注册后活性消息。

约束：

- `heartbeat` 必须携带合法 `sessionToken`；
- broker 收到后刷新内存中的 last-seen，同时更新 `instances/<instanceID>.json`；
- 心跳超时默认阈值固定为 `30_000ms`，实现上可定义为集中常量，测试允许通过依赖注入或测试专用参数覆盖该值；
- `stale` 判定触发点固定为 broker 内部的周期扫描，而不是等下一条心跳到来时再惰性判断；
- 周期扫描的职责只是在超时后把实例文件状态转成 `stale`；
- 阶段 B 不做自动清理，也不做 full resync。

## `instances/` 快照文件

阶段 B 固定实例落盘字段：

```ts
type InstanceStateFile = {
  instanceID: string
  pid: number
  displayName: string
  projectDir: string
  connectedAt: number
  lastHeartbeatAt: number
  status: "connected" | "stale"
  staleSince?: number
}
```

规则：

- 注册成功立即写入；
- 每次心跳刷新 `lastHeartbeatAt`；
- `connected -> stale` 由 broker 周期扫描在超时后触发，并写入 `staleSince`；
- `stale -> connected` 允许发生；只要 broker 收到该实例后续合法 `heartbeat`，就恢复为 `connected` 并清空 `staleSince`；
- 心跳超时只改 `status`，不删除文件；
- 阶段 B 还不要求实例摘要、session 列表和请求索引进入这里。

## 单操作者、token 与 request 的阶段 B 语义

### `operator.json`

固定字段：

```ts
type OperatorStateFile = {
  wechatAccountId: string
  userId: string
  boundAt: number
}
```

规则：

- 首次绑定成功后，第二个微信用户默认拒绝；
- 阶段 B 通过 store 单测锁定这一点；
- 真实微信入站绑定仍留到后续阶段接入。

### `tokens/<wechatAccountId>/<userId>.json`

固定字段：

```ts
type TokenStateFile = {
  contextToken: string
  updatedAt: number
  source: string
  sourceRef?: string
  staleReason?: string
}
```

规则：

- 只信最近一次成功入站刷新；
- `stale` 是打标，不是删除；
- 不引入未经证实的固定 TTL；
- 阶段 B 只通过单测锁定文件语义，不触发真实发送路径。

### `requests/<kind>/<routeKey>.json`

固定字段：

```ts
type RequestStateFile = {
  kind: "question" | "permission"
  requestID: string
  routeKey: string
  handle: string
  instanceID: string
  sessionID?: string
  status: "open" | "answered" | "rejected" | "expired" | "cleaned"
  createdAt: number
  updatedAt: number
  expiresAt?: number
}
```

规则：

- 阶段 B 先把 schema、状态机和 TTL/保留语义锁定；
- `markCleaned()` 是进入 `cleaned` 保留态的唯一显式入口；
- `purgeCleanedBefore(timestamp)` 负责物理删除超过保留窗口的 `cleaned` 文件；
- `7 天` dead-letter 保留不是额外目录，而是 `cleaned` 记录的保留窗口；
- request 文件可以继续留在原路径，但活动索引必须忽略 `cleaned`；
- 实际 question/permission 路由仍留到 Task 5。

### `routeKey` 与 `handle`

阶段 B 先固定两个概念：

- `routeKey`：内部稳定存储键，也是请求文件名基础；
- `handle`：未来给微信 slash 命令使用的短码。

约束：

- `handle` 大小写不敏感；
- 不能把原始 `requestID` 直接当成 handle 接受；
- `question` 与 permission 的 handle 需要在当前活动请求集合内唯一；
- 这一规则由 `src/wechat/handle.ts` 和 `test/wechat-request-store.test.js` 先锁住。

## 未来消息的阶段 B 处理策略

虽然阶段 B 不实现 `/status`、`replyQuestion`、`replyPermission` 等业务，但 `protocol.ts` 必须先声明它们。

broker 对这些消息的处理固定为：

- 先按统一错误优先级链判定：`invalidMessage -> unauthorized -> notImplemented`；
- 只有消息结构合法，且在需要鉴权时已通过 `sessionToken` 校验，才允许落到 `notImplemented`；
- 例如未携带 `sessionToken` 的 `replyQuestion`，标准行为固定为返回 `unauthorized`，而不是 `notImplemented`；
- 通过鉴权但仍属于阶段 B 未实现能力的未来消息，才返回 `notImplemented`；
- 不沉默丢弃，不伪装成成功。

这样可以防止后续阶段在“协议里没有名字、临时再补”的状态下反复改协议边界。

## 最小安全边界

阶段 B 的信任模型只到“同机、同 OS 用户”。

最小要求：

1. IPC endpoint 只允许当前 OS 用户访问；
2. `wechat/` 状态目录只允许当前用户读写；
3. 注册后必须拿到 `sessionToken` 才能发关键消息；
4. 未带 token 或 token 非法的关键消息必须被拒绝；
5. broker 不因为本阶段还没有真实业务，就放弃显式鉴权。

最低验收标准固定为：

- POSIX：状态目录最低 `0700`，状态文件最低 `0600`；
- Windows：采用“仅当前用户可访问”的 ACL 或等价 best-effort 校验；
- 若某平台无法在测试环境做强校验，至少要做能力探测并记录降级原因，不能静默跳过。

阶段 B 不追求跨用户、跨机器或加密传输模型。

## 失败与最小恢复语义

阶段 B 只收口最小恢复集合：

### broker 文件失效

- `broker.json` 指向的 pid 已死：launcher 允许抢锁并重拉；
- `broker.json` 存在但 `ping` 不通：视作失效 broker，进入重拉流程。

### broker 重启

- 旧 `sessionToken` 全部失效；
- 所有 client 必须重新注册；
- 阶段 B 不要求 broker 主动通知旧 client 恢复状态。

### 实例失活

- 心跳超时后，`instances/<instanceID>.json` 标成 `stale`；
- 阶段 B 不做自动清理，不做 resync。

### 未来消息提前到达

- `collectStatus`、`replyQuestion`、`replyPermission` 等未来消息，仍然遵循统一错误优先级：`invalidMessage -> unauthorized -> notImplemented`；
- 只有结构合法且鉴权通过后，未来消息才返回 `notImplemented`；
- 禁止沉默失败。

## 测试与验收

阶段 B 的测试收口固定为这 5 个文件：

### `test/wechat-state-paths.test.js`

锁定：

- `wechat` 根目录位置；
- 固定文件与目录布局；
- 各 helper 产出的绝对路径和 ensure 行为。

### `test/wechat-operator-store.test.js`

锁定：

- 首次绑定成功；
- 第二个用户被拒绝；
- 显式 reset 后允许重新绑定。

### `test/wechat-token-store.test.js`

锁定：

- 最近入站覆盖规则；
- `stale` 只打标、不删除；
- 不引入固定 TTL 自动失效。

### `test/wechat-request-store.test.js`

锁定：

- `open -> answered|rejected|expired -> cleaned` 状态机；
- routeKey/handle 规则；
- `7 天` dead-letter 保留窗口。

### `test/wechat-broker-lifecycle.test.js`

锁定：

- 双 launcher 并发时只拉起一个 broker；
- broker 启动后写出可复用 `broker.json`；
- client 完成真实 `registerInstance -> registerAck(sessionToken)` 往返；
- 同 `instanceID` 的重复注册符合“同连接幂等、新连接接管”的固定语义；
- 未带 token 的关键消息被拒绝；
- 心跳会刷新 `instances/<instanceID>.json`；
- `stale` 实例在后续合法 `heartbeat` 后能恢复为 `connected`；
- 未带 token 的 future message 返回 `unauthorized`，鉴权通过后才返回显式 `notImplemented`。

阶段 B 通过的标准不是“微信已经能看状态”，而是：

> 单例 broker、最小 IPC 安全边界和共享状态文件已经稳定，后续 Task 3/4/5 可以直接建立在这套基座上。

## 结论

阶段 B 的正确收口不是“先做一层空抽象”，也不是“现在就把所有 bridge 业务接进插件”，而是：

- 先把 detached broker、connect-or-spawn、注册、鉴权、保活和共享状态文件做成真实基座；
- 同时严格守住边界，不提前实现 `/status`、事件通知和等待态交互。

这样进入 Task 3 时，工作重点就能集中在 session digest 与 `/status` 聚合本身，而不是继续回头修 broker 生命周期。
