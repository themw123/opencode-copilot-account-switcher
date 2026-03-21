# Copilot Stop-Tool / Compact 与 Status 省略号修复设计

## 背景

当前插件已有 `/copilot-status`、`/copilot-inject`、`/copilot-policy-all-models` 等实验性 slash command，但还缺两个重要的“不中断当前工作流”的控制能力：

1. 用户希望在模型已经开始调用工具时，能够中断当前工具阶段，但不要把整轮模型工作直接停死；同时，希望 transcript 中能明确留下“用户主动中止，结果可能不完整”的语义。
2. 用户希望主动触发一次与“上下文溢出后自动压缩”完全一致的压缩流程，而不是仅仅新增一个近似功能。

同时，`/copilot-status` 目前的用户名中间截断使用 `...`，用户要求改成单列宽的 `…`，避免在 16 字符单元格内白白浪费 2 列宽度。

## 目标

本次设计目标：

1. 新增 `/copilot-stop-tool`。
2. 当且仅当当前会话存在单个运行中的工具调用时，尝试中断当前工具阶段。
3. 中断后先把目标 tool part 改写成带有“用户主动中止 / 输出可能不完整”语义的 transcript，再自动发送 synthetic continue 消息，让模型继续剩余工作。
4. 新增 `/copilot-compact`。
5. `/copilot-compact` 必须复用 OpenCode 现有 `session.summarize(auto=true)` 语义链路，让行为与上下文溢出时的自动压缩保持一致。
6. 让压缩在合适的边界执行：如果当前正在进行一轮工具调用，则在本轮工具结束、下一次 loop 迭代时进入 compaction，与上游自动 overflow 触发时机一致。
7. 将 `/copilot-status` 的中间省略从 `...` 改为 `…`，并保持 50 宽 / 3 列布局不变。

## 非目标

1. 不修改 OpenCode core。
2. 不发明新的宿主级“单 tool call abort handle”协议。
3. 不尝试支持“同一轮响应里多个并行运行工具时只停其中一个”。
4. 不改 `/copilot-status` 的整体分组布局，只修正省略号宽度语义。
5. 不在 stop-tool 的近似版里继续宣称“真正只停当前 tool”。

## 关键约束

### 1. `/copilot-compact`

用户明确要求它与“上下文超限时触发的压缩”完全一致，因此不能做成：

- 手工总结一个提示词；
- 自己拼 synthetic summary；
- 或仅仅插入某种“伪压缩标记”。

必须直接复用 OpenCode 已有的 compaction 流程。

### 2. `/copilot-stop-tool`

插件侧目前能可靠拿到的是 session 级能力：

- `session.abort`
- `session.messages`
- `session.message`
- `session.promptAsync`

没有现成的“只对某个 tool call 发 abort signal”接口。因此插件实现无法真正做到宿主层面的 call 级定点终止，只能通过：

1. 识别当前是否恰好只有一个运行中的工具调用；
2. 使用 session 级 abort 停掉当前执行中的工具阶段；
3. 等待目标 tool part 落成 `completed` 或 `error`；
4. 用 `part.update` 给该 tool part 补上“用户主动中止 / 结果不完整”的 transcript 语义；
5. 再自动补一条 synthetic continue 消息，让模型继续。

这已经是**不改 core 前提下最接近用户诉求、且语义更诚实的近似实现**。

### 3. synthetic agent initiator 前置要求

`/copilot-stop-tool` 的恢复阶段依赖 synthetic continue。当前仓库已经提供 `syntheticAgentInitiatorEnabled` 实验开关，并且菜单中明确提示：开启它会改变 upstream 默认行为，误用可能带来额外计费或 abuse 风险。

因此 stop-tool 近似版必须增加显式前置检查：

- 如果 `syntheticAgentInitiatorEnabled !== true`，命令只给 warning toast，不执行 abort、patch 或 continue。
- warning 必须明确说明：若不开启该实验特性，这次恢复会额外产生一次 billed synthetic turn。

### 4. 多运行中工具的处理边界

如果同时存在多个 `running/pending` tool part，插件无法保证“只停当前这一个”。

因此本次设计采用**收窄语义**：

- 0 个运行中工具：warning toast，什么都不做。
- 1 个运行中工具：执行 stop-tool 流程。
- 多个运行中工具：warning toast，明确当前场景不支持，拒绝误伤。

## 推荐方案

采用“真实会话控制链路复用 + transcript 语义补全”的方案。

### A. `/copilot-compact`

在 `command.execute.before` 中拦截 `/copilot-compact`，后台异步执行：

1. 读取当前 session 的最近消息；
2. 解析可用的 provider/model（优先最近 user message，其次最近 assistant message）；
3. 调用真实的 `session.summarize`，并显式传入 `auto: true`。

为什么是 `auto: true`：

- OpenCode 自动 overflow compaction 的入口是 `SessionCompaction.create({ auto: true })`；
- `session.summarize(auto=true)` 最终也会走同一条 `SessionCompaction.create/process` 路径；
- `auto: true` 才会在 compaction 完成后自动追加 synthetic continue 文本：
  `Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.`

这正好满足用户要求的“完全一致 + 自动继续”。

### B. `/copilot-stop-tool`

在 `command.execute.before` 中拦截 `/copilot-stop-tool`，后台异步执行：

1. 读取 store；若 `syntheticAgentInitiatorEnabled !== true`，只提示并退出，不执行任何副作用。
2. 读取当前 session 最近消息。
3. 找到唯一的 `running/pending` tool part；如果没有或不唯一，则 warning toast 并退出。
4. 调用 `session.abort` 停掉当前 session 的执行，借助现有 abort signal 让 bash / task / MCP 等工具尽快退出。
5. 轮询 session message / part，等待目标 tool part 稳定进入：
   - `completed`，或
   - `error`。
6. 使用 `client.part.update(...)` 改写目标 tool part：
   - `completed`：在 `state.output` 末尾追加一段固定 marker，表达“该工具由用户主动中止，输出可能不完整”。
   - `error`：在 `state.error` 上追加同类语义，强调这是用户主动中止后的错误态，而不是普通工具失败。
7. patch 成功后，再调用 `session.promptAsync` 发送 synthetic continue 消息，让模型自动继续剩余工作。

继续消息文本不再只复用 compaction 的通用 continue，而是明确带上 stop-tool 语义，例如：

`The previous tool call was interrupted at the user's request. Treat its result as partial evidence. Continue with the remaining work, and do not resume that tool unless the user explicitly asks for it.`

这样既保留自动继续能力，又把“用户主动中止”语义真正写进 transcript 与恢复提示词里。

## 命令注册与文案

实验性 slash commands 开启时，新增两条命令：

1. `copilot-stop-tool`
   - template: 说明其用于中断当前 session 的工具阶段、给目标工具结果补上用户中止语义、再自动继续
   - description: Experimental session-interrupt and interrupted-tool annotation helper

2. `copilot-compact`
   - template: 说明其用于按自动 compaction 路径触发上下文压缩并自动继续
   - description: Experimental compaction helper matching overflow behavior

菜单里的“Experimental slash commands”提示文案也要同步更新，明确这两个命令也在统一开关控制下。

## Toast 语义

### `/copilot-compact`

- 成功调度：`已按自动压缩路径安排上下文压缩；压缩完成后会自动继续当前工作`
- 无法解析模型：`当前会话还没有可用于压缩的模型上下文`
- 后台调用失败：`触发上下文压缩失败：<error>`

### `/copilot-stop-tool`

- synthetic 未开启：`/copilot-stop-tool 需要先开启 “Send synthetic messages as agent”；否则恢复阶段会额外产生一次 billed synthetic turn`
- 没有运行中工具：`当前没有可中断的工具调用`
- 多个运行中工具：`当前存在多个运行中的工具调用，暂不支持只停止其中一个`
- 等待 tool part 落盘失败：`工具调用已中断，但未能确认中止结果已写入 transcript，因此不会自动继续`
- patch 失败：`工具调用已中断，但未能写入“用户主动中止”语义，因此不会自动继续：<error>`
- 停止并续跑成功：`已中断当前工具阶段，已标记工具结果为用户主动中止，并要求模型继续剩余工作`
- abort 失败：`中断当前工具阶段失败：<error>`
- 续跑失败：`中止语义已写入 transcript，但恢复模型继续失败：<error>`

## `/copilot-status` 省略号修复

当前 `truncateMiddle()` 逻辑把省略号当成 `...` 三列处理，这会导致：

- 同样 16 列单元格里，可见用户名字符比实际应该更少；
- 视觉上也不符合用户要求。

修复方式：

1. 将省略标记改为单字符 `…`。
2. 截断宽度计算从 `maxWidth - 3` 改为 `maxWidth - 1`。
3. `maxWidth === 1` 时直接返回 `…`。
4. 其他布局参数不变，继续保持：
   - 单 cell 宽 16
   - 一行 3 列
   - 总宽 50

## 测试矩阵

### A. Slash command 注入

- `config.command` 开启实验开关时同时注册：
  - `copilot-status`
  - `copilot-inject`
  - `copilot-policy-all-models`
  - `copilot-stop-tool`
  - `copilot-compact`
- 关闭实验开关时全部不注册。

### B. `/copilot-compact`

- 读取最近 user model 并调用 `session.summarize`。
- `body.auto === true`。
- 当没有 user model 时回退到最近 assistant model。
- 无法解析 model 时只 toast，不调用 summarize。

### C. `/copilot-stop-tool`

- synthetic 开关未启用时 warning toast，且不执行 abort / patch / continue。
- 无运行中工具时 warning toast。
- 多运行中工具时 warning toast。
- 单运行中工具时：
  - 调用 `session.abort`
  - 等待目标 tool part 落成 `completed` 或 `error`
  - 通过 `part.update` 把用户主动中止语义写入 transcript
  - 再发送 synthetic continue 的 `promptAsync`
- `completed` 与 `error` 两条 patch 路径都要覆盖。
- patch 失败时不能继续 promptAsync。
- promptAsync 失败时 transcript 仍保留已 patch 的中止语义。

### D. `/copilot-status`

- 50 列布局保持不变。
- 中间省略从 `...` 改为 `…`。
- 长用户名 cell 断言不再出现三点字符串。

## 风险与缓解

### 风险 1：`/copilot-stop-tool` 本质仍然依赖 session 级 abort

这意味着它并不是宿主级“单 tool call signal”能力。

缓解：

- 只在存在单个运行中工具时启用；
- 多运行中工具直接拒绝执行；
- 通过 transcript patch 明确告诉用户和模型：这不是“真单停”，而是会话级中断后的语义补全与恢复。

### 风险 2：tool part 可能在 abort 后迟迟无法稳定落盘

缓解：

- 只在确认目标 tool part 已进入 `completed`/`error` 后才 patch；
- 如果等不到稳定状态，则直接报错并拒绝继续，避免 transcript 语义不完整。

### 风险 3：synthetic continue 依赖实验开关，关闭时存在额外计费风险

缓解：

- 在命令入口做硬性前置检查；
- 文案明确告诉用户为什么必须先开 `Send synthetic messages as agent`。

### 风险 4：`session.summarize` 是同步返回的后台任务入口，不应阻塞 slash command

缓解：

- 在 hook 中以后台 promise 调度，不阻塞 command handling；
- 失败时通过 toast 回报，而不是把 slash command 卡住。

## 预期结果

完成后应达到：

1. 用户可以通过 `/copilot-compact` 主动触发与 overflow 完全一致的 compaction，并在 compaction 后自动让模型继续。
2. 用户可以通过 `/copilot-stop-tool` 在“恰好一个运行中工具”的场景下，中断当前工具阶段、把“用户主动中止 / 结果可能不完整”语义写入工具 transcript，再自动让模型继续剩余工作。
3. `/copilot-status` 的用户名截断在固定 16 列 cell 内更省宽，真正使用单列 `…`。
