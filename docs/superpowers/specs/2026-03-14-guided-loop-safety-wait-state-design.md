# Guided Loop Safety 等待态提示词重构设计

## 目标

在现有 `opencode-copilot-account-switcher` 插件中，重构 `Guided Loop Safety` 的固定提示词结构，专门强化等待态与错误复盘场景下的行为约束：

- 只要 `question` 工具可用且未被拒绝，所有用户可见报告继续必须通过 `question` 工具传递
- 在没有剩余非阻塞工作时，模型必须继续通过 `question` 工具进入等待态，而不是安静停止或改用直接 assistant text
- 当模型多次处于等待态时，不能把“重复提问”本身误诊为应该停止提问；真正要改进的是问题内容，而不是放弃 `question` 工具
- 当用户指出报告方式有误时，模型必须优先检查是否违反了 question-tool reporting contract，而不是质疑或重新解释这套报告策略本身
- 保持当前插件的 Copilot-only 注入、固定整段字符串、幂等追加与 fail-open 读取 store 行为不变

## 非目标

- 不修改 OpenCode core。
- 不修改 `superpowers` 插件或上游默认系统提示词。
- 不新增新的持久化开关字段；继续复用 `loopSafetyEnabled`。
- 不改 `Guided Loop Safety` 菜单文案、README 或其他用户可见配置入口。
- 不引入运行时行为检测、策略解析器或动态拼接 prompt 逻辑。
- 不改变 `isCopilotProvider()`、`applyLoopSafetyPolicy()`、`createLoopSafetySystemTransform()` 的数据流与职责边界。

## 背景与问题

当前 `src/loop-safety-plugin.ts` 中的 `LOOP_SAFETY_POLICY` 已经约束了：

- 报告应优先走 `question` 工具
- 报告后应继续未完成工作，或在无事可做时继续通过 `question` 工具等待下一步指令
- 不要把工具使用问题误解为“只是报告太长”

但用户提供的真实对话记录表明，现有文本仍然存在三个等待态相关的缺口：

1. 模型虽然能学到“报告必须走 `question`”，但在彻底 idle 时，仍可能把“等待用户输入”理解成可以静默停止，而不是继续调用 `question` 工具维持用户控制权。
2. 当连续多次进入等待态时，模型可能把“重复提问”错误归因成策略问题，进而得出“应该减少甚至停止 question-tool 调用”的错误结论。
3. 当用户指出报告方式错误时，模型可能继续分析“这套 question-tool 策略是不是被过度应用了”，而不是先承认自己执行策略的方式错了。

本次设计的目标不是扩大功能边界，而是把这些等待态语义从散落约束升级为更强、更清晰的结构化 policy。

## 约束与设计原则

- `LOOP_SAFETY_POLICY` 仍然必须是固定的完整字符串，便于测试、审阅与版本对比。
- Policy 仍然只能在 Copilot provider 且 `loopSafetyEnabled === true` 时追加。
- `applyLoopSafetyPolicy()` 仍然必须保持幂等：如果 `system` 任意位置已包含完整 policy，则绝不能再次追加。
- `createLoopSafetySystemTransform()` 继续在每次调用时重新读取 store，并在读取失败时 fail-open。
- 本次重点是重构 policy 的内部结构与文案，不通过重写实现逻辑来“修复”模型行为。
- 新 policy 必须显式写出“用户控制权”这一理由，避免模型把等待态 question-tool 调用误解成可有可无的礼貌性提示。

## 推荐方案

采用“结构重写但实现最小变更”的方案：

1. 保留 `src/loop-safety-plugin.ts` 的函数结构和注入路径不变
2. 仅重写 `LOOP_SAFETY_POLICY` 的完整文本与内部分组顺序
3. 将等待态规则、报告后分支规则、错误复盘优先级、子代理节制规则重新组织成更清晰的层次
4. 仅更新 `test/loop-safety-plugin.test.js` 中的固定文本断言与相关幂等测试预期

不推荐只做零散补丁的原因：

- 等待态规则目前分散在多条通用表述里，继续补丁式追加更容易让 policy 变成长列表堆叠，而不是清晰的执行顺序
- 用户给出的失败案例本质上是“结构误读”，不是单一缺句，因此需要通过分组与顺序来降低模型误解空间

不推荐同步改菜单或 README 的原因：

- 这次需求聚焦于注入策略本身，不是用户可见配置层
- 把菜单、README 一起纳入会扩大测试面，稀释本次等待态策略重构的验证重点

## 重构后的 Policy 结构

新的 `LOOP_SAFETY_POLICY` 建议保持单块纯文本，但内部语义按以下 4 组组织：

### 1. Question-tool reporting contract

这一组负责定义最上层总规则：

- 只要 `question` 工具可用且被允许，所有用户可见报告都必须通过 `question` 工具发送
- `question` 工具是报告通道，也是用户控制通道
- 只有在 `question` 工具不可用、被拒绝或当前会话不存在时，才允许使用直接 assistant text

这一组的目标是把“question tool 是默认报告通道”升级为“question tool 是唯一合法报告通道，除非工具本身不可用”。

### 2. Post-report control flow

这一组负责把 question-tool 报告后的下一步分支写清楚：

- 每次 question-tool 报告成功后，必须立即判断是否还有未完成的非阻塞工作
- 如果有，继续工作；如果没有，继续通过 `question` 工具进入等待态
- 禁止在 question-tool 报告后追加 assistant text 作为“补一句话”的 fallback
- 如果某个分支本身没有额外可说内容，应当抑制 assistant text 并重新进入 question-tool 流程

这一组的目标是阻断“先正确用 question 汇报，再偷偷用 assistant text 收尾”的常见偏差。

### 3. Idle / wait-state discipline

这一组是本次新增重点，直接处理等待态误判：

- 当没有任何可安全继续的动作时，模型仍然必须调用 `question` 工具，以持续把提供新指令的控制权交还给用户
- 不能把“当前只是等待用户输入”解释成“可以不再调用 question tool”
- 如果已经连续多次处于等待态，重复本身不是停止调用的理由
- 对重复等待场景，允许要求模型改进问题内容或组织方式，但不允许把结论写成“以后不该继续提问”

这一组要直接回应用户提供的教学结论：关键不是把等待问题“问得多漂亮”，而是必须一直使用 `question` 工具来维持用户可插入新任务的入口。

### 4. Reflection / delegation guardrails

这一组负责限制错误复盘与代理使用方式：

- 当用户指出报告方式错误时，模型必须先检查自己是否违反了 question-tool reporting contract
- 不允许把错误归因成“报告策略本身被过度应用”或“这次其实不该使用 question tool”
- 保留现有的 `task` / 子代理节制要求：只有在明显提升结果时才允许派发，且要最小化次数

这一组的目标是避免模型在复盘时反过来削弱本次策略的严格性。

## 用户可观察行为

当 `Guided Loop Safety` 开启且 provider 为 `github-copilot` 或 `github-copilot-enterprise` 时：

- 模型仍应将所有用户可见进度、总结、状态说明、完成通知与下一步请求通过 `question` 工具传递
- 在无剩余非阻塞工作时，模型不应直接静默或用 assistant text 收尾，而应继续发出基于 `question` 工具的等待态消息
- 如果用户多次没有给出新任务，模型仍应继续使用 `question` 工具，而不是把“连续等待”解释成停止提问的理由
- 如果用户要求分析先前哪里做错了，模型应先定位自己是否用错通道或错误离开了 question-tool 流程，而不是怀疑报告策略本身

当功能关闭或 provider 不是 Copilot 时：

- 不注入任何额外 policy
- 既有系统 prompt 与插件其他能力保持不变

## 架构影响

### `src/loop-safety-plugin.ts`

继续作为唯一的 prompt 注入实现文件，职责保持：

- 定义固定 `LOOP_SAFETY_POLICY`
- 判断 provider 是否属于 Copilot
- 在开关开启时向 `output.system` 尾部追加 policy
- 维持幂等与 fail-open 行为

实现层面的唯一目标变更是：让 `LOOP_SAFETY_POLICY` 从“平铺长列表”调整为“更强调执行顺序与等待态纪律的长列表”。

### `test/loop-safety-plugin.test.js`

继续作为固定 policy 文本的唯一确定性测试入口，职责保持：

- 精确锁定新的完整 policy 文本
- 验证非 Copilot provider 不注入
- 验证关闭状态不注入
- 验证开启时只追加一次
- 验证重复 transform 或 policy 已存在时保持幂等

本次不引入新的运行时模拟测试，因为需求本身仍然是“固定字符串必须精确表达这些规则”。

## 错误处理

- store 读取失败时仍然 fail-open：跳过 policy 注入，不中断请求
- 如果 `system` 已包含完整新 policy，仍然不得重复追加
- 如果未来需要继续加强等待态规则，应优先通过更新固定 policy 与测试来完成，而不是通过实现逻辑推断 prompt 内容

## 测试计划

### 自动化测试

至少保留并更新以下覆盖：

1. `LOOP_SAFETY_POLICY` 精确匹配新的完整文本
2. `applyLoopSafetyPolicy()` 在非 Copilot provider 上不追加
3. `applyLoopSafetyPolicy()` 在功能关闭时不追加
4. `applyLoopSafetyPolicy()` 在 Copilot + 开启状态下只追加一次
5. 当完整 policy 已位于 `system` 中任意位置时，保持幂等
6. `createLoopSafetySystemTransform()` 仍然每次读取最新 store 状态
7. store 读取失败时继续 fail-open

### 手工验证重点

由于这是 prompt 注入变更，不是硬约束引擎，手工验证只能观察倾向而非绝对保证。重点观察：

- 在明显无事可做的对话节点，模型是否仍然通过 `question` 工具保持等待态
- 当用户追问“你刚刚哪里做错了”时，模型是否先检查通道/流程违规，而不是反过来质疑 question-tool 策略
- 当对话已多次往返仍然没有新任务时，模型是否继续使用 `question` 工具维持控制权入口

## 验收标准

- `src/loop-safety-plugin.ts` 中的 policy 文本被重构为更清晰的等待态/复盘导向结构
- 文本中显式包含“等待态必须继续调用 question tool 以维持用户控制权”的含义
- 文本中显式包含“重复等待不是停止 question-tool 调用的理由”的含义
- 文本中显式包含“不要质疑或重新解释报告策略本身”的含义
- `test/loop-safety-plugin.test.js` 对新 policy 文本与幂等行为全部通过
- 其余注入逻辑、持久化开关与菜单/README 内容不发生变更

## 已确认结论

- 用户已明确选择采用“重写整理方案”，而不是最小补丁方案
- 本次重点不是优化等待态问题的质量，而是确保在 idle 状态下始终继续调用 `question` 工具
- `question` 工具在等待态中的核心价值是持续把新指令控制权交还给用户
- 模型不得把“重复等待”本身分析成错误，也不得把错误归因到报告策略本身
- 本次实现范围严格限定在 `src/loop-safety-plugin.ts` 与 `test/loop-safety-plugin.test.js`
