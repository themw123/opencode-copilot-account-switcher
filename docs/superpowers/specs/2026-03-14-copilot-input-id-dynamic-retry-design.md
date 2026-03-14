# Copilot Input ID Dynamic Retry 设计

## 目标

在现有 `input[*].id too long` 会话回写修复机制之上，补上对长会话、多坏项场景的可持续推进能力，并提高日志可观测性，让我们能明确看到：

- 当前请求里还有多少超长 `id` 候选项。
- 每轮清理之后，服务端返回的报错是否真的从上一个坏项推进到了下一个坏项。
- 如果没有推进，究竟是“候选数没减少”，还是“服务端报错没变化”。

## 背景

当前实现已经能做到：

- 只在明确命中 `400 input[*].id too long` 后触发修复。
- 每轮只清理一个失败项。
- 尝试回写 session 源 part，然后对当前 payload 做定向重试。

但真实长会话日志显示，这个策略仍有两个缺口：

1. **固定重试上限过低**
   - 长会话里可能已经积累了很多个超长 `id`。
   - 固定 `3` 或 `4` 次重试上限不足以覆盖真实候选数量。
   - 结果是请求在清掉前几个坏项后，仍然会被后续坏项挡住。

2. **缺少“是否真的推进到下一个坏项”的日志**
   - 当前日志能看出每轮命中了哪个 `input[n].id`。
   - 但不能直接看出“清理前一个之后，新的报错是否发生了变化”。
   - 这会让排查变得困难：我们不知道是修复真的在推进，还是只是重复命中同一个问题。

## 非目标

- 不改成发送前预清洗所有长 `id`。
- 不恢复“一锅端删除所有超长 id”的旧逻辑。
- 不做无限重试。
- 不把 session patch 失败当作整个请求失败的硬阻断。

## 设计结论

采用 **动态上限 + 严格双条件停机**。

核心原则：

1. 仍然坚持“每轮只修 1 个明确失败项”。
2. 重试上限不再是固定小常量，而是按当前请求里剩余的超长 `id` 候选数动态决定。
3. 即使动态上限很大，也必须再套一个较高但有限的硬上限，防止异常场景失控。
4. 每轮重试后都要显式判断：
   - 剩余候选数是否减少。
   - 服务端报错是否变化。
5. 只有这两个条件都满足，才允许继续下一轮。

## 方案比较

### 方案 A：固定高上限

做法：把固定上限从 `3` 提高到 `32` 或 `64`。

优点：

- 改动最小。
- 能覆盖更多长会话场景。

缺点：

- 仍然不知道该请求到底需要多少轮。
- 候选很少时会浪费轮次预算。
- 不能表达“当前会话其实有很多坏项”的真实状态。

### 方案 B：动态上限 + 宽松停机

做法：按剩余候选数动态决定轮次，只要候选数减少就继续。

优点：

- 比固定上限更适应长会话。

缺点：

- 即使服务端一直报同一个位置，也可能继续推进。
- 容易掩盖“修复没有真正把请求推进到下一个坏项”的异常。

### 方案 C：动态上限 + 严格双条件停机（采用）

做法：

- 允许轮次 = `min(remainingLongIdCandidates, HARD_LIMIT)`。
- 每轮只修一个坏项。
- 下一轮必须同时满足：
  - `remainingLongIdCandidates` 变少。
  - `serverReportedIndex` 或完整报错消息发生变化。

优点：

- 最适合长会话、多坏项场景。
- 能直接回答“清理这一个之后，服务端是否真的推进到了下一个坏项”。
- 能避免无效空转。

缺点：

- 需要引入更细的轮次状态记录。
- 对日志与测试要求更高。

## 运行时设计

### 1. 动态重试上限

在首次命中 `input[*].id too long` 后，先从当前 payload 计算全部超长 `id` 候选数。

定义：

- `remainingLongIdCandidates`: 当前 payload 中 `id.length > 64` 的候选数。
- `HARD_LIMIT`: 较高但有限的常量上限，建议从 `64` 开始。
- `allowedAttempts = min(remainingLongIdCandidates, HARD_LIMIT)`。

注意：

- 这是“可继续修复的最大轮次”，不是单纯的常量循环次数。
- 每轮重试后都要重新计算剩余候选数，而不是只用第一次的快照。

### 2. 严格双条件停机

每轮重试后，如果新的响应仍然是 `400 input[*].id too long`，就比较上一轮与当前轮状态。

继续下一轮必须同时满足：

1. `remainingLongIdCandidatesAfter < remainingLongIdCandidatesBefore`
2. 以下至少一个成立：
   - `serverReportedIndex` 变化
   - 完整错误消息变化

如果任一条件不满足，则立即停机，并把原因写入日志。

推荐停机原因枚举：

- `remaining-candidates-not-reduced`
- `server-error-unchanged`
- `reached-hard-limit`
- `missing-next-error-details`

### 3. 轮次进展日志

新增一条 debug 日志事件：`input-id retry progress`

至少记录：

- `attempt`
- `previousServerReportedIndex`
- `currentServerReportedIndex`
- `serverIndexChanged`
- `previousErrorMessagePreview`
- `currentErrorMessagePreview`
- `previousFailingIdPreview`
- `currentFailingIdPreview`
- `remainingLongIdCandidatesBefore`
- `remainingLongIdCandidatesAfter`
- `continueReason` 或 `stopReason`

其中：

- `previousErrorMessagePreview` / `currentErrorMessagePreview` 只保留短截断文本，避免日志过长。
- `previousFailingIdPreview` / `currentFailingIdPreview` 继续只保留短前缀。

### 4. session patch 失败日志保留

现有 `input-id retry session repair failed` 日志继续保留。

这样日志能同时回答两件事：

- session 回写是否成功。
- 即使 session 回写失败，payload retry 是否仍然推进到了新的坏项。

### 5. 与现有行为的兼容关系

以下行为保持不变：

- 只在明确命中 `400 input[*].id too long` 时触发。
- 每轮只清理一个明确失败项。
- 优先尝试回写 session，再对当前 payload 做定向重试。
- 内部 `x-opencode-session-id` header 仍必须在外发前剥离。

## 测试计划

至少新增以下测试：

1. **大量候选项时按动态上限推进**
   - 当前请求中存在很多超长 `id`。
   - 验证不会被固定 `3/4` 次限制提前卡住。

2. **候选减少且报错变化时继续**
   - 模拟服务端报错从 `input[3]` -> `input[5]` -> `input[7]`。
   - 验证日志能看出这一推进链条。

3. **候选未减少时停机**
   - 即使仍返回 too-long，也不能继续空转。

4. **报错未变化时停机**
   - 如果服务端连续返回同一个位置/同一错误消息，必须停止并记录原因。

5. **session patch 失败仍可看到推进日志**
   - 验证 patch 失败日志和进展日志都存在。

## 风险与缓解

### 风险 1：候选数很多导致轮次增大

缓解：

- 使用 `HARD_LIMIT` 限制最大轮次。
- 每轮都要求“候选减少 + 报错变化”，否则立即停止。

### 风险 2：服务端报错文本格式轻微变化

缓解：

- 同时比较 `serverReportedIndex` 与错误消息预览。
- 若缺少足够细节，记录 `missing-next-error-details` 并停机。

### 风险 3：日志过长

缓解：

- 所有 message/id 仍使用 preview 截断。
- 仅在 `OPENCODE_COPILOT_RETRY_DEBUG=1` 时输出。

## 预期结果

完成后，插件在长会话里遇到大量超长 `id` 时应具备更稳定的逐轮推进能力，并且调试日志能够明确回答：

- 这轮清理前后还剩多少候选。
- 服务端报错是否真的推进到了新的坏项。
- 如果没有推进，为什么停下来。
