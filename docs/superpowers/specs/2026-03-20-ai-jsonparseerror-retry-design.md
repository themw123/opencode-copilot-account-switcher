# AI_JSONParseError 可重试归一化设计

## 背景

当前 `src/copilot-network-retry.ts` 已经会把一部分 Copilot 瞬时失败归一化成可重试的 `AI_APICallError`：

- 传输层错误（例如 `failed to fetch`、`unable to connect`、`etimedout`）
- 特定 HTTP 状态（例如 499）
- 部分 SSE/输入 ID 修复场景

用户又遇到了一类新报错：

- `AI_JSONParseError: JSON parsing failed: Text:`

从报错外观和用户反馈看，它更像是上游网络波动导致响应文本被截断，随后在 AI SDK 解析响应 JSON 时抛出的错误，而不是本地稳定业务逻辑里的 JSON.parse 失败。

## 根因判断

本轮不把根因定义为“本地 JSON parse 逻辑有 bug”，而是把它收敛为一类可能的上游瞬时响应损坏：

1. Copilot 网络请求已经发出。
2. `baseFetch(...)` 的 Promise 链上游开始解析响应。
3. 响应文本因网络波动、截断或网关脏响应而不再是完整 JSON。
4. AI SDK 在解析阶段抛出 `AI_JSONParseError`。
5. 该错误目前会落到 `createCopilotRetryingFetch(...)` 最外层 `catch`，但因为不命中现有白名单，最终不会被标记成可重试。

## 目标

1. 仅对 Copilot 请求，把“看起来像响应截断导致的 `AI_JSONParseError`”归一化成现有可重试 `AI_APICallError`。
2. 捕获点只放在 `createCopilotRetryingFetch(...)` 最外层 `catch`，不扩散到其他解析层。
3. 保持现有错误包装机制与 `transport` 分组，不新增新的对外错误类型。
4. 不把本地业务 JSON.parse 失败误收进可重试范围。

## 非目标

1. 不重写 upstream/AI SDK 的 JSON 解析实现。
2. 不把所有 `JSON parse error` 一概视作可重试。
3. 不新增 `parse` 专用错误分组或新的 toast 体系。
4. 不修改 SSE/499/输入 ID 修复的现有策略。

## 用户已确认约束

1. 实现位置应放在 `src/copilot-network-retry.ts` 的最外层 `catch`。
2. 这次只做窄匹配，不做泛化 JSON 错误兜底。
3. 目标是“像网络波动导致响应截断”的那类错误，而不是本地 JSON.parse 问题。

## 推荐方案

采用“Copilot URL + 窄特征匹配 + 复用现有 transport 可重试包装”的方案。

### 1. 捕获位置

继续使用现有的：

- `createCopilotRetryingFetch(...)`
- `await baseFetch(safeRequest, effectiveInit)`
- 最外层 `catch (error)`

理由：

- 如果 `AI_JSONParseError` 来自上游 AI SDK 在网络响应 Promise 链上的解析阶段，这里已经天然能接住。
- 不需要改更深层调用结构。

### 2. 新增窄判定函数

推荐新增一个专门函数，例如：

- `isRetryableCopilotJsonParseError(error: unknown): boolean`

判定必须同时满足以下约束：

1. 错误外观符合上游 AI JSON 解析失败：
   - `error.name === "AI_JSONParseError"`
   - 或 message 中包含 `json parsing failed`
2. message 中还要包含 `text:`，说明错误里带有响应文本片段，而不是普通本地 JSON.parse 失败
3. message 最好还包含截断/异常响应的文本迹象；如果当前可见样本只有 `JSON parsing failed: Text:`，则先以这个最小特征为准

这里的重点是：

- 不是任何 parse error 都算
- 必须看起来像“AI SDK 在解析远端响应时失败”

### 3. 只对 Copilot URL 生效

新判定只在 `isCopilotUrl(safeRequest)` 为 true 时参与。

这确保：

- 非 Copilot 请求即使抛出相同错误，也不会被插件改写为可重试
- 当前收口范围只针对本插件负责的 Copilot 网络链路

### 4. 复用现有错误包装

命中后不新增新类型，继续沿用：

- `toRetryableApiCallError(error, safeRequest, { group: "transport", requestBodyValues: currentPayload })`

原因：

- 这类错误本质上仍然更像“响应链路上的瞬时传输/网关损坏”，不是稳定业务错误
- 复用现有 `transport` 组可以最小化改动和兼容性风险

### 5. 与现有白名单关系

推荐做法不是把 `JSON parsing failed` 粗暴加入 `RETRYABLE_MESSAGES`，而是让 `catch` 条件变成：

- 现有 `isRetryableCopilotFetchError(error)`
- 或新的 `isRetryableCopilotJsonParseError(error)`

这样可以避免：

- 让 message 白名单承担过多语义
- 把别的普通 JSON parse error 意外纳入 transport retry

## 备选方案

### 方案 B：把 `json parsing failed` 直接加入 `RETRYABLE_MESSAGES`

优点：

- 改动最少。

缺点：

- 匹配太粗。
- 可能把非 AI SDK 响应解析、甚至其他上下文里的 parse error 误判成可重试。

因此不推荐。

### 方案 C：新增单独 `parse` 错误组

优点：

- 语义更细。

缺点：

- 本轮没有必要扩展外部错误分类面。
- 会增大测试和兼容范围。

因此不推荐。

## 测试策略

本轮必须用 TDD 覆盖至少这三类场景：

1. Copilot URL + `AI_JSONParseError: JSON parsing failed: Text:` -> 会被转成 `AI_APICallError`，且 `isRetryable === true`。
2. 非 Copilot URL + 相同错误 -> 不转。
3. 普通本地 JSON parse error（例如普通 `SyntaxError` 或不带 AI 特征的 parse message）-> 不转。

如果测试框架允许，推荐再补一个“error.name 不是 `AI_JSONParseError`，但 message 满足 AI 响应解析特征”场景，确认 message fallback 逻辑也能工作。

## 风险与边界

1. 如果未来上游把 `AI_JSONParseError` 的消息格式改掉，窄匹配可能需要同步调整。
2. 如果该错误其实发生在 `baseFetch(...)` 之外的后续消费阶段，那么本方案接不住；但根据当前结构和报错外观，这不是最可能路径。
3. 若后续收集到更多样本，再决定是否扩展匹配特征；本轮先保持窄范围。

## 结论

本次设计采用最小窄匹配方案：

- 在 `src/copilot-network-retry.ts` 最外层 `catch` 中识别 Copilot 响应链上的 `AI_JSONParseError`
- 只匹配带有 AI 响应解析特征的错误外观
- 只对 Copilot URL 生效
- 复用现有 `transport` 组把它包装成可重试 `AI_APICallError`
- 不动本地 JSON.parse 与其他非 Copilot parse error
