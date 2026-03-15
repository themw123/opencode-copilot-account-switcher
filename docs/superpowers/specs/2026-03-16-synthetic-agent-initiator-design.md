# Synthetic Agent Initiator Design

## 背景

当前 upstream `opencode` 已经通过 `x-initiator` 将部分“不是用户直接输入、但在协议层仍表现为 user message”的请求标记为 `agent`，以对齐 GitHub Copilot / VSCode 官方的 premium request 计费语义。

目前已知的 upstream 行为包括：

- 基础规则：`packages/opencode/src/plugin/copilot.ts` 会根据最终请求体中最后一条消息的 `role` 推导 `x-initiator=agent|user`。
- 已落地特例：subagent session（`session.parentID`）与 compaction message 会被额外标记为 `agent initiated`。
- 未完成部分：`synthetic` 已经存在于会话层 `TextPart`，并被用于区分真实用户输入与系统生成文本，但 upstream 尚未把这层语义稳定传播到 Copilot billing / initiator 判定层。上游 issue `#8700`、PR `#8721`、issue `#8766` 都说明这条链路仍在演进中。

结合真实 `0.3.5` 调试日志与 upstream 源码，可以确认：压缩后自动继续工作会创建新的 `role: "user"` 消息，并附带 `type: "text", synthetic: true` 的继续提示。这类请求在语义上并不是用户直接输入，但 upstream 当前版本尚未稳定地将其归类为 `agent`。

用户希望本插件提供一个**默认关闭的可选开关**，允许在 upstream 完成这条能力前，提前根据 `synthetic` 语义把这些自动生成的消息标记为 `agent initiated`，同时明确披露风险：该行为与 upstream 当前稳定实现不一致，可能更容易被 Copilot 判定为滥用，也可能因 upstream 后续变更而失效或产生意外计费。

## 目标

本次设计要实现：

1. 提供一个默认关闭的可选功能：为 synthetic message 发送 `x-initiator=agent`。
2. 不依赖文本匹配，而是直接读取当前 message 的 `synthetic` part 语义。
3. 在菜单与 README 中明确告知这是基于 upstream 开发中语义的提前启用开关，而非 upstream 当前稳定行为。
4. 在文档中给出相关 upstream 讨论和提交链接，帮助用户理解该功能的来历与风险边界。

## 非目标

- 不宣称 upstream 当前已经正式支持“所有 synthetic message 都免计费”。
- 不修改 upstream snapshot 的基础同步策略，也不伪造 upstream 已存在的官方实现。
- 不引入基于文本模式的 synthetic 检测规则。
- 不改变默认行为；该功能必须保持默认关闭。

## 方案概述

### 1. 增加默认关闭的 store 开关

在 `src/store.ts` 的 `StoreFile` 中新增布尔位，例如：

- `syntheticAgentInitiatorEnabled?: boolean`

约束如下：

- 默认值为 `false`
- 与 `loopSafetyEnabled`、`networkRetryEnabled` 一样写入 `~/.config/opencode/copilot-accounts.json`
- `parseStore()` 负责兼容旧配置：缺省或非 `true` 时统一视为 `false`
- debug store snapshot 也要包含该字段，方便排查开关状态

这样既能保持向后兼容，也能让菜单切换后的行为在重启后持续生效。

### 2. 菜单中提供显式 opt-in 开关并强调风险

在 `src/ui/menu.ts` 中新增 toggle action，并放在现有 Copilot 行为类开关附近（推荐在 `Copilot Network Retry` 之后）。

菜单文案要求：

- 中文主文案：`开启为 synthetic message 发送 Agent 标识` / `关闭为 synthetic message 发送 Agent 标识`
- 英文主文案：`Enable agent initiator for synthetic messages` / `Disable agent initiator for synthetic messages`
- hint 必须明确表达：
  - 会让请求行为与 upstream 当前代码不一致
  - 依赖 upstream 尚未稳定完成的 synthetic 语义
  - 可能更容易被判定为滥用
  - 也可能失效或产生意外计费行为

菜单层的目标不是解释全部背景，而是确保用户在打开开关时能看到足够明确的风险提示。

### 3. 仅在开关开启时，对 synthetic text message 追加 `x-initiator=agent`

在 `src/plugin-hooks.ts` 的 `chat.headers` 流程中，保留现有 official upstream 行为，然后只在本插件开关开启时追加一层本地预测逻辑。

当前插件侧已经具备所需数据入口，不需要修改 upstream：

- `chat.headers` hook 输入里已经有 `hookInput.message.id` 与 `hookInput.message.sessionID` / `hookInput.sessionID`
- 当前代码也已经在 debug 分支中通过 `input.client?.session?.message?.({...})` 回查当前 message 的 parts，说明这条读取路径在插件 API 范围内可达
- 因此实现时应直接复用这条现有入口：使用 `input.client?.session?.message?.({ path: { id: hookInput.message.sessionID ?? hookInput.sessionID, messageID: hookInput.message.id }, query: { directory: input.directory }, throwOnError: true })`

也就是说，这个功能的实现边界仍然完全限定在本插件可访问的 `chat.headers` hook 输入、plugin `client.session.message()`、本地 store 开关和 README / 菜单文案内。

推荐顺序：

1. 先执行 official `chat.headers`
2. 读取 store，确认 `syntheticAgentInitiatorEnabled === true`
3. 回查当前 `message.id` 对应的 session message parts
4. 如果当前 message 中存在 `part.type === "text" && part.synthetic === true`
5. 则设置 `output.headers["x-initiator"] = "agent"`

设计意图：

- **不覆盖默认行为**：开关关闭时完全跟随 upstream 当前逻辑
- **不依赖文本内容**：避免 prompt injection / 恶意构造文本骗过分类
- **只读取当前 message 的结构化语义**：把规则约束在 upstream 已存在但尚未 fully wired 的 `synthetic` 字段上

失败降级要求：

- 如果 store 读取失败、`hookInput.message.id` 缺失、`client.session.message()` 查询失败，或返回结果里没有可用 parts，必须保持 official `chat.headers` 的原结果，不做任何额外 initiator 改写
- 换言之，本地 synthetic 预测逻辑只能在“成功读取到当前 message parts，且明确看到 `text + synthetic: true`”时生效；所有不确定路径都必须 fail open to official behavior

### 4. 规则边界

该开关的语义不是“所有系统消息都一定免计费”，而是：

- 对当前 message 含有 `synthetic: true` 的 text part 时，**预测性地**将其视作 upstream 未来更可能采用的 `agent initiated` 范围
- 这会覆盖至少以下已知场景：
  - compaction 后自动继续工作
  - subagent / tool / plan / recovery 等由 upstream 或插件系统自动生成的 synthetic user text

但仍需明确：

- 这是**预测性兼容开关**，不是 upstream 当前稳定协议
- upstream 未来可能改成更显式的 metadata 传播方案、也可能改变 `synthetic` 的使用方式
- 因此该功能既可能失效，也可能与未来 upstream 的正式实现不完全一致

### 5. README 明确披露行为偏差与风险

README 需要新增独立章节，至少说明以下信息：

- 功能名称与默认值：默认关闭
- 作用效果：启用后，插件会为压缩后继续工作以及其他自动生成的 synthetic 提示消息发送或覆盖 `x-initiator=agent`；实际是否计费仍由 Copilot 平台决定
- 风险说明：
  - 当前行为与 upstream 稳定分支代码不一致
  - 属于基于上游开发中语义的提前启用方案
  - 可能更容易被 Copilot 平台判定为滥用
  - 依赖 upstream 尚未稳定的内部 API / 语义，未来可能失效或产生意外计费
- 相关 upstream 讨论与参考链接：
  - `https://github.com/anomalyco/opencode/issues/8700`
  - `https://github.com/anomalyco/opencode/pull/8721`
  - `https://github.com/anomalyco/opencode/issues/8766`
  - `https://github.com/anomalyco/opencode/commit/88226f30610d6038a431796a8ae5917199d49c74`

README 中还应明确区分：

- `Copilot Network Retry`：网络失败恢复开关
- `Synthetic Agent Initiator`：基于 upstream 开发中语义的计费/initiator 预测开关

避免用户误以为它们解决的是同一类问题。

## 为什么不用文本匹配

文本匹配虽然能快速覆盖 `"Continue if you have next steps..."` 等已知模板，但存在明显问题：

- 易受文本漂移影响，模板一变就失效
- 容易被恶意 prompt 构造碰撞
- 不能稳健覆盖其他 synthetic message 场景
- 上游 issue `#8766` 已明确把文本模式视作过渡方案，目标是迁移到 metadata / structured semantics

因此本次设计明确放弃文本模板识别，直接依赖当前 message parts 中已有的 `synthetic` 字段。

## 备选方案对比

### 方案 A（推荐）：总开关 + synthetic part 判定

优点：

- 与用户目标一致，覆盖面完整
- 不依赖文本匹配
- 落地成本低，可复用现有 store / menu / `chat.headers` 接线

缺点：

- 会影响所有 synthetic user text，而不仅是 compaction 后继续工作
- 行为领先于 upstream 当前稳定版本，需要明确风险披露

### 方案 B：仅对 compaction 后 synthetic continue 做窄特判

优点：

- 风险面更小
- 更接近当前最强证据场景

缺点：

- 无法覆盖用户明确希望涵盖的“其他自动生成提示消息”
- 仍需构造来源链 / 邻接关系，复杂度更高
- 如果 upstream 后续统一以 synthetic 为准，还要再推倒重来

### 方案 C：只写文档，不提供开关

优点：

- 最保守
- 不引入任何新行为漂移

缺点：

- 无法满足“允许用户在 upstream 稳定前主动 opt-in”的目标

## 风险与约束

### 风险 1：被平台视为更激进的 agent attribution

因为该开关会让部分 upstream 当前仍视作 user-role 的请求带上 `x-initiator=agent`，存在更容易被平台侧判定为异常或滥用的风险。

缓解方式：

- 默认关闭
- 菜单与 README 双重披露风险
- 不做隐式启用，不做自动迁移

### 风险 2：依赖上游尚未稳定的内部语义

`synthetic` 当前虽已在会话层广泛使用，但 upstream 还没完成从 message parts 到 Copilot initiator 判定层的稳定接线。

缓解方式：

- README 明确说明这是“预测性开关”
- 行为实现尽量最小化，只在 `chat.headers` 末端读取现有结构化字段

### 风险 3：未来 upstream 语义变化导致失效或偏差

如果 upstream 将来改成 `providerMetadata`、专用 message annotation，或者调整 `synthetic` 使用范围，本插件逻辑可能失效，甚至产生与 upstream 不一致的额外计费行为。

缓解方式：

- 将该开关与 upstream 同步机制一并纳入后续维护
- 在 README 中提醒用户该功能可能失效或产生意外计费

## 测试策略

实现时必须走 TDD。至少需要以下测试：

1. store 默认值测试：未配置时 `syntheticAgentInitiatorEnabled` 为 `false`
2. 菜单文案测试：默认显示开启项；启用后显示关闭项；hint 含“与 upstream 当前代码不一致”等风险措辞
3. 菜单顺序测试：该开关位于现有 Copilot 行为类开关附近，避免埋得太深
4. `chat.headers` 行为测试：
   - 默认关闭时，synthetic text 不会额外强制改写 `x-initiator`
   - 开启后，当前 message 若含 `type: "text", synthetic: true`，则会追加 `x-initiator=agent`
   - 开启后，普通非 synthetic user message 不受影响
   - 开启后，`synthetic: true` 但不是 `text` part 时不触发
   - 开启后，非 Copilot provider 不受影响
   - 开启后，message/parts lookup 失败时严格退回 official `chat.headers` 结果，不额外改写 `x-initiator`
5. README / 文案变更不需要自动化断言，但至少在 review 中核对所有风险提示与上游链接完整存在

## 预期结果

完成后应达到以下状态：

- 插件新增一个默认关闭的 `Synthetic Agent Initiator` 可选开关
- 用户可显式选择是否提前启用基于 synthetic 语义的 agent attribution 预测逻辑
- 启用后，压缩后继续工作及其他自动生成的 synthetic 提示消息会发送或覆盖 `x-initiator=agent`，但实际计费结果仍由平台决定
- README 与菜单都明确披露：这与 upstream 当前稳定实现不一致，可能失效，也可能产生意外计费或更高滥用风险
