# 基于 JITI 路线的 WeChat `/status` 真实入口设计

## 背景

当前 worktree 里，阶段 C 已经完成了 `/status` 的**内部能力链**：

- broker 能广播 `collectStatus()`；
- bridge 能基于 `input.client` 做 live snapshot；
- `session-digest.ts` 能基于真实 SDK 结构生成并行 `highlights`；
- broker 能格式化多实例 `/status` 回复；
- `plugin-hooks.ts` 也已经完成本地 bridge 生命周期接线。

但这条链还缺最后一个现实入口：

> 用户在微信里真实发送 `/status` 时，消息还没有进入这条 broker `collectStatus()` 链路。

这次设计不再修改阶段 C 已通过的 spec，而是单独新增一份 spec，描述如何基于**当前最终手测脚本已经验证的 JITI 路线**把真实微信 `/status` 接进来。

## 关键事实

这份设计建立在已确认的当前事实之上：

1. 当前 worktree 中旧的 compat 编译路径已经被移除，不再作为新的运行时设计基础。
2. 最终手测脚本 `wechat:smoke:guided` 的真实账号路径，本质上依赖的是：
   - JITI 加载 `@tencent-weixin/openclaw-weixin/src/auth/login-qr.ts`
   - JITI 加载 `@tencent-weixin/openclaw-weixin/src/api/api.ts` 的 `getUpdates()`
   - JITI 加载 `@tencent-weixin/openclaw-weixin/src/messaging/send.ts` 的 `sendMessageWeixin()`
   - JITI 加载 state-dir / sync-buf 相关 helper
3. 也就是说，**guided smoke 已经证明 JITI + public helper 这条路径足以覆盖 QR 登录、最新账号状态读取、getUpdates 长轮询、以及 sendMessage 回复**。
4. 当前最需要补的，不是 transport 本身，而是：
   - 把真实微信入站文本 `/status` 解析出来；
   - 路由到现有 broker `collectStatus()`；
   - 再通过 `sendMessageWeixin()` 把结果发回同一会话。

## 目标

这份新 spec 只解决一个问题：

> 用 JITI + public helper 路线，把真实微信 `/status` 入站接到现有 broker `collectStatus()`，形成真实可用的微信状态入口。

本阶段必须真正落成的能力：

1. broker 侧能够启动一个最小微信运行时，持续轮询 `getUpdates()`。
2. broker 能从真实入站消息里识别 `/status`。
3. `/status` 会调用现有 broker `collectStatus()` 聚合。
4. 聚合结果通过 `sendMessageWeixin()` 回复到当前微信会话。
5. 非 slash 输入继续保持阶段 A 的固定提示，不进入 AI reply。
6. 菜单中新增一个专门的“微信通知”子菜单，至少提供：
   - 绑定 / 重绑微信入口
   - 通知总开关
   - `question` 通知开关
   - `permission` 通知开关
   - `session error` 通知开关

## 非目标

本 spec 明确不做这些事情：

1. 不接 `/reply`。
2. 不接 `/allow`。
3. 不做微信自由聊天驱动 OpenCode。
4. 不做通知、token stale fallback。
5. 不引入新的 compat 编译链或 private entry 入口路线。
6. 不在本阶段把所有未来通知类型都一次性塞进菜单；只落最小子菜单面。

## 方案对比

### 方案 1：回到 compat 编译 runtime 路线

做法：

- 重新引入 compat 编译宿主；
- 在编译产物或兼容宿主上继续扩真实 slash 处理。

问题：

- 与当前 worktree 已经收口的事实不一致；
- 容易误导后续开发者继续依赖已废弃路径；
- 不是当前最终 guided smoke 真正依赖的手测链路。

### 方案 2：沿用 JITI + public helper 路线（选定）

做法：

- 把 guided smoke 已验证的 JITI helper 抽成共享运行时能力；
- broker 侧最小运行时只做 QR 登录、状态恢复、长轮询、slash 识别、以及 `/status` 回复；
- 不接任何 AI reply 路由。

优势：

- 与当前真实手测脚本保持一致；
- 不重新引入 compat 概念；
- 能最小化范围，只补真实微信入口。

### 方案 3：完整接回 OpenClaw runtime 面

做法：

- 实现更大面积的 OpenClaw channelRuntime / routing / session / reply 能力；
- 让 `/status` 和未来 `/reply` / `/allow` 都走完整 OpenClaw 运行时。

问题：

- 范围明显超出本次目标；
- 会把问题从“接真实 `/status` 入口”扩成“重建宿主能力”。

## 选定方案

采用方案 2：沿用 JITI + public helper 路线。

## 总体结构

新的真实入口固定拆成 5 个部分：

1. **JITI public helper 层**
   - 负责加载 QR 登录、state dir、getUpdates、sendMessageWeixin 等 helper。
2. **微信轮询运行时层**
   - 负责恢复账号状态、维护 `get_updates_buf`、轮询新消息、过滤 slash 文本。
3. **broker slash 路由层**
   - 负责解析 `/status`，调用现有 `collectStatus()`，得到 reply 文本。
4. **微信回复层**
   - 把格式化好的 `/status` 回复发回当前微信会话。
5. **微信通知菜单层**
   - 为后续绑定与通知相关配置提供稳定的用户入口。

其中核心原则是：

- transport / polling 继续用 JITI public helper；
- 状态聚合继续复用阶段 C 已完成的 broker / bridge / digest / formatter；
- 非 slash 输入依旧停留在固定提示，不进入 AI reply。

## 建议文件职责

### `src/wechat/compat/openclaw-public-helpers.ts`

- 作为 JITI 路线的共享 helper 装载层；
- 统一提供：
  - public entry 基本信息读取
  - QR 登录 helper
  - account state / state dir helper
  - `getUpdates()`
  - `sendMessageWeixin()`

### `src/wechat/wechat-status-runtime.ts`

- 新建 broker 侧真实微信运行时；
- 负责：
  - 恢复最新账号状态；
  - 轮询 `getUpdates()`；
  - 维护 `get_updates_buf`；
  - 识别入站 slash；
  - 调 broker slash handler；
  - 发回回复。

### `src/wechat/command-parser.ts`

- 不再只是测试辅助；
- 成为真实 slash 路由的纯解析层；
- 本阶段依然只识别 `/status`。

### `src/wechat/broker-server.ts`

- 继续保留 `collectStatus()`；
- 新增一个最小的 slash 处理入口，例如：
  - `handleWechatSlashCommand()`
  - 或 `handleWechatStatusCommand()`
- 该入口只负责：
  - 校验 slash 类型；
  - 调现有 `collectStatus()`；
  - 返回 reply 文本。

### `src/wechat/broker-entry.ts`

- 在 broker 生命周期里启动 `wechat-status-runtime`；
- 负责把 broker slash handler 注入运行时；
- 在进程退出时关闭轮询与相关资源。

### `src/ui/menu.ts`

- 新增“微信通知”子菜单入口；
- 子菜单至少提供绑定入口、总开关、`question` 通知、`permission` 通知、`session error` 通知五项。

### `src/common-settings-store.ts`

- 新增微信通知相关配置项的持久化字段与默认值归一化；
- 不把这些开关混进现有 slash / retry / loop-safety 语义。

### `src/common-settings-actions.ts`

- 为微信通知子菜单提供最小 toggle action；
- action 必须和已有通用设置动作保持一致的持久化模式。

### `src/providers/*menu-adapter.ts` / `src/menu-runtime.ts`

- 将微信通知子菜单接入现有 provider menu 流程；
- 绑定入口与开关写回由这里编排。

## 真实 `/status` 流程

1. broker 启动时恢复最新微信账号状态与 `get_updates_buf`。
2. `wechat-status-runtime` 周期性调用 `getUpdates()`。
3. 收到真实入站消息后：
   - 提取 text；
   - 只关注 slash；
   - 用 `parseWechatSlashCommand()` 识别 `/status`。
4. 如果是 `/status`：
   - 记录 / 刷新当前入站上下文；
   - 调 broker 已有的 `collectStatus()`；
   - 拿到 reply 文本；
   - 用 `sendMessageWeixin()` 回复到当前会话。
5. 如果不是 slash：
   - 发送阶段 A 固定提示；
   - 不进入 AI reply。

## 菜单与设置面

本 spec 新增一个最小的“微信通知”子菜单，不要求本阶段把完整通知系统全部打通，但要求先把用户可见入口和配置面固定下来。

### 子菜单位置

- 放在现有 provider menu 流程中；
- 以独立“微信通知”入口出现，而不是散落到现有通用设置项中。

### 最小子菜单项

1. **绑定 / 重绑微信**
   - 触发微信绑定入口；
   - 语义上等价于“重新激活或重建当前微信绑定”。
2. **通知总开关**
   - 控制所有微信通知是否整体启用。
3. **`question` 通知开关**
   - 控制等待用户回答的问题是否允许推送到微信。
4. **`permission` 通知开关**
   - 控制等待授权的 permission 是否允许推送到微信。
5. **`session error` 通知开关**
   - 控制 session error 是否允许推送到微信。

### 设置面原则

- 这些开关必须写入稳定配置；
- 本阶段先锁定菜单面和设置项，不要求所有未来通知类型都马上生效；
- 但字段名、默认值和交互位置必须先定下来，避免后续反复改用户可见面。

## 状态与持久化

真实入口运行时需要复用并维护这些状态：

1. **账号状态**
   - 从当前已保存的最新账号状态恢复 `accountId`、`token`、`baseUrl`。
2. **同步游标**
   - 读取并更新 `get_updates_buf`。
3. **operator / token 语义**
   - `/status` 的真实入站应继续落到现有 `operator-store` / `token-store` 语义上，而不是新造一套状态文件。
4. **broker 现有状态链**
   - `collectStatus()` 及其返回值不重写，直接复用。

## 失败语义

### 登录 / 状态恢复失败

- 真实微信运行时启动失败时，只影响真实微信入口；
- 不应拖垮 broker 已有 IPC 与本地状态链。

### `getUpdates()` 失败

- 记录运行时错误；
- 按既有 guided smoke 经验采用可恢复重试；
- 不直接清空 `get_updates_buf`。

### slash 处理失败

- `/status` 调 broker handler 失败时，返回固定错误提示；
- 错误文案必须比内部异常更稳定，不把内部堆栈原样回给微信。

### 非 slash 输入

- 保持固定提示；
- 不进入 AI reply。

## 测试策略

至少需要以下测试层次：

### 1. Public helper 测试

- JITI helper 能加载 QR 登录方法；
- 能加载 `getUpdates()` / `sendMessageWeixin()`；
- 能恢复最新账号状态与 `get_updates_buf`。

### 2. 真实入口运行时测试

- 给定模拟的 `getUpdates()` 返回 `/status` 消息，运行时会调用 broker slash handler；
- slash handler 的 reply 文本会通过 `sendMessageWeixin()` 发出；
- 非 slash 输入只发固定提示；
- `get_updates_buf` 会按轮询结果推进。

### 3. broker 路由测试

- `parseWechatSlashCommand()` 的真实运行时接入；
- `/status` 走现有 `collectStatus()`；
- reply 文本来自现有 formatter，而不是 runtime 自己重拼。

### 4. 回归测试

- `wechat-openclaw-smoke.test.js`
- `wechat-openclaw-guided-smoke.test.js`
- `wechat-openclaw-task3.test.js`
- 以及现有阶段 B / C 内核测试集合

### 5. 菜单 / 设置测试

至少覆盖：

- provider menu 中可进入“微信通知”子菜单；
- 5 个最小子菜单项存在且顺序稳定；
- toggle 写回后重新读取配置保持一致；
- 绑定入口会触发明确 action，而不是静默 no-op。

## 完成判定

只有同时满足以下条件，这份新 spec 对应的工作才算完成：

1. compat 旧路径不再作为新的运行时方案基础。
2. JITI + public helper 路线能够覆盖完整 guided smoke 所需能力。
3. broker 侧能真实接收微信 `/status` 入站。
4. `/status` 真实入站会调用现有 `collectStatus()`。
5. reply 文本会通过 `sendMessageWeixin()` 真实发回微信。
6. 菜单中存在“微信通知”子菜单，并至少提供绑定入口、总开关、`question`、`permission`、`session error` 这 5 项。
6. 非 slash 输入继续固定提示，不进入 AI reply。
7. `/reply` / `/allow` 仍然保持未实现。
