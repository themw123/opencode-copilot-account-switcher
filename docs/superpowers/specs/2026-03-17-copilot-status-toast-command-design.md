# Copilot 状态 Slash Command 实验特性设计

## 背景

当前用户希望在 OpenCode 正常对话实例中，快速查看当前 GitHub Copilot 账号及 quota 使用情况，并且优先希望获得类似“常驻面板”或“原生状态区域”的体验。

但经过本轮静态分析、类型定义检查、上游讨论检索与实现链路核实，可以确认以下事实：

- 现有 OpenCode 插件 API 不提供可供插件注册的原生持久 UI 区域。
- 插件无法把内容注入 OpenCode 现有的原生 `Sidebar`、`DialogStatus`、footer 或其他宿主面板。
- 在不修改 OpenCode 本体的前提下，插件侧不存在正式的“会话内面板入口”或“插件命令回调 API”。
- `auth.methods` 虽然能打开账号管理流，但不适合作为正常对话实例中的常规状态查看入口。
- model-visible `tool` 可以提供主动能力，但本轮设计已明确排除该方向。

同时，继续对 slash command 执行链进行核实后，又得到一个更具体的结论：

- 插件可以通过 `config` hook 注入 slash command 名字。
- 插件也可以通过 `command.execute.before` 识别该命令并执行副作用逻辑。
- 但当前没有正式的 handled/cancel/stop API 来把该命令声明为“已由插件处理完成”。
- 若要阻止默认命令继续落入普通 prompt/LLM 链，只能采用类似 `opencode-pty` 的 workaround：在 hook 内完成副作用后主动抛错，借异常中断后续命令处理。

这说明：当前不是完全做不到，而是只能做成一个基于现有行为的实验性 workaround，而不能把它包装成稳定正式契约。

## 目标

本次设计要实现：

1. 为用户提供一个在正常 OpenCode 对话实例中可主动触发的 Copilot 状态查询入口。
2. 入口触发后，实时重新拉取当前 active account 的最新 quota，而不是只读取本地缓存。
3. 使用两阶段非阻塞 toast/notify 反馈查询开始与最终结果，避免依赖模型参与渲染。
4. 拉取成功后，把最新 quota 快照写回 store，供现有菜单与后续提醒逻辑复用。
5. 将该能力明确设计为“默认启用的实验特性”，并在上游提供稳定 command-handled API 后切换实现。

## 非目标

- 不实现原生 persistent panel、sidebar widget、status bar 或其他宿主 UI 注入。
- 不修改 OpenCode core。
- 不依赖 `auth` 面板作为正常对话里的状态查看入口。
- 不通过 model-visible `tool` 提供查询能力。
- 不声称当前方案具备跨客户端一致体验。
- 不把当前 workaround 描述成稳定公开契约。
- 不做多账号汇总视图、持续轮询或会话内常驻状态块。

## 用户已确认的关键结论

- 不允许修改 OpenCode 本体。
- 不接受依赖原生面板注入作为当前方案前提。
- 不接受依赖 `auth` 面板作为正常对话中的常规入口。
- 不给模型侧提供 tool。
- 接受 slash command 作为入口。
- 手动触发后，应重新拉取 quota，而不是只读缓存。
- 展示方式采用非阻塞通知，当前以 toast 作为最稳的 notify 落点。
- 接受把 slash command 做成默认启用的实验特性，并在上游稳定 API 落地后切换实现。

## 方案概述

推荐采用“默认启用的实验性 Slash Command + 双阶段 Toast 通知”方案：

1. 插件通过 `config` hook 向 OpenCode 配置注入一个状态查询 slash command，例如 `/copilot-status`。
2. 插件通过 `command.execute.before` 监听该命令。
3. 命中后，插件立即发出第一条非阻塞通知：`正在拉取 Copilot quota...`
4. 插件随后针对当前 active account 重新请求最新 quota。
5. 拉取成功后，发出第二条非阻塞通知，展示当前账号、核心 quota 信息与更新时间。
6. 拉取失败后，发出第二条非阻塞通知，展示错误摘要，并在有历史快照时附带最近一次成功信息。
7. 为了阻止默认 slash command 继续落入普通 prompt/LLM 链，插件在完成副作用后通过抛错中断当前命令执行。
8. 该能力默认启用，但在文档与实现中都明确标为 `experimental` / `workaround`。

本方案的核心价值不是“伪造一个稳定命令 API”，而是在当前约束下，用真实可行的组合能力给用户提供一个可用入口，并把风险透明暴露出来。

## 核心前提与现实约束

### 1. 这是 workaround，不是正式命令 API

当前公开插件 hooks 中没有真正的插件命令执行回调，也没有 `handled` / `stop` / `cancel` 之类控制流信号。

因此本方案成立的前提不是“OpenCode 已正式支持插件命令动作”，而是：

- `config` hook 可注入 slash command 名字
- `command.execute.before` 可识别命令并执行副作用
- 抛错可在当前实现中中断后续默认命令链

这个前提必须在 spec 中明确写出，避免后续实现者误把它理解成正式契约。

进一步说，当前实现中的 `StatusCommandHandledError` 只是一种内部控制流信号，用来表达“这个实验命令的默认链路已由插件 workaround 接管并结束”。它不是公开 API，也不代表真实业务成功；真实的 store 读取失败、quota 刷新失败、store 写回失败仍必须通过结果 toast 单独表达。

### 2. 这是 TUI-first 的实验特性，不保证跨客户端一致

进一步核实后确认：

- 插件在 `command.execute.before` 中无法可靠区分当前命令来自 TUI 还是 Web/App。
- 因此无法把该 workaround 精确限制为“只对 TUI 生效”。
- 当前证据显示，TUI 路径下它大概率“看起来可用”；但 Web/App 更可能把这种中断行为视为命令失败并给出额外错误提示。

所以本方案虽然默认启用，但必须被描述为：

- TUI-first
- cross-client behavior unspecified
- 不承诺在所有客户端上都有同样体验

同时，本轮实现与测试以 TUI 路径为主支持面；Web/App 只保留风险说明与观察位，不作为一致体验验收条件。

### 3. 需要提供关闭开关

因为该能力是默认启用的实验特性，且跨客户端行为不稳定，所以实现上必须提供一个明确的开关，例如：

- `experimentalStatusSlashCommandEnabled`

默认值为开启，但用户可以显式关闭，以避免在不适合的环境中继续使用该 workaround。

## 为什么不选其他方案

### 方案 A：继续追求插件面板或面板注入

不推荐原因：

- 当前插件 API 没有面板注册能力。
- 当前插件 API 不能向宿主现有面板插入内容。
- 若强行实现，只能依赖未公开能力或修改 OpenCode core，均与本轮约束冲突。

### 方案 B：使用 model-visible tool 提供查询能力

不推荐原因：

- 用户已明确排除这条路。
- tool 会把“用户主动查状态”重新包装成模型工作流，不符合本轮目标。

### 方案 C：仅输出会话文本结果

不推荐原因：

- 公开能力下无法稳定保证“只显示、不触发 LLM 正常回答”。
- 文本展示更容易污染聊天记录与上下文语义。
- 用户已经确认更希望结果通过 notify/toast 呈现。

因此，当前最符合用户要求且可行的只剩“实验性命令触发 + toast 显示”。

## 交互模型

### 1. 入口

入口定义为用户主动触发的 slash command，例如：

- `/copilot-status`

该入口的职责只有一个：触发一次当前 active account 的状态刷新与通知反馈。

这里的关键边界是：slash command 只承担“主动触发”职责，不承担“承载复杂 UI”的职责。

### 2. 第一阶段通知：开始拉取

命令触发后，插件立即发出第一条非阻塞 toast，例如：

- `正在拉取 Copilot quota...`

作用：

- 让用户确认命令已生效
- 在网络请求开始前提供即时反馈
- 避免因 quota API 响应较慢而让用户误以为命令无效

### 3. 第二阶段通知：最终结果

请求完成后，插件发出第二条非阻塞 toast：

- 成功：展示当前账号、premium/chat/completions 的剩余或配额信息、更新时间
- 失败：展示错误摘要；若有历史成功快照，可附带“上次成功数据”作为补充

推荐的信息优先级：

1. 当前账号标识
2. premium/chat/completions 三类 quota 核心值
3. 更新时间或错误摘要

toast 文本应保持紧凑，目标是 1-3 行内传达结果，而不是展开成长报告。

## 数据流设计

### 1. 数据来源

本次设计只复用当前插件已有的数据与拉取链路：

- `store.active`
- 当前账号条目中的 token / 账号信息
- 现有 `fetchQuota(...)` 逻辑

不新增新的远端协议或额外状态服务。

### 2. 查询范围

手动命令始终只针对当前 active account。

原因：

- 多账号结果不适合 toast 展示
- 手动查询最常见的关注点就是“当前正在用的账号”
- 单账号查询可最大限度复用已有 store 与菜单语义

### 3. 成功路径

成功路径推荐顺序：

1. 读取 store，确定 active account
2. 若没有 active account，直接发错误 toast 并结束
3. 发出“正在拉取”通知
4. 调用 quota 拉取逻辑获取最新结果
5. 将最新 quota 写回对应账号条目
6. 必要时更新 `lastQuotaRefresh`
7. 发出结果通知
8. 通过实验性中断手段阻止默认命令继续进入普通 prompt/LLM 链

### 4. 失败路径

失败路径推荐顺序：

1. 发出“正在拉取”通知
2. quota 拉取失败
3. 不切换账号、不改 active 状态
4. 结果通知显示错误摘要
5. 若存在历史成功快照，则附带提示最近一次已知数据
6. 同样通过实验性中断手段结束默认命令链

失败不应破坏当前账号状态，也不应中断插件其他能力。

## 架构设计

### `config` hook：命令注入层

本次设计把 slash command 视为“实验性轻入口”，因此命令注入通过插件已有 `config` hook 完成。

职责：

- 向配置对象注入一个状态命令定义
- 注入对应的实验开关配置项或与现有 store 配置联动
- 在关闭该实验特性时，不注入该命令

这里的目标是让用户在正常对话实例中拥有一个主动入口，而不是构建复杂的命令系统。

### `command.execute.before`：实验性执行层

该层负责识别 `/copilot-status` 并执行真正的副作用逻辑。

职责：

- 识别实验命令
- 发送开始通知
- 刷新 quota
- 写回 store
- 发送结果通知
- 通过抛出受控的实验性中断错误终止默认命令链

这层必须在文档中明确标记为 workaround，而不是正式命令执行 API。

这里还需要额外约束：

- 该错误必须是可识别、可区分的实验性中断信号，而不是普通运行时失败
- 真实 quota 拉取失败、store 写回失败、toast 发送失败，不应与“有意中断默认命令链”的控制流混为一类
- 这样可以降低日志、调试与未来迁移时的歧义

### 通知层

通知层继续落在 `client.tui.showToast(...)` 或其已有封装之上。

职责：

- 统一构造“开始拉取”通知
- 统一构造“成功/失败结果”通知
- 对通知发送失败保持 fail open

这层的语义应明确为“notify/非阻塞通知体验”，而不是“模拟对话结果页”。

### Store 同步层

手动刷新成功后，最新 quota 必须写回 store。

这样可以带来三个直接收益：

- 当前菜单可复用更新后的数据
- 后续自动提醒可复用同一份快照
- 后续若迁移到稳定 `status line`、`session webview bridge` 或正式 command API，可直接复用现有 quota 数据供应链

## 错误处理与回退规则

### 无 active account

- 不发请求
- 直接发错误 toast，明确提示当前没有 active account

### quota 拉取失败

- 不破坏现有 active 状态
- 发错误 toast
- 若有历史成功快照，可附带最近一次成功信息

### toast 发送失败

- fail open
- 不阻断 quota 拉取主流程
- 只记录轻量 warning 或维持当前通知层既有处理方式

### workaround 失效

若未来上游实现改变，导致：

- `config` 注入的命令不再进入当前 hook 路径
- `throw` 不再能中断默认命令链
- 客户端错误反馈方式变化，导致 UX 明显恶化

则该实验特性应允许被快速关闭，而不是影响插件其他核心能力。

## 配置策略

本次设计要求新增一个明确的实验开关，建议形态如下：

- store 或配置中新增 `experimentalStatusSlashCommandEnabled`

语义要求：

- 默认值：`true`
- 可由用户显式关闭
- 关闭后不再注入该命令，也不再尝试使用该 workaround 链路

文档必须明确写出：这是默认开启的实验特性，不等于稳定承诺。
同时应明确说明：

- 该开关面向用户可见
- 用户文档中需要说明其默认开启、实验属性与关闭方式
- 关闭后 slash command 入口不再出现
- 关闭后即使手动输入 `/copilot-status`，也不会再进入 `command.execute.before` 的 workaround 执行链

## 测试策略

本次实现必须覆盖以下验证点：

1. `config` hook 在实验开关开启时会注入预期的状态命令定义。
2. 实验开关关闭时，不注入该命令。
3. 命中实验命令后，会先发送“正在拉取”通知。
4. quota 拉取成功时，会发送结果通知，并把最新快照写回 store。
5. quota 拉取失败时，会发送错误通知，且不破坏当前 active 状态。
6. 缺失 active account 时，会直接返回错误通知，不发起 quota 请求。
7. 缺失 `client.tui.showToast` 或通知发送失败时，主流程仍然 fail open。
8. 实验性中断逻辑不会影响普通 slash command、已有菜单 quota 展示、notify 工具、loop safety、retry 等其他能力。
9. 如测试环境可行，应至少记录当前 TUI 与 Web/App 行为差异，避免误把跨端一致性写成事实。
10. 验收口径以 TUI 为主支持面；Web/App 只记录观察结果，不作为一致 UX 的通过条件。

## 风险与约束

### 风险 1：这是基于异常中断的 workaround

该方案依赖抛错中断默认命令链，不是公开稳定契约。

缓解方式：

- 在 spec、代码与文档中明确标记为实验特性
- 提供独立开关
- 将副作用逻辑与数据逻辑解耦，方便未来替换执行层

### 风险 2：跨客户端行为不一致

当前无法可靠区分当前命令来自 TUI 还是 Web/App。

缓解方式：

- 明确该能力是 TUI-first 的实验特性
- 不承诺跨客户端一致体验
- 在文档中直接说明风险

### 风险 3：toast 信息密度有限

toast 不适合承载多账号、多段说明或复杂格式。

缓解方式：

- 强制只查 active account
- 只展示最关键 quota 信息
- 保持结果压缩

### 风险 4：未来上游稳定 API 落地后需要切换实现

这是预期内成本。

缓解方式：

- 在设计上把 quota 拉取、结果格式化、store 写回与命令执行方式解耦
- 在文档中提前声明迁移目标

## 未来切换计划

当上游正式提供以下任一稳定能力时，应优先替换当前 workaround：

- 正式的 plugin command handled/cancel API
- plugin status line
- session webview bridge
- sidebar panel / dialog API

其中最高优先级的迁移触发条件是：

- 上游提供稳定的 command handled/cancel/stop 语义，使插件不再需要依赖 throw-based workaround

切换时应尽量复用本次设计中的：

- active account 选择逻辑
- quota 拉取逻辑
- store 写回逻辑
- 结果格式化逻辑

也就是说，本次实验特性要把“执行方式”与“状态数据供应链”拆开，确保未来只需要替换入口与展示层。

## 预期结果

完成后应达到以下状态：

- 用户在正常对话实例中拥有一个默认启用的实验性 Copilot 状态入口。
- 该入口触发时会实时重新拉取当前 active account 的 quota。
- 用户会先看到“正在拉取”的通知，再看到结果通知。
- 查询结果不会依赖模型参与渲染。
- 成功快照会写回 store，为现有菜单与未来稳定展示面复用打下基础。
- 插件仍然不依赖任何不存在的面板注入能力。
- 文档会明确说明：该入口当前依赖 workaround，将在上游稳定 API 落地后切换实现。
