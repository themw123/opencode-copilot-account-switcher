# Guided Loop Safety Derived Session Design

## 背景

当前插件已经为 Copilot provider 增加了 `Guided Loop Safety Policy` 注入能力，并且在上一轮修复中通过 `experimental.session.compacting` + `experimental.chat.system.transform` 的协作，为 compaction 路径补上了单次绕过，避免把策略错误注入到压缩内部流程。

这次继续静态分析后，可以确认另一个独立问题：derived/child session 仍可能收到同样的策略注入，而这些子会话往往由 subagent、task 工具或其他派生执行流自动创建，本身并不是面向最终用户的主会话交互。

已有证据如下：

- `opencode/packages/opencode/src/tool/task.ts` 在创建子任务会话时会显式写入 `parentID: ctx.sessionID`
- `opencode/packages/opencode/src/session/index.ts` 将 `parentID` 作为 session 的一等结构字段持久化
- upstream 官方 Copilot 插件已经在 `opencode/packages/opencode/src/plugin/copilot.ts` 中利用 `session.data.parentID` 将子会话请求标记为 `x-initiator=agent`
- `experimental.chat.system.transform` 的 hook 输入只有 `{ sessionID, model }`，没有 agent 身份信息，因此无法在 transform 阶段稳定识别“这是哪个内部 agent”
- `title` 相关内部调用并不只发生在 child session。`opencode/packages/opencode/src/session/prompt.ts` 的 `ensureTitle()` 会跳过 child session，但 `opencode/packages/opencode/src/session/summary.ts` 中仍存在 root session 的标题生成路径

这说明：

1. “只靠 root session / 非 root session”并不能解决所有内部 agent 注入问题；至少 `title` 仍可能发生在 root session。
2. 但“不要干扰 child/subagent/derived session”是一个可以单独成立、且有清晰结构信号的目标。
3. 这个目标可以完全在插件侧完成，不需要改 upstream，也不需要退回到脆弱的 prompt 文本匹配。

## 目标

本次设计要实现：

1. 在 Guided Loop Safety 注入决策中识别 derived/child session，并跳过策略注入。
2. 本次实现只使用 `session.parentID` 作为结构化判定信号。
3. 保留现有 compaction bypass，确保两条 skip 逻辑可以并存。
4. 当 session 查询不可用或失败时，保持当前行为并 fail open，而不是阻断请求。
5. 在文档表述上允许说明“未来可扩展到其他结构化派生信号”，但本次实现范围仅限 `parentID`。

## 非目标

- 不宣称解决 root session 内部 `title`、`summary` 或其他 internal agent 流程的策略注入。
- 不引入基于 prompt 文本、标题模式或 message 内容的匹配规则。
- 不修改 upstream hook 形态，也不要求上游新增 agent 身份字段。
- 不改变现有 compaction bypass 的语义。
- 不把“derived session”收窄成只等于 `task` 或特定 subagent 名称。

## 方案概述

### 1. 在 loop safety 决策点追加 derived session 跳过判断

当前策略注入的真实决策点在 `src/loop-safety-plugin.ts` 的 `createLoopSafetySystemTransform()` 中。这里已经具备三项关键条件：

- 能读取 store，判断 `loopSafetyEnabled`
- 能读取 model provider，判断是否为 Copilot
- 能消费现有 compaction bypass

因此 derived session 跳过也应继续放在这里，而不是散落到别的 hook 或调用方。设计上新增一个可注入的轻量判定协作层，例如：

- 为 `createLoopSafetySystemTransform()` 增加 `isDerivedSession?: (sessionID?: string) => Promise<boolean>` 之类的回调；或
- 提供语义等价的 helper，但要求最终决策仍集中在同一个 transform 内完成

这样可以保持 loop safety 是否注入的全部条件都收敛在一个地方，避免后续再出现“某条 skip 规则只在 wiring 层存在、真正决策点看不见”的分裂状态。

### 2. 判定信号严格来自 `session.parentID`

本次实现边界明确如下：

- 若能成功读取当前 session，且 `session.parentID` 为非空字符串，则视为 derived/child session
- 否则视为“不满足本次 skip 条件”

这里的“derived/child session”是一个结构性描述，不绑定具体来源。当前最主要的已知来源是 subagent/task 会话，但设计文档不应把规则写死为“只服务 subagent”，因为未来同样可能有别的派生会话复用同一结构字段。

同时必须明确：本次虽然允许在文档里预留“未来可扩展到其他结构化派生信号”的一句描述，但实现层面不得加入 `title`、消息内容、agent 名称、最近消息形态等额外启发式判断。

### 3. 数据流与执行顺序

推荐的执行顺序如下：

1. `experimental.chat.system.transform` 被触发
2. 读取 store；若 `loopSafetyEnabled !== true`，直接保持当前行为
3. 判断 provider；若不是 Copilot provider，直接保持当前行为
4. 尝试消费现有 compaction bypass；若命中，则跳过策略注入
5. 若 compaction bypass 未命中，再执行一次轻量 session lookup
6. 若 lookup 成功且 `parentID` 存在，则跳过策略注入
7. 其他情况下注入 `LOOP_SAFETY_POLICY`

这个顺序的设计意图是：

- 先用最便宜的条件筛掉无关路径
- 保持 compaction bypass 的优先级高于 derived-session lookup
- 只有在“loop safety 已启用 + Copilot provider + 本次不是 compaction 绕过”时才做额外 session 查询，降低不必要的查库/SDK 调用次数

### 4. plugin wiring 负责提供 session lookup，但不承载决策语义

`src/plugin-hooks.ts` 已经具备访问 `input.client` 与 `input.directory` 的能力，且当前 debug 分支已经通过 `input.client?.session?.get?.(...)` / `input.client?.session?.message?.(...)` 做过会话与消息回查。因此本次不需要新增 upstream 能力，只需要在 wiring 层补一条轻量 session lookup 通道。

推荐职责划分：

- `src/plugin-hooks.ts`
  - 负责把 `client`、`directory` 等运行时依赖封装成 `isDerivedSession(sessionID)` 回调
  - 负责处理 SDK 调用细节，例如 `client.session.get()` 的路径与 query 拼装
- `src/loop-safety-plugin.ts`
  - 负责在注入决策中调用该回调
  - 负责合并 `enabled`、provider、compaction bypass、derived session 等条件

换言之，plugin wiring 只提供“怎么查”，不决定“查到什么之后如何注入”；真正的注入策略仍由 loop safety 模块统一控制。

### 5. 失败降级必须 fail open

derived session skip 是一个“减少误注入”的增强，而不是请求正确性的前置条件。因此所有不确定路径都必须 fail open：

- `client` 不存在
- `sessionID` 缺失
- `client.session.get()` 不可用
- SDK 调用抛错
- 返回结构中没有可用 `data.parentID`

以上任一情况都只能得出“未知，不跳过 derived-session skip”，随后沿用当前注入逻辑，而不能抛错、中断请求或默认视为 child session。

这样可以保证：即使 lookup 接线失效，也只会退回旧行为，而不会引入新的功能性故障。

## 为什么不直接解决所有 internal agent 注入

本次分析已经确认，root session 内也会出现至少一部分 internal agent 流程，例如标题生成：

- `opencode/packages/opencode/src/session/prompt.ts` 的 `ensureTitle()` 会显式跳过 child session，说明该路径本身就是 root-session-oriented
- `opencode/packages/opencode/src/session/summary.ts` 的 `summarizeMessage()` 里还有一条标题生成路径，也会调用 `LLM.stream()`

而 `experimental.chat.system.transform` 当前只拿到 `sessionID` 与 `model`，并不能直接知道“这次调用来自 title agent、summary agent，还是普通对话”。在不修改 upstream 的前提下，这类 root-session internal flow 缺少与 child session 同等级别的稳定结构信号。

因此本次设计明确收敛为：

- 解决有稳定结构信号的 derived/child session 干扰问题
- 不把结论扩大为“内部 agent 注入问题已整体解决”

## 备选方案对比

### 方案 A（推荐）：基于 `parentID` 的 derived session skip

优点：

- 完全基于现有结构化字段，不依赖文本匹配
- 与 upstream 既有 `x-initiator` 子会话判定语义一致
- 能覆盖 subagent 以及其他采用 `parentID` 的派生会话
- 不需要改 upstream

缺点：

- 只能解决 child/derived session，不能覆盖 root-session 内部调用
- 需要在 loop safety 路径上增加一次条件性 session lookup

### 方案 B：只对明确 subagent / task 场景做窄规则

优点：

- 语义更直观，和当前最关心的 subagent 问题直接对应

缺点：

- 规则会被绑定到具体来源，后续若出现别的 child session 还要继续加特判
- 仍然绕不开“如何识别具体 subagent 来源”的额外耦合
- 比 `parentID` 方案更脆弱，也更不通用

### 方案 C：只保留 compaction bypass，不新增 derived session skip

优点：

- 变更最小
- 不新增 lookup 路径

缺点：

- 无法解决用户已经明确提出的“不要干扰 child/subagent session”目标
- 仍会让子会话承受与主会话相同的 loop safety 注入

## 风险与约束

### 风险 1：额外 session lookup 带来少量开销

在 loop safety 启用时，Copilot 请求路径上会新增一次条件性 session 查询。

缓解方式：

- 只在 `loopSafetyEnabled === true` 时才进入这条路径
- 只对 Copilot provider 做 lookup
- compaction bypass 命中后不再执行 lookup

### 风险 2：lookup 失败导致误以为没有 child session

若运行时 client 接线异常或 session 查询失败，会退回旧行为，从而继续注入策略。

缓解方式：

- 明确采用 fail open
- 在测试中覆盖 lookup 失败场景，确保行为可预期
- 如有需要，可在 debug 模式下补充轻量日志，但本次设计不把日志增强作为必需项

### 风险 3：derived session 语义未来扩展时需要再次调整

当前 `parentID` 足以覆盖已知 child session，但未来 upstream 若新增其他结构化派生标记，本设计不会自动识别。

缓解方式：

- 文档中明确写出“未来可扩展到其他结构化派生信号”
- 本次实现保持接口轻量，便于后续在同一判定协作层扩展，而不是重新改决策结构

## 测试策略

本次变更必须走 TDD。至少需要以下测试：

1. transform 级别测试：root session、Copilot provider、loop safety 开启时，仍会注入 `LOOP_SAFETY_POLICY`
2. transform 级别测试：child/derived session（lookup 返回 `parentID`）时，不注入策略
3. transform 级别测试：lookup 失败、client 不可用或返回异常结构时，保持当前注入行为
4. transform 级别测试：非 Copilot provider 或 `loopSafetyEnabled !== true` 时，不执行 derived session lookup
5. compaction 协同测试：已有 compaction bypass 继续生效，且命中后不会再依赖 derived session lookup 才跳过
6. plugin wiring 测试：`src/plugin-hooks.ts` 能通过 `client.session.get()` 或等价通道把 `parentID` 判定正确传递给 loop safety transform
7. 非目标边界测试：不新增“title/root-session internal flow 自动跳过”的断言，避免测试暗示本次已解决该问题

## 预期结果

完成后应达到以下状态：

- 主会话仍按现有逻辑接收 Guided Loop Safety 注入
- derived/child session 会因 `parentID` 被识别并跳过注入
- compaction bypass 与 derived-session skip 可以同时存在且互不抢占语义
- session lookup 失败时系统退回当前行为，而不是报错或误判为 child session
- 文档对外表达清楚：本次只解决 child/derived session 干扰，不解决 root-session internal agent 注入
