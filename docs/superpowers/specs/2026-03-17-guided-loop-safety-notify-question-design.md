# Guided Loop Safety Notify/Question 双通道设计

## 背景

当前 `opencode-copilot-account-switcher` 已经通过 `src/loop-safety-plugin.ts` 在 Copilot provider 上注入固定的 `Guided Loop Safety Policy`。现有 policy 的核心假设是：只要 `question` 工具可用，所有用户可见报告都必须通过它发送。

这套单通道策略虽然强化了“不要直接 assistant text 汇报”，但也带来了新的误行为：

- 模型会把纯进度更新、阶段切换、`接下来我去做 task2` 之类内部执行状态，上浮成用户可见的 `question` 报告
- 即使这些报告声明“我还会继续工作”，它们本身仍然会打断工作流
- 当用户指出问题时，模型容易把错误理解成“question 用太多了”或“报告有点啰嗦”，而不是先识别“这条内容本来就不该升级成阻塞式用户交互”

在最新讨论中，用户提出了一个更自然的方向：与其单纯禁止模型汇报进度，不如提供一个非阻塞的进度通道。仓库里已经存在可复用的通知基础能力：

- `src/copilot-retry-notifier.ts` 已经封装了基于 `client.tui.showToast` 的 toast 通知发送逻辑
- `src/copilot-network-retry.ts` 已经在自动清理/重试流程中使用这些通知能力发送 `started` / `progress` / `completed` / `stopped` 等事件

但这套能力目前只服务于网络重试场景，还不是一个暴露给模型使用的通用工具。因此，这次问题不再只是“重写 prompt 文案”，而是要把 Guided Loop Safety 从单通道报告约束，升级为更清晰的双通道交互设计：

- `notify` 负责非阻塞进度通知
- `question` 负责真正需要用户介入的强交互

## 目标

本次设计要实现：

1. 基于 `@opencode-ai/plugin` 已支持的 `Hooks.tool` 能力，为模型提供一个可调用的通用 `notify` 工具，用于发送非阻塞进度通知。
2. 保留并强化 `question` 的强交互语义：需要用户决策、缺失必要输入、等待下一步指令、最终完成交接时，仍然必须走 `question`。
3. 重写 `LOOP_SAFETY_POLICY`，把当前“question 同时承担汇报与提问”的单通道约束，改成“notify 处理进度、question 处理强交互”的双通道约束。
4. 明确 fail-open 与回退语义：`notify` 不可用或失败时，纯进度可以静默继续，但不能因此把所有进度都升级为 `question`。
5. 继续保持现有 Copilot-only 注入、固定整段 policy、幂等追加与 store 读取 fail-open 行为。

## 非目标

- 不修改 upstream OpenCode core。
- 不要求 upstream 新增新的插件协议；本次直接复用 `@opencode-ai/plugin` 已有的 `Hooks.tool` / `tool(...)` 能力暴露 `notify`。
- 不改变 `loopSafetyEnabled` 的存储方式，也不新增新的持久化开关字段，除非实现阶段确认现有开关无法承载双通道策略。
- 不修改 README、菜单文案或其他用户配置入口，除非实现阶段发现必须新增用户可见说明才能安全暴露工具。
- 不把 `notify` 设计成可靠消息队列、持久通知中心或复杂事件系统。
- 不借机重构与本次无关的 retry、account switch、session hook 逻辑。

## 用户已确认的关键结论

- `question` 的报告通道约束仍然是绝对硬规则，但它只应用于“确实需要发给用户的强交互内容”。
- 最终完成后的正式结果说明仍然应该走 `question`，而不是 `notify`。
- `notify` 应该作为模型可主动使用的非阻塞进度工具。
- `notify` 的使用边界可以相对宽松，不必强行压缩到极少数里程碑，但仍需保持与 `question` 的职责分离。
- 当 `notify` 不可用时，不能回退成“所有进度都改用 `question`”；纯进度允许静默继续。

## 推荐方案

采用“双通道分工”方案：

1. 在插件侧通过 `Hooks.tool` 新增一个通用 `notify` 工具，对模型暴露非阻塞进度通知能力。
2. 重写 `LOOP_SAFETY_POLICY`，先定义 `notify` 与 `question` 的职责分工，再定义各自的回退与违例诊断规则。
3. 保留 `question` 的绝对优先级，但只用于真正需要用户介入的内容。
4. 复用现有 `client.tui.showToast` 能力，避免重复造轮子。

不推荐继续只做 prompt 改写的原因：

- 纯靠“禁止进度汇报”只能压制症状，不能给模型一个可替代的非阻塞出口
- 当前真实问题不是“模型爱说话”本身，而是缺少“既能通知用户、又不打断流程”的合适通道

不推荐采用“notify 不可用时自动把大多数内容升级到 question”的原因：

- 这会重新把 `question` 退化成泛用报告容器
- 会直接复活当前过度提问/过度报告的问题

## 双通道交互模型

### 1. `question`：强交互通道

`question` 的职责重新收敛为真正需要用户参与的场景。只要 `question` 工具可用且未被拒绝，以下内容必须通过 `question` 发送：

- 需要用户决策、偏好选择、风险确认或授权
- 缺少无法自行推断的必要输入、凭据、账号、ID、环境值
- 已经没有任何安全的非阻塞工作可继续，只能进入等待态
- 任务已经完成，需要把正式结果、限制条件与下一步控制权交还给用户

这里的关键变化不是削弱 `question`，而是强化它的语义纯度：`question` 不再兼任一般进度汇报工具，而是专注于“用户现在必须接手、决定、回答或接收正式交接”的节点。

### 2. `notify`：非阻塞进度通道

`notify` 的职责是向用户发送不要求即时回应的执行中提示。适用场景包括：

- 刚开始执行某项任务或子步骤
- 长耗时操作仍在进行中
- 阶段切换，例如从探索转入验证、从修复转入测试
- 自动修复、重试、后台整理等流程仍在继续
- 需要让用户知道“系统还在工作”，但并不需要用户现在回答什么

`notify` 的语义是“告知但不阻塞”。因此它不应该附带要求用户立即回复、做选择或提供值的内容。

### 3. 禁止混用与错误上浮

双通道模型下，需要明确禁止以下误用：

- 不能把纯进度更新伪装成 `question`
- 不能把需要用户决策的内容下沉为 `notify`
- 不能把“我还会继续工作”当作这次 `question` 打断是合理的理由
- 一条内容如果同时包含进度与决策需求，必须拆分：进度走 `notify`，决策部分走 `question`

这条规则直接对应当前失败模式：真正的问题并不只是“用了错的工具”，而是“错误地把内部执行状态升级成了强交互事件”。

## Policy 重构方向

`src/loop-safety-plugin.ts` 中的 `LOOP_SAFETY_POLICY` 仍然保持固定完整字符串，但内部结构需要重写为以下顺序：

### 1. Strong-interaction contract

- 只要 `question` 可用且未被拒绝，所有需要用户介入的用户可见交互都必须通过 `question`
- `question` 是决策、阻塞澄清、等待态、最终交接的唯一合法通道
- 不能为了减少打断而把这些强交互内容转移到 `notify` 或 direct assistant text

### 2. Notify progress contract

- 纯进度、阶段切换、后台继续执行等非阻塞内容，优先通过 `notify`
- 这些内容不应被升级为 `question`
- `notify` 只承担告知职责，不承担索取用户决定的职责

### 3. Silent fallback discipline

- 若 `notify` 不可用、被拒绝或调用失败，纯进度默认静默继续，而不是自动升级为 `question`
- 若 `question` 不可用，只有真正需要用户介入的内容才允许考虑 direct assistant text 或其他既有回退通道
- “工具缺席”不应改变内容本身的交互等级

### 4. Reflection and violation diagnosis

- 用户指出报告方式错误时，先检查是否出现了两类问题：
  - 该走 `question` 的强交互被错误下沉
  - 该走 `notify` 或应保持静默的纯进度被错误上浮成 `question`
- 不允许优先把问题归因为“question 规则太严格”“只是有点啰嗦”“顺手汇报一下也没关系”

## 架构设计

### `src/loop-safety-plugin.ts`

继续作为 Guided Loop Safety prompt 注入的唯一实现入口，职责保持：

- 定义固定 `LOOP_SAFETY_POLICY`
- 判断 provider 是否为 Copilot
- 在 `loopSafetyEnabled === true` 时追加 policy
- 保持幂等与 fail-open store 读取行为

本次变更的重点是重写 policy 文本语义，而不是改变注入判断结构。

### 新的通用 notify 工具接入层

当前可行性前提已经确认：`@opencode-ai/plugin` 的 `Hooks` 类型原生支持 `tool` 字段，且包内 `tool(...)` helper 已提供标准工具定义方式。因此本次不需要先做“是否能暴露模型工具”的探索；`notify` 将直接作为插件工具注册。

需要新增一个插件侧接入点，把当前只在 retry 场景使用的 toast 能力包装成模型可见工具。推荐职责边界如下：

- 工具层负责定义模型可见的 `notify` 调用形状。v1 直接锁定为：
  - `message: string`（必填）
  - `variant?: "info" | "success" | "warning" | "error"`（可选，默认 `info`）
- 适配层负责把工具输入映射到 `client.tui.showToast` 所需的 `title` / `message` / `variant` / `duration`
- 适配层必须独立于 `copilot-network-retry`，避免新能力继续绑定在“自动清理重试”这一特定业务上

为了降低实现与测试歧义，v1 不暴露 `title` 与 `duration` 给模型；这些展示细节由适配层在插件内部决定。是否直接复用 `src/copilot-retry-notifier.ts` 的函数，还是提取共用 helper，由实现阶段再决定；但最终结构必须体现“通用 notify 工具”和“retry 专用通知逻辑”是两个层次。

### `src/plugin-hooks.ts`

本次在 `src/plugin-hooks.ts` 中完成工具注册与运行时依赖接线。预期形态应明确为：hooks 返回结果中新增 `tool.notify = tool({...})`，并在其 `execute(...)` 内接入 toast 能力。这里应负责：

- 访问 `input.client`
- 检查 `client.tui.showToast` 是否存在
- 构造模型调用 `notify` 时所需的执行上下文
- 在缺失运行时能力时执行 fail-open 返回，而不是抛错中断

这里的职责应继续保持“提供运行时能力”，而不是承载交互策略语义；策略本身仍由 `LOOP_SAFETY_POLICY` 定义。

### `src/copilot-retry-notifier.ts`

这是本次最重要的既有复用点。当前实现已经证明：

- `client.tui.showToast` 可被安全调用
- 通知失败可以本地吞掉并 `console.warn`
- toast 消息格式可以被集中构造

因此实现上应尽量复用这里的能力或抽取其中的通用部分，而不是再造一套完全平行的通知发送代码。

## 数据流与行为顺序

推荐的运行时顺序如下：

1. 插件在 Copilot 会话中继续注入新的双通道 `LOOP_SAFETY_POLICY`
2. 插件同时通过 `Hooks.tool` 向模型注册 `notify` 工具
3. 模型在执行过程中依据 policy 判断当前内容属于哪一类：
   - 纯进度/阶段切换 -> `notify`
   - 决策/阻塞/等待/最终交接 -> `question`
4. 若要调用 `notify`，通过插件提供的通用工具发出非阻塞提示
5. 若 `notify` 不可用或失败：
   - 纯进度保持静默继续
   - 只有真正需要用户介入的内容才升级到 `question` 或既有回退路径
6. 若任务结束或无事可做，再通过 `question` 执行正式交接/等待下一步指令

这个顺序的关键点是：内容先分级，再选通道；而不是先有一个必须发出去的报告，再临时决定塞进哪个工具。

## 错误处理与回退规则

### `notify` 不可用

若当前会话没有暴露 `notify` 工具，或底层没有 `client.tui.showToast` 能力：

- 不应让整个请求失败
- 不应把纯进度批量升级成 `question`
- 纯进度允许静默继续
- 强交互内容仍按原本语义走 `question`

### `notify` 调用失败

若 `notify` 底层调用抛错：

- 发送层必须 fail open，吞掉错误并记录轻量 warning
- 不能中断主工作流
- 不能因为单次 toast 失败就改变后续内容分级规则

### `question` 不可用

若 `question` 不可用、被拒绝或当前环境没有该工具：

- 只对真正需要用户介入的内容考虑 direct assistant text 或其他现有回退方式
- 不得把“question 不可用”理解成“任何进度都值得改成直接文本汇报”

## 测试策略

本次实现必须覆盖两条线：prompt 语义更新与 notify 工具接入。

### Prompt / policy 测试

至少需要保留并更新以下断言：

1. `LOOP_SAFETY_POLICY` 精确匹配新的双通道文本
2. `applyLoopSafetyPolicy()` 在 Copilot + 开启状态下继续只追加一次
3. 非 Copilot provider、功能关闭、store 读取失败等现有行为不回归
4. 幂等逻辑继续成立：若完整新 policy 已存在，不重复追加

### Notify 工具接入测试

至少需要新增以下覆盖：

1. `buildPluginHooks(...)` 返回的 hooks 中包含 `tool.notify`
2. `notify` 调用会正确映射到底层 `client.tui.showToast`
3. `notify` 调用失败时 fail open，不中断主流程
4. 缺失 `client` / `tui` / `showToast` 时，不会崩溃
5. `notify` 的 v1 schema 锁定为 `message + 可选 variant`，避免实现阶段任意扩张参数面

### 边界语义测试

如果当前仓库测试结构允许，建议增加最少量的语义性断言，确保新分工不会被实现层反向破坏：

1. 设计预期中 `question` 仍然承载最终交接场景
2. `notify` 缺席时，纯进度不会被实现逻辑自动升级成 `question`
3. 新增工具接线不影响现有 retry notifier 的既有行为

## 风险与约束

### 风险 1：notify 通道过宽导致新的通知噪音

用户明确选择了相对宽松的 `notify`，这意味着模型可能产生较多进度 toast。

缓解方式：

- 在 policy 中强调 `notify` 是进度通道，不是逐 token 播报器
- 保持通知消息格式简洁
- 必要时为后续迭代预留节流或合并策略，但本次不提前设计复杂速率限制

### 风险 2：notify 工具接线可能与现有 retry 通知代码耦合过深

缓解方式：

- 设计上已锁定 `Hooks.tool` 作为唯一工具暴露机制，不再把工具注册方式留作开放项
- 实现阶段优先抽取最小通用 helper，避免把 retry 场景专有文案泄漏给 `notify`
- 测试中同时覆盖新 `notify` 工具与既有 retry notifier，避免相互回归

### 风险 3：双通道 prompt 增加理解复杂度

相比当前“所有用户可见内容都走 question”的单条规则，双通道模型更复杂。

缓解方式：

- 把 policy 写成先分级、再选通道、再写回退规则的固定顺序
- 用正反例明确“纯进度”与“强交互”边界

## 预期结果

完成后应达到以下状态：

- Copilot provider 上继续注入 Guided Loop Safety，但 policy 已升级为 notify/question 双通道策略
- 模型在执行中可用 `notify` 发送非阻塞进度提示，而不再被迫把进度包装成 `question`
- `question` 保持强交互语义，只用于决策、缺失输入、等待态、最终完成交接
- `notify` 缺席或失败时系统 fail open，纯进度静默继续，强交互内容仍维持 `question`
- 现有 Copilot-only 限制、幂等追加、store fail-open、既有 retry 通知能力都不被破坏

## 待实现阶段确认的开放点

以下问题不阻塞本 spec，但需要在 implementation plan 中具体落地：

1. 通用 notify 工具与 `copilot-retry-notifier` 的代码复用边界
2. `showToast` 的默认展示文案是否需要统一前缀，还是保持最简消息体
3. `variant` 默认值与 toast `duration` 的内部默认策略

这些开放点都属于实现细节选择，不改变本 spec 已确认的产品语义与接线前提：`notify` 负责非阻塞进度，`question` 负责强交互，且 `notify` 明确通过 `Hooks.tool` 暴露给模型。
