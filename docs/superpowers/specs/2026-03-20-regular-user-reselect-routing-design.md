# regular 与 user-reselect 路由语义收敛设计

## 背景

当前 `src/plugin-hooks.ts` 的 `fetchWithModelAccount()` 会在真实 Copilot 请求发出前完成以下几件事：

- 根据模型与分组选出本次要使用的账号。
- 根据最终请求头和 session 信息给这次请求打上 `reason`。
- 记录 `route-decision` 日志。
- 在部分情况下弹出“已使用某账号”的 toast。

用户在真实使用中确认了一个关键偏差：

- `regular` 现在承载了过多语义。
- 它既可能表示 root-session 的普通 follow-up，也可能吞掉本不该出现的“无既有绑定但带 `agent` 标识”的异常首轮入口。
- 这会导致 tool follow-up 被误记为 `regular`，并触发不该出现的普通消费 toast。

用户进一步确认的目标语义是：

- 真实运行中，“没有既有绑定”的首次账号消耗入口，正常情况下应当只对应 `user-reselect`。
- 如果未来出现意外情况：请求带着 `agent` 语义进入，但当前 session 实际上还没有既有绑定，不能再让它静默落入 `regular`。
- 这种异常入口需要单独打标，并在处理前移除 `agent` 标识，再按 `user-reselect` 路径落地。
- 这个新状态需要单独的 toast 类型，不能继续伪装成普通 `regular` toast。

## 目标

1. 让 `regular` 只表示“已有既有绑定的 root-session 常规 follow-up 请求”。
2. 把“无既有绑定但未被 `user-reselect` / `subagent` / `compaction` 捕获”的异常入口单独打标。
3. 对该异常入口，移除 `agent` 标识后按 `user-reselect` 路径完成账号选择与发送。
4. 为该异常入口提供单独的用户可见 toast 类型与文案。
5. 保持 `route-decision` 观测能力，让日志能区分真实 `user-reselect` 与异常兜底改写。

## 非目标

1. 不修改 OpenCode upstream/core 的 `x-initiator` 生成逻辑。
2. 不引入新的菜单开关。
3. 不改变已有 `rate-limit-switch` 语义。
4. 不在本轮重写整套多账号选择算法。
5. 不把“是否计费”做成新的外部持久化状态。

## 已确认语义

### 1. `allowReselect` 的来源

当前实现中，`allowReselect` 只取决于最终请求头是否为 `x-initiator: user`：

- 最终头是 `user` -> `allowReselect = true`
- 其他情况 -> `allowReselect = false`

因此严格意义上的“重选”只会发生在 `user-reselect` 路径，不会发生在 `regular` 路径。

### 2. `regular` 现在的问题

当前 `regular` 只是一个剩余类：

- 不是 `user-reselect`
- 不是 `subagent`
- 不是 `compaction`

这意味着只要 root-session 请求带着 `agent` 语义进入，同时当前 session 又不是 true child session，它就会落成 `regular`，哪怕该 session 根本没有既有绑定。

### 3. 用户确认的应有语义

用户已经明确：

- 在真实运行路径中，“没有既有绑定”的首次账号消耗入口，应当只可能是 `user-reselect`。
- 如果未来出现例外，不应让它继续伪装成 `regular`。
- 这种例外要单独打标，再送回 `user-reselect` 语义处理。

## 推荐方案

采用“新增异常兜底 reason + 运行前降级为 `user-reselect` 发送语义”的方案。

核心思路：

1. 保留现有 5 类 reason：
   - `regular`
   - `subagent`
   - `compaction`
   - `user-reselect`
   - `rate-limit-switch`
2. 新增一个只用于观测和提示的 reason，例如 `unbound-fallback`。
3. 当请求满足以下条件时，判定为 `unbound-fallback`：
   - 最终请求头为 `x-initiator: agent`
   - 当前 session 不是 true child session
   - 当前 message 不是 compaction
   - 当前 session 没有既有账号绑定
4. 一旦落入 `unbound-fallback`：
   - 先移除 outbound request 上的 `x-initiator: agent`
   - 再按 `user-reselect` 的发送语义进行账号选择与请求发送
   - 但日志 reason 仍然保留为 `unbound-fallback`
5. toast 不再把它当成 `regular` 或普通 `user-reselect`，而是使用单独 variant / 文案。

这样可以同时满足：

- 发送语义按用户预期回到首次真实消耗入口。
- 观测语义保留“这本来是一次异常兜底修正”的证据。
- `regular` 不再吞掉无绑定异常入口。

## 架构设计

### 1. `reason` 语义收敛

`RouteDecisionEvent["reason"]` 扩展为：

- `regular`
- `subagent`
- `compaction`
- `user-reselect`
- `unbound-fallback`
- `rate-limit-switch`

语义定义调整为：

- `user-reselect`: 最终请求头明确为 `user` 的真实用户回合重选入口。
- `subagent`: 最终请求头为 `agent`，且 `session.parentID` 存在的 true child session。
- `compaction`: 最终请求头为 `agent`，且当前 message parts 中存在 compaction part。
- `regular`: 已有既有绑定的 root-session 常规 follow-up。
- `unbound-fallback`: 本不应出现的 root-session 无绑定 `agent` 入口，被插件兜底改写回首次用户入口。
- `rate-limit-switch`: 已经命中限流替换逻辑后的后续结果。

### 2. 新增“既有绑定”参与分类

当前分类只看最终头、session parent 和 compaction。新设计要求把“当前 session 是否已有既有绑定”纳入分类。

推荐在 `fetchWithModelAccount()` 里用当前已有的：

- `sessionID`
- `sessionAccountBindings.get(sessionID)`

推导一个布尔值：

- `hasExistingBinding = sessionID.length > 0 && sessionAccountBindings.has(sessionID)`

然后分类规则按下面顺序收敛。这里说的顺序只负责产出基础 `reason`，不包含后置的限流替换覆写：

1. `initiator === "user"` -> `user-reselect`
2. `initiator === "agent"` 且 message 为 compaction -> `compaction`
3. `initiator === "agent"` 且 session 为 true child -> `subagent`
4. `initiator === "agent"` 且 root-session 且 `hasExistingBinding === false` -> `unbound-fallback`
5. 其他 root-session follow-up -> `regular`

`rate-limit-switch` 不参与上面这一步基础分类。它的优先级保持和当前实现一致：

- 先完成一次基础分类，得出 `regular` / `user-reselect` / `subagent` / `compaction` / `unbound-fallback`
- 如果真实请求返回后命中现有 rate-limit 替换逻辑，并且成功切到替代账号，则最终记录的 `reason` 仍然覆写为 `rate-limit-switch`
- 如果没有触发成功替换，则保留原始基础分类 reason

### 3. 发送语义与日志语义分离

这是本次设计的关键。

对 `unbound-fallback`：

- 日志 reason 保持 `unbound-fallback`
- 但发送前要把 outbound request 的 `x-initiator: agent` 去掉
- 账号选择行为必须与 `user-reselect` 使用同一条选择路径和同一套 `allowReselect` 语义，而不是仅仅删 header 后沿用 `regular` follow-up 分支
- 换句话说，实现必须保证：这类请求在“是否允许首次入口式选号/绑定”的处理上，与真实 `user-reselect` 等价，而不是继续按已有绑定 follow-up 处理

这样既不会让日志丢失异常入口痕迹，也不会继续把真实发送语义错放到 `agent` / `regular` 上。

### 4. toast 策略调整

toast 规则收紧为：

- `compaction`：不弹
- `subagent`：仅首次使用账号时弹
- `user-reselect`：弹普通用户回合消费 toast
- `unbound-fallback`：弹单独类型 toast
- `regular`：不弹普通消费 toast
- `rate-limit-switch`：继续弹 warning 切换 toast

`unbound-fallback` 的 toast 需要与普通 `user-reselect` 显式区分，而且这件事必须是可测试的。最低要求：

- variant 固定为 `warning`
- message 必须包含 `异常无绑定 agent 入口`
- message 必须包含 `已按用户回合处理`

推荐完整文案例如：

- variant: `warning`
- message: `已使用 <account>（异常无绑定 agent 入口，已按用户回合处理）`

实现阶段可以在不破坏以上 3 条最低约束的前提下微调完整文案。

### 5. route-decision 日志保持可追溯

`appendRouteDecisionEventImpl(...)` 保持每次真实路由都记录，但现在 `reason` 必须能区分：

- 正常 `user-reselect`
- 正常 `regular`
- 异常 `unbound-fallback`

这样后续如果用户再看到异常 toast，可以直接从 `decisions.log` 反推：

- 当时是否没有既有绑定
- 为什么没有被归到 `user-reselect`
- 插件是否执行了兜底降级

## 备选方案

### 方案 B：不新增 reason，直接把异常入口改判成 `user-reselect`

优点：

- 改动更小。

缺点：

- `decisions.log` 里会丢失“这次其实是异常兜底修正”的证据。
- 后续排查时无法区分真实 `user-reselect` 和插件救火改写。

因此不推荐。

### 方案 C：只改 toast，不改分类

优点：

- 能立刻止住误弹。

缺点：

- `regular` 仍然吞掉异常入口。
- 日志 reason 继续脏。
- 发送语义仍然没有回到用户确认的目标语义。

因此不推荐。

## 测试策略

本轮必须用 TDD 覆盖以下行为：

1. root-session、最终 `agent`、无既有绑定、非 compaction、非 child session -> reason 记为 `unbound-fallback`。
2. 上述场景真实发请求前会移除 outbound request 上的 `x-initiator: agent`。
3. 上述场景在日志中必须记录 `unbound-fallback`，同时发送行为必须等价于 `user-reselect` 首次入口处理。
4. 上述场景会弹单独类型 toast，且 toast 至少满足固定 `warning` variant 和关键文案字段约束，而不是 `regular` / `user-reselect` 默认文案。
5. 已有既有绑定的 root-session `agent` follow-up -> 继续记为 `regular`，且不弹普通消费 toast。
6. true child session 仍然保持 `subagent` 语义，不被新规则吞掉。
7. compaction 仍然保持 `compaction` 语义，不被新规则吞掉。
8. `user-reselect` 原有负载重选行为保持不变。
9. 命中并成功完成限流替换时，最终 `reason` 仍覆写为 `rate-limit-switch`，不受新基础分类影响。

## 风险与边界

1. `sessionAccountBindings` 是进程内状态，如果某些上游路径绕过既有绑定写入，仍可能触发 `unbound-fallback`。这是本次刻意保留的防御性兜底。
2. 如果未来 upstream 再改变 `x-initiator` 生成语义，新分类顺序需要重新核对。
3. `unbound-fallback` 是一类“理论上不该常见”的异常入口，因此 toast 文案应当明显但不过度打扰；warning 比 success/info 更合适。

## 结论

本次设计采用方案 A：

- 给“无既有绑定却带 `agent` 进入 root-session”的异常入口增加单独 `unbound-fallback` reason。
- 该 reason 只用于观测与提示；真实发送前移除 `agent` 标识，并按 `user-reselect` 发送语义处理。
- `regular` 收缩为“已有绑定的 root-session follow-up”。
- toast 同步收紧，`regular` 不再承担首次消费提示；`unbound-fallback` 使用单独 toast 类型。
