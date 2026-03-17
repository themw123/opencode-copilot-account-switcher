# Copilot Inject / Wait 与交互通道修复设计

## 背景

当前用户提出了 5 个并行诉求，核心目标分为两组：

1. 新能力：
   - 给模型提供 `wait/sleep` 工具，支持长后台任务等待（最小 30 秒）
   - 提供独立的 `/copilot-inject` 强制介入能力，用于在不发送新用户消息的前提下，尽快把模型拉回 `question`

2. 交互成本控制与行为修正：
   - `notify` / `question` 边界必须更稳定
   - 用户可见回复禁止普通文本（只允许 `notify` / `question`）
   - 首次无账号时不能强制进入手动 token 输入流程，应先进入菜单；首个账号添加后要自动 active

此外，用户明确纠正了一个关键点：

- `/copilot-inject` 是独立 feature，不是“修复历史误判”的补丁。
- 它提供“除打断模型并发送新消息外”的额外强制介入手段。

## 目标

本次设计目标：

1. 新增 `wait` 工具（最小等待 30 秒），返回开始时间、等待时长、当前时间。
2. 新增 `/copilot-inject`（无参数），在当前 OpenCode 实例内激活注入态。
3. 注入态下，改写所有非 `question` 工具返回，在末尾追加 marker 注入块。
4. 改写发生时，每次都 toast：`已要求模型立刻调用提问工具`。
5. `/copilot-inject` 执行当下 toast：`将在模型下次调用工具的时候要求模型立刻调用提问工具`。
6. 一旦检测到 `question` 被调用，立即清除注入态。
7. 交互策略中明确 `notify` / `question` 角色，并加入“不确定场景默认 `question`”兜底。
8. 首次无账号流程修复为菜单优先；首个账号自动 active。

## 非目标

- 不修改 OpenCode core。
- 不把 `/copilot-inject` 设计成持久化跨实例全局开关。
- 不引入新的窗口等待开关（已确认取消 10 秒窗口方案）。
- 不重写整套 loop safety 体系，只做必要且可执行的增强。

## 用户已确认约束（最终）

1. `/copilot-inject` **不接受参数**。
2. 注入态采用**当前实例全局内存态**，不落盘；多实例互不影响。
3. 改写范围是**所有非 `question` 工具**（不是仅 `notify/wait`）。
4. 改写发生时 toast：`已要求模型立刻调用提问工具`，并且**每次改写都弹**。
5. `/copilot-inject` 执行时 toast：`将在模型下次调用工具的时候要求模型立刻调用提问工具`。
6. 用户可见回复禁止普通文本。
7. `question` 角色包含：
   - 需要用户回应才能继续
   - 无可继续工作、进入显式等待
   - 最终交接
8. 若不确定使用哪个工具，或场景不在已定义边界内，默认调用 `question`。

## 推荐方案

采用“实例内注入状态机 + 全工具后置改写 + marker 协议 + 最小策略增强”方案。

理由：

- 满足“无参数命令 + 强介入 + 不发新用户消息”的组合约束。
- 用 `tool.execute.after` 实现统一改写，覆盖面稳定。
- 注入态放内存，避免多实例共享状态引发串扰。
- marker 协议可测试、可审计、可幂等。

## 架构设计

### 1) `wait` 工具

新增 `wait` 工具（插件 `tool` 暴露）：

- 入参：`seconds`（可选）
- 规则：最小等待 30 秒
- 非法入参归一化：`seconds` 缺失、非数值、`NaN`、小于等于 0 时按 30 处理；有效数值小于 30 时提升为 30
- 返回：固定包含三段信息
  - `started`（开始时间）
  - `waited`（等待时长）
  - `now`（当前时间）

### 2) `/copilot-inject` 注入状态机

状态：

- `injectArmed: boolean`（进程内内存态，默认 `false`）

生命周期：

1. `/copilot-inject` 执行 -> `injectArmed=true`
2. 非 `question` 工具返回 -> 若 `injectArmed=true` 则追加 marker 块并 toast
3. 检测到 `question` 工具调用 -> 立即清除 `injectArmed=false`
4. 在 `question` 的 after 阶段再次执行幂等清理，作为兜底（避免异常路径遗留）

### 3) Marker 协议（注入块）

对非 `question` 工具输出追加以下结构（末尾追加，不覆盖原输出）：

- BEGIN：`[COPILOT_INJECT_V1_BEGIN]`
- BODY：`立即调用 question 工具并等待用户指示；在收到用户新指示前，不要继续执行后续任务。`
- END：`[COPILOT_INJECT_V1_END]`

幂等规则：

- 若输出已包含 `BEGIN/END` 对，本次不重复追加。
- 若检测到残缺标记（仅 `BEGIN` 或仅 `END`），先清理残缺标记，再追加完整三段注入块。

### 4) hooks 接线

- `config`：注入 `/copilot-inject` 命令定义。
- `command.execute.before`：处理 `/copilot-inject` 置位与初始 toast。
- `tool.execute.after`：
  - 对非 `question` 工具执行 marker 追加与“已要求...” toast。
-  - 对 `question` 工具执行注入态兜底清除。
- `tool.execute.before`：
  - 检测到 `question` 时优先清除注入态，确保尽快结束注入周期。
- `tool.definition`：动态强化 `question` / `notify` 语义描述，降低工具误用概率。

## 交互策略增强（可执行版本）

在现有 `LOOP_SAFETY_POLICY` 基础上增强为可判定矩阵（不是口号）：

1. `notify` 用于纯进度、阶段切换、后台执行状态。
2. `question` 用于：
   - 必须用户回应才能继续
   - 无可继续工作的显式等待
   - 最终交接
3. 用户可见通道仅允许 `notify` 与 `question`，普通文本回复一律视为违规。
4. 不确定归类或场景超出边界时，默认 `question`（兜底规则）。
5. 若检测到 inject marker，必须立即调用 `question` 并进入等待。

> 注：本次是“增强并收敛”，不是整套推翻重写。

## 首次无账号流程修复

当前问题：空账号时提前进入手动 token 输入路径。

修复目标：

1. 当 store 与官方 auth 都为空时，直接进入菜单。
2. 用户在菜单内可选择 device code 或手动录入。
3. 首个成功添加账号后自动 active（复用 `activateAddedAccount`）。

## 错误处理与回退

1. 注入态读写失败（内存态异常）：fail-open，不破坏原工具结果。
2. toast 发送失败：记录 warning，不影响输出改写。
3. 输出为空或非字符串：先标准化为字符串再追加 marker。
4. `question` 清除失败（极端异常）：下次 `question` 再次尝试清除。

## 测试矩阵

### A. `/copilot-inject`

- A1：执行后 `injectArmed=true`
- A2：命令时 toast 为“将在模型下次调用工具的时候要求模型立刻调用提问工具”

### B. 全工具改写

- B1：`injectArmed=true` + 非 `question` 工具 -> 追加 BEGIN/BODY/END
- B2：原输出保留，注入仅追加
- B3：已有 marker 对时不重复追加
- B4：每次实际追加都 toast“已要求模型立刻调用提问工具”

### C. `question` 清除

- C1：`injectArmed=true` 时调用 `question` 后自动清除
- C2：清除后后续工具不再追加 marker

### D. `wait`

- D1：`seconds < 30` 强制到 30
- D2：返回含 started/waited/now 三段

### E. 策略与工具定义

- E1：`LOOP_SAFETY_POLICY` 固定文本断言包含：
  - 禁止普通文本用户可见回复
  - `notify/question` 判定矩阵
  - 不确定场景默认 `question`
- E2：`tool.definition` 对 `question/notify` 描述动态强化成功

### F. 首启账号

- F1：空 store + 空官方 auth 时，不触发 `promptAccountEntry([])` 直入手动路径
- F2：首个账号添加后自动 active

### G. 验收

- `npm test` 通过
- `npm run typecheck` 通过

## 风险与缓解

1. 风险：全工具注入可能提升输出长度。
   - 缓解：marker 结构固定且短；幂等避免重复膨胀。

2. 风险：模型仍可能忽略 marker。
   - 缓解：系统策略 + tool.definition 双层约束；保留 `/copilot-inject` 可重复触发。

3. 风险：策略增强后误触发 `question`。
   - 缓解：明确“notify 处理进度，question 处理等待/交接/必需输入”，并加反例测试。

## 预期结果

完成后应达到：

1. 用户拥有可随时触发的 `/copilot-inject` 强介入能力（无参数）。
2. 模型在注入态下对非 `question` 工具返回统一带 marker，强制转向 `question`。
3. `wait` 工具支持长任务等待并返回标准时间线信息。
4. `notify/question` 边界更清晰，普通文本用户可见回复被禁止。
5. 首次无账号体验回到菜单优先，首账号自动激活。
