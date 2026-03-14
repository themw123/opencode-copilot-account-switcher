# Copilot Input ID Session Repair 设计

## 目标

在 `opencode-copilot-account-switcher` 插件中，把当前 `input[*].id too long` 的处理方式从“只修当前请求 payload”升级为“在明确命中 400 报错后，精确定位并回写真正的上游会话状态，再重试当前请求”。

这次设计必须同时满足以下约束：

- 只修改插件仓库，不修改 OpenCode core。
- 不在正常路径预清洗所有 `id`。
- 不再像 `v0.2.6` 那样一次性移除所有超长 `input[*].id`。
- 只处理服务端已经明确指出的那个坏 `id`，尽量缩小误改范围。
- 在修复过程中记录足够精确的日志，帮助后续定位为什么某类 part 会产生超长 `id`。

## 非目标

- 不做“发送前猜测式修复”。
- 不做跨会话、跨进程、跨重启的坏 `id` 记忆。
- 不修改 `previous_response_id`。
- 不清理所有长 `id`，除非后续新增需求明确允许。
- 不把 OpenCode 内部消息结构的长期缓存复制到插件侧。

## 背景与问题定义

当前 `v0.2.6` 的行为是：

1. 请求命中 Copilot `400`。
2. 从当前 payload 中移除所有超长 `input[*].id`。
3. 立刻重试并通常恢复成功。

这个策略虽然把“请求失败”变成了“请求可自愈”，但仍有两个关键问题：

- 它只修改当前这一次发出的 payload，没有修复 OpenCode session 中真正的源数据。
- 它一次性清理所有超长 `id`，没有聚焦服务端实际报错的那一个，误改面过大。

因此，同一会话后续请求仍可能继续从历史消息重新构造出相同的超长 `id`，导致重复出现 `400 -> 清理 -> 200`。从设计上看，这属于“救火式 payload 修补”，不是“修复真实状态源”。

## 方案比较

### 方案 A：保持 `v0.2.6` 的全量局部降级

做法：继续在 400 后删除当前 payload 中所有超长 `id`，不回写 session。

优点：

- 逻辑简单。
- 当前成功率高。

缺点：

- 同会话仍会继续带毒。
- 一次性修改全部超长 `id`，误改范围偏大。
- 无法帮助分析究竟是哪类 part 持续生成超长 `id`。

### 方案 B：发送前在 `experimental.chat.messages.transform` 里预修复

做法：在请求发送前扫描所有历史消息，只要看到长 `itemId` 就先清掉并回写。

优点：

- 可以在真正发请求前清掉有问题的源数据。

缺点：

- 属于猜测式修复，不符合“只在 400 明确命中后再改”的约束。
- 可能误改本来还未被服务端判错的新 `id`。

### 方案 C：`400 -> 精确定位坏 part -> 回写 session -> 定向重试`（推荐）

做法：

1. 仍然先等服务端返回 `400`。
2. 从报错文本解析服务端报告的失败索引，例如 `input[3].id`，并把它视为“诊断信号”，而不是直接等同于 JS 数组下标。
3. 从当前 request body 中提取长 `id` 候选、长度、结构形态，结合服务端报告的长度与索引缩小范围。
4. 用 `sessionID` 在 OpenCode session 中搜索真正持有候选 `failingId` 的 part。
5. 只回写唯一命中的那个 part，清掉其 `metadata.openai.itemId`。
6. 当前请求只定向移除该一个目标 `id` 后再重试。

优点：

- 满足“报错后再修”的要求。
- 误改范围最小。
- 修的是上游 session 源数据，不是只修一次性 payload。
- 可以把“哪类 part 产生了超长 `id`”记录成精确日志。

缺点：

- 需要在插件侧增加一次 session 回写逻辑。
- 需要为“payload 报错项 -> session part”建立可靠定位链路。

本设计确认采用方案 C。

## 设计结论

推荐实现为一个“400 触发的精确修复循环”，核心原则如下：

1. 只在 Copilot `400` 且错误文本明确匹配 `input[*].id too long` 时触发。
2. 只修当前错误直接指向的那个 `input` 项，不再沿用“清全部超长 id”。
3. 先尝试回写 session 中真正的来源 part，再修改当前 payload 并重试。
4. 每一步都写详细 debug 日志，确保后续能分析根因。
5. 整个循环必须有严格上限和重复命中终止条件，避免单次请求进入失控重试。

## 运行时结构设计

### 1. 请求上下文透传

`createCopilotRetryingFetch()` 当前运行在 provider fetch 层，本身拿不到 OpenCode `sessionID`。为了解决这个问题，插件需要通过 Hook 层把 session 信息透传给重试包装器。

推荐做法：

- 在 `chat.headers` 中注入一个插件内部 header，例如 `x-opencode-session-id`。
- 这个 header 只用于插件内部识别当前请求所属的 OpenCode session。
- 在真正调用官方 Copilot fetch 前，重试包装器必须把该 header 从请求里移除，避免把内部 session 标识泄露给外部 provider。
- 插件初始化阶段把 `PluginInput.client`、`directory`、`serverUrl` 注入 retry 模块，供 400 后的 session 查询与 part 回写使用。

这条链路在仓库中已有直接依据：

- `PluginInput` 明确包含 `client`、`directory`、`serverUrl`，见 `opencode/packages/plugin/src/index.ts:26`
- OpenCode 加载插件时确实把这几个字段传入，见 `opencode/packages/opencode/src/plugin/index.ts:33`

这样做的原因：

- `chat.headers` 天然能拿到 `sessionID`。
- fetch 层可以在 400 时拿到这个 `sessionID` 并执行会话内回写。
- `PluginInput` 已经提供 `client`、`directory`、`serverUrl`，插件无需依赖外部全局状态。
- 不需要修改 OpenCode core，也不需要全局共享内存状态。

### 2. 400 错误解析

保留当前 `application/json` + `text/plain` 双路径检测，并新增两个解析步骤：

- 从响应文本中解析失败索引：`input[(\\d+)].id`
- 从响应文本中解析服务端报告的实际长度：`got a string with length (\\d+)`

如果检测到了 `too long`，但解析不到索引，则视为“可识别错误、不可精确定位”，此时只记录日志，不做 session 回写。

额外约束：

- 不能假设服务端索引就是 JS 0-based 数组下标。
- 在日志与测试中必须显式校验 `payload` 视角下的索引、服务端报错索引、以及最终定位到的来源 part 是否一致。

### 3. 当前 payload 中的候选项收敛

在拿到服务端报错后，插件不能直接读取 `payload.input[reportedIndex]`，而应先收集候选项：

- 遍历 `payload.input` 中所有带字符串 `id` 的项。
- 为每个候选项记录：`payloadIndex`、`itemKind`、`idLength`、`idPreview`。
- 第一轮优先保留 `idLength > 64` 的候选项。
- 如果服务端提供了 `reportedLength`，则用它继续过滤。

在此基础上，候选 `failingId` 的收敛顺序为：

1. 若只剩一个长 `id` 候选，直接选中。
2. 若存在多个候选，但只有一个候选在 session 中存在精确值匹配的来源 part，选中该候选。
3. 若仍有多个候选，则把服务端报错索引仅作为“排序信号”参与打分，例如比较 `payloadIndex` 与 `reportedIndex` 的 `0-based` / `1-based` 解释是否唯一收敛。
4. 若依然无法唯一收敛，则记录日志并退出 session 精确回写流程。

这样做的目标是：不依赖未证实的索引假设，但尽可能利用报错信息缩小范围。

### 4. session 中真实来源 part 的定位

拿到 `sessionID` 和候选 `failingId` 后，插件需要查询 OpenCode session 中的历史消息与 part，找出真正持有这个 `itemId` 的来源对象。

定位规则优先按“值匹配”，而不是先重建完整的索引映射：

1. 读取当前 session 的消息列表。
2. 遍历 assistant message 下的 part。
3. 在以下 part 中查找 `metadata.openai.itemId === failingId`：
   - `text`
   - `reasoning`
   - `tool`

值匹配优先于索引镜像的原因：

- 服务端已经告诉我们某个 `input[*].id` 出错。
- 当前 payload 里也保留了这些 `id` 的原始字符串。
- 只要找到 session 中哪个 part 保存了这个值，就能直接修复真正的数据源。
- 这样可以减少插件侧重新实现 OpenCode 全量 input 构造规则所带来的偏差风险。

### 5. 歧义处理

如果 session 搜索结果：

- **0 个匹配**：不回写 session，只记录日志，并退回到“仅当前 payload 定向修复后重试”。
- **1 个匹配**：正常回写该 part。
- **多个匹配**：再根据当前 payload 项的结构形态做二次过滤。

二次过滤规则：

- `role: assistant` 且 `content[0].type === output_text` -> 倾向匹配 `text` part
- `type === function_call` 或 `type === local_shell_call` -> 倾向匹配 `tool` part
- `type === reasoning` -> 倾向匹配 `reasoning` part

如果二次过滤后仍然不唯一，则不回写 session，只记录“定位歧义”日志，并只做当前 payload 的定向修复。

这样做的目标是：宁可少改，也不误改。

### 6. session 回写策略

一旦唯一定位到来源 part，插件应回写该 part，且只删除：

- `metadata.openai.itemId`

不修改：

- 其他 metadata 字段
- part 的文本内容、tool 状态、reasoning 内容
- message 级信息
- `previous_response_id`

回写方式建议使用两段式最小变更：

1. 先读取最新消息与目标 part。
2. 构造一个仅删除了 `metadata.openai.itemId` 的最新副本，再调用 OpenCode server 的 `part.update` 路由。

这里必须强调：

- 不允许用旧快照的完整 part 直接覆盖服务端状态。
- 必须基于“刚读取到的最新 part”生成变更副本，尽量降低并发覆盖文本、tool 状态或其他 metadata 的风险。

API 选型：

- session 读取优先用 `PluginInput.client.session.messages` / `session.message`。
- part 写入使用 OpenCode server 的 `PATCH /session/{sessionID}/message/{messageID}/part/{partID}`。
- 写入请求带上 `x-opencode-directory`，由插件通过 `serverUrl` 直接调用本地 OpenCode server。

这条能力链在仓库中已有直接依据：

- OpenCode plugin 初始化时 `client` 是本地 `createOpencodeClient(...)` 实例，见 `opencode/packages/opencode/src/plugin/index.ts:25`
- v1 SDK 已暴露 `session.messages` / `session.message`，见 `opencode/packages/sdk/js/src/gen/sdk.gen.ts:605` 与 `opencode/packages/sdk/js/src/gen/sdk.gen.ts:629`
- server route 已暴露 `PATCH /session/{sessionID}/message/{messageID}/part/{partID}`，见 `opencode/packages/opencode/src/server/routes/session.ts:657`

这样做的原因：

- 插件侧可以明确获得 session 读取能力。
- 当前公开 SDK 能力对 part 更新暴露不稳定，直接走本地 server route 更可控。
- 仍然只在插件仓库内完成，不依赖 core 代码改动。

### 7. 当前请求的定向重试

session 回写完成后，当前请求不能直接复用原始 body，而应只定向清理当前失败项：

- 只移除目标 payload 候选项上的 `id`

不移除：

- 其他位置的长 `id`
- 其他 metadata 字段
- `previous_response_id`

如果后续重试再次遇到新的 `input[*].id too long`，说明当前请求中存在多个坏项。为保持兼容性，需要允许一个有上限的循环：

- 每轮只修 1 个服务端明确指向的坏项
- 每轮都重复“解析 -> 收敛候选 -> 定位 session part -> 回写 -> 定向重试”
- 设置严格上限，例如 `MAX_INPUT_ID_REPAIR_ATTEMPTS = 4`

额外终止条件：

- 如果连续两轮命中同一个 `failingId` 且 session 回写前后没有发生有效变化，则立即停止自动修复，避免空转。
- 如果连续两轮命中相同的服务端索引，但始终无法唯一定位来源 part，也立即停止自动修复。

这样既避免了 `v0.2.6` 的“一锅端”，又避免“同一请求中只修一个 id 导致后续立刻失败”的回退。

## 日志与可观测性设计

本次必须把日志从“只知道触发了 retry”提升到“知道到底是哪一个 part 触发了问题”。

建议新增的 debug 日志事件：

### `input-id retry parsed`

记录：

- `serverReportedIndex`
- `reportedLength`
- `contentType`
- `bodyPreview`

### `input-id retry payload candidates`

记录当前 payload 中所有带字符串 `id` 的候选项。每个候选项至少包括：

- `payloadIndex`
- `itemKind`
- `idLength`
- `idPreview`

其中 `itemKind` 例如：

- `assistant-output_text`
- `assistant-function_call`
- `assistant-local_shell_call`
- `assistant-reasoning`
- `item_reference`
- `unknown`

### `input-id retry payload target`

记录：

- `serverReportedIndex`
- `targetedPayloadIndex`
- `itemKind`
- `idLength`
- `idPreview`
- `strategy`（`single-long-id` / `exact-session-id` / `length+index-hint` / `ambiguous`）

### `input-id retry session candidates`

记录当前 session 中所有 `metadata.openai.itemId.length > 64` 的候选 part。每个候选项至少包括：

- `messageID`
- `partID`
- `partType`
- `itemIdLength`
- `itemIdPreview`

### `input-id retry session match`

记录：

- `matchedCount`
- `matchedMessageID`
- `matchedPartID`
- `matchedPartType`
- `strategy`（`exact-id` / `exact-id+kind` / `ambiguous` / `not-found`）
- `serverReportedIndex`
- `payloadCandidateIndexes`

### `input-id retry session repair`

记录：

- `success`
- `changed`
- `sessionID`
- `messageID`
- `partID`
- `partType`
- `removedField`（固定为 `metadata.openai.itemId`）

### `input-id retry response`

保留现有响应日志，并额外记录：

- `attempt`
- `repairedBySessionWrite`
- `targetedPayloadIndex`
- `targetedIdPreview`

这些日志只在 `OPENCODE_COPILOT_RETRY_DEBUG=1` 时启用。

## 错误处理

### 无法拿到 `sessionID`

如果内部 header 丢失或未注入：

- 不做 session 回写
- 仍允许当前 payload 做单项定向修复并重试
- 写日志说明 `sessionID` 缺失

### session 查询失败或回写失败

如果读取消息或 patch part 失败：

- 不阻断当前请求的定向重试
- 记录失败日志
- 继续只修改当前 payload 的目标 `id`

这里的失败必须显式覆盖：

- 本地 route 返回 `404`
- 本地 route 返回 `405`
- route 不存在或 server 能力版本不兼容

这些场景都必须安全降级为“仅当前 payload 定向修复”，不能把整个设计建立在路由必然存在的假设上。

### 定位歧义

如果命中多个候选 part 且无法唯一确定：

- 不做 session 回写
- 只做当前 payload 单项定向修复；如果连 payload 目标也无法唯一收敛，则停止自动修复并返回原始 400
- 记录 `ambiguous` 日志

### 不支持的来源类型

若未来报错项来源不是当前已覆盖的 `text` / `reasoning` / `tool` 的 `metadata.openai.itemId`，例如出现 `item_reference` 但无法安全定位来源：

- 不盲目扩展修复范围
- 先记录精确日志
- 仅在能唯一确定 payload 目标项时做当前请求定向修复

## 测试计划

至少新增以下测试：

1. **只移除报错目标项的 id**
   - 请求里有多个长 id 时，单轮只应修改当前收敛出的那一个。

2. **服务端索引不直接等于 payload 下标**
   - 用例要覆盖当前已观察到的现象：报错为 `input[3].id`，但真实坏项不能依赖 `payload.input[3]` 的 0-based 直取。
   - 断言插件不会因为错误的下标假设而打偏。

3. **400 后触发 session 回写**
   - 模拟带 `sessionID` header 的请求。
   - 模拟 session 中存在唯一匹配 part。
   - 断言会发起一次 part patch，并且只删 `metadata.openai.itemId`。

4. **session 回写成功后当前请求重试成功**
   - 断言第二次请求只修改命中的目标项。

5. **定位不到来源 part 时不回写 session**
   - 只记录日志并继续 payload 单项修复。

6. **定位歧义时不回写 session**
   - 多匹配无法唯一确定时，保证不误改 session。

7. **循环修复多个坏项但有上限**
   - 模拟同一请求依次返回不同索引的 too-long 报错。
   - 断言每轮只修一个，并在达到上限后停止。

8. **同一 failingId 重复命中时及时停机**
   - 模拟 session 回写无效或映射错误，断言不会无限重试同一个坏项。

9. **内部 session header 不泄露给外部 provider**
   - 断言调用官方 Copilot fetch 时已经移除了插件内部 header。

10. **所有失败路径都不泄露内部 session header**
    - 包括首次请求、重试请求、session 回写失败后的请求。

11. **日志包含精确 part 定位信息**
    - 在 debug 模式下断言日志文件包含 `serverReportedIndex`、`partID`、`partType`、`idLength` 等关键字段。

12. **input 候选项异常时安全退出**
    - 覆盖索引越界、目标项无 `id`、`id` 非字符串等情况。

13. **session part route 不可用时安全降级**
    - 覆盖 `404`、`405`、网络失败或 route 缺失。
    - 断言插件仍可退回到“仅当前 payload 定向修复”。

14. **内部 header 在 Request 与 init 两种入口都被剥离**
    - 覆盖 `request.headers` 自带 header 与 `init.headers` 注入 header 两种路径。
    - 断言首次请求与重试请求都不会把内部 header 传给外部 provider。

## 风险与缓解

### 风险 1：session 中不存在唯一匹配

缓解：

- 值匹配优先
- 类型二次过滤
- 无法唯一时不回写 session，并允许安全降级或停止自动修复

### 风险 2：同一请求中多个坏项导致单次修复不够

缓解：

- 改成有上限的逐项修复循环
- 每轮只处理当前服务端明确指出的那一项

### 风险 3：内部 session 标识泄露到外部 provider

缓解：

- 仅用内部 header 传递上下文
- 在调用官方 fetch 前显式移除该 header
- 增加成功路径与失败路径回归测试锁定这一点

### 风险 4：日志不够精确，后续仍无法分析根因

缓解：

- 把“报错索引”“当前 payload 候选”“session 候选”“最终命中的 part”拆成独立日志事件
- debug 模式下完整落盘

## 预期结果

完成后，插件对 `input[*].id too long` 的处理应从“粗粒度救火”升级为“报错驱动、按项修复、回写真实状态源、带精确日志的闭环修复”。

用户可见结果应当是：

- 同一会话里，一旦某个历史 part 的 `itemId` 被服务端明确判定超长，插件会把该 part 的源数据修正掉。
- 后续同会话请求不应再因为同一个坏 `id` 反复进入 `400 -> retry`。
- debug 日志足以回答“到底是哪种 part、哪个 part ID、哪种 itemId 触发了超长报错”。
