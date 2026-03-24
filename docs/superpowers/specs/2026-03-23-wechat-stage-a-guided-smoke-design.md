# 阶段 A：WeChat 全引导单脚本手测设计

## 背景

当前阶段 A 已经完成了这些基础能力：

- 真实 `@tencent-weixin/openclaw-weixin` 公开入口可在最小 compat host 下加载；
- slash-only guard 已固定；
- `self-test` 与 `real-account --dry-run` 已可运行；
- 脱敏规则、证据目录和 `go-no-go` 文档骨架已存在。

但阶段 A 仍然没有完成原始目标，因为真实账号手测还没有被收敛成一个可执行闭环：

- 还不能通过一条命令启动二维码登录；
- 还不能在同一条脚本里引导用户发送 slash 与非 slash 消息；
- 还不能自动采样、脱敏、编号并落档真实证据；
- 因此阶段 A 结论仍然只能是未完成或 `known-unknown`。

用户已经明确要求：

> 阶段 A 应该由一条全引导脚本完成完整手测流程，并自动记录后续阶段所需的所有关键信息。

本设计文档用于**细化并收紧**阶段 A 的真实账号手测路径：

- 它不改动阶段 A 的目标与边界；
- 但它会取代现有实现计划里“真实账号手测只由 `wechat:smoke:real-account` 驱动”的入口定义；
- 后续实现前，必须同步更新实现计划，使其与本设计一致。

## 目标

本设计只解决一个问题：

> 把阶段 A 的真实账号手测收敛成一条全引导脚本，让用户只需运行命令、扫码并按提示发消息，脚本自动完成采样、脱敏、证据写盘与结论更新。

脚本最终需要覆盖的阶段 A 真实流程：

1. 预检与 `self-test`
2. 二维码登录
3. slash 命令采样（`/status`、`/reply`、`/allow`）
4. 非 slash 拒绝与告警回发 `10/10`
5. 证据归档与 `go-no-go` 结论更新

## 非目标

本设计仍然保持阶段 A 的原始边界，不扩展到阶段 B/C/D：

1. 不实现 broker、bridge、token store、request store。
2. 不实现真正的 `/status` 聚合。
3. 不实现 `question` / permission 回复闭环。
4. 不引入正式事件通知系统。
5. 不把阶段 A 的 stub/no-op 命令路径带入后续正式实现。

## 方案对比

### 方案 1：公开插件驱动 + 全引导单脚本（选定）

做法：

- 复用当前 compat host；
- 通过公开插件 gateway 的 `loginWithQrStart` / `loginWithQrWait` 完成二维码登录；
- 登录后启动阶段 A 专用最小运行时，只做采样、guard 和证据记录；
- 用户只与一个命令交互。

优点：

- 最符合用户要求；
- 保持在公开插件表面；
- 手测证据天然可重现、可落档。

代价：

- 需要补一条最小二维码登录接线；
- 需要增加证据落盘和阶段状态机。

### 方案 2：外壳包装 OpenClaw CLI

做法：

- 由外部 OpenClaw 命令负责登录；
- 当前仓库脚本只采样和写文档。

缺点：

- 不是单脚本闭环；
- 依赖外部状态，证据一致性差；
- 不满足当前用户目标。

### 方案 3：半自动手测

做法：

- 脚本只打印步骤；
- 用户自行登录、发消息、整理证据。

缺点：

- 不能保证采样完整；
- 无法稳定复现 `10/10`；
- 不满足当前用户目标。

## 选定方案

采用方案 1：公开插件驱动 + 全引导单脚本。

建议命令入口：

```text
npm run wechat:smoke:guided
```

该命令应成为阶段 A 的唯一真实账号手测入口。

与现有命令的关系：

- `wechat:smoke:self-test`：保留，继续作为宿主与 guard 自检入口；
- `wechat:smoke:real-account -- --dry-run`：保留，继续作为手测前准备检查入口；
- `wechat:smoke:guided`：新增，串联并复用前两者，作为唯一真实账号手测闭环入口；
- guided 命令不会替代现有两个命令，而是在真实手测阶段把它们封装成一个统一流程。

换句话说：

- `self-test` 和 `real-account --dry-run` 仍然存在；
- 但真实账号手测的**主流程入口**从旧的 `wechat:smoke:real-account` 升级为 `wechat:smoke:guided`；
- 计划文档需要在后续同步这一点。

## 总体结构

全引导脚本按固定 5 个阶段顺序执行：

### 1. 预检阶段

脚本启动后立即完成这些检查：

- compat host 可加载真实公开入口；
- 输出目录与 run id 创建成功；
- `self-test` 可运行；
- 当前脚本工作目录、Node 版本、依赖版本可记录。

预检成功后，脚本应生成本次运行的 run id，例如：

```text
2026-03-23T18-30-12
```

并创建证据目录：

```text
docs/superpowers/wechat-stage-a/evidence/<run-id>/
```

### 2. 二维码登录阶段

脚本通过 `registerChannel` 拿到真实 `weixinPlugin` 后，只允许使用其公开 gateway 登录能力：

- `loginWithQrStart`
- `loginWithQrWait`

行为要求：

- 优先在终端打印二维码；
- 若终端二维码不可用，则回退打印二维码 URL；
- 登录成功后立即写入证据文件；
- 登录失败、超时或取消时立即写入证据并更新 `go-no-go.md`。

### 3. slash 命令采样阶段

登录成功后，脚本进入引导模式，依次提示用户发送：

- `/status`
- `/reply <text>`
- `/allow <text>`

脚本需要：

- 启动阶段 A 专用最小运行时；
- 采样真实入站结构；
- 验证 slash-only guard 与 stub/no-op 路径仍然成立；
- 明确禁止进入真实 AI reply。

### 4. 非 slash 验证阶段

脚本提示用户发送普通文本，并执行连续验证：

- 非 slash 输入必须被 fail-fast 拒绝；
- 微信侧必须收到固定告警文案；
- 每次成功都要记录响应；
- 连续计数直到 `10/10` 或任一次失败。

任一次失败都必须：

- 立即停止继续计数；
- 写出失败证据；
- 把 `go-no-go.md` 更新为 `no-go` 或 `known-unknown`，而不是继续硬推。

### 5. 归档总结阶段

脚本在每个阶段完成后都要即时落盘，并在结束时统一更新：

- `docs/superpowers/wechat-stage-a/api-samples-sanitized.md`
- `docs/superpowers/wechat-stage-a/go-no-go.md`
- `docs/superpowers/wechat-stage-a/evidence/<run-id>/...`

最终结论只能是：

- `go`
- `no-go`
- `known-unknown`

在真实手测没有完成前，脚本绝不允许把结论写成 `go`。

这里必须明确区分两个层次：

- **运行状态**：`dry-run` / `ready` / `running` / `blocked` / `completed`
- **最终结论**：`go` / `no-go` / `known-unknown`

运行状态描述脚本当前执行进度；最终结论只用于阶段 A 验收判断，二者不能混用。

## 宿主与运行时边界

### 公开插件接入边界

脚本必须继续遵守阶段 A 的公开入口约束：

- 真实插件仍由 `openclaw-host.ts` 加载；
- 公开入口仍来自 `package.json -> openclaw.extensions[0]`；
- 不允许直接把私有 `src/channel.ts` 作为加载入口；
- 不允许本地伪插件冒充成功路径。

### 最小阶段 A 运行时

登录成功后，脚本启动一个阶段 A 专用最小运行时，仅允许三类行为：

1. 记录真实入站结构
2. 记录真实出站结构
3. 执行 slash-only guard

这个运行时明确不负责：

- 自由聊天；
- 业务语义执行；
- `question` / permission 回复闭环；
- broker 生命周期。

## 证据与文档设计

### 证据目录

每次 guided run 都独立写到：

```text
docs/superpowers/wechat-stage-a/evidence/<run-id>/
```

文件按阶段编号：

- `001-preflight.md`
- `002-qr-start.md`
- `003-login-success.md`
- `004-status-command.json`
- `005-reply-command.json`
- `006-allow-command.json`
- `007-nonslash-warning-01.json`

需要更多文件时继续递增。

### 脱敏要求

任何内容写盘前都必须先过脱敏器。

当前至少要覆盖：

- `context_token`
- `bot_token`
- `Authorization`
- `userId`
- `botId`
- `qrCode`
- `deviceId`
- `messageId`
- `requestId`

后续如果真实响应中出现新的敏感字段，脚本应优先扩展脱敏规则，再允许证据写盘。

### 文档更新策略

`go-no-go.md` 只保存：

- run id
- 运行状态
- 阶段状态
- 证据引用
- 最终结论

不直接堆完整原始响应。

字段口径统一为：

- **逐项检查结果**：`pass` / `fail` / `known-unknown`
- **最终阶段结论**：`go` / `no-go` / `known-unknown`

也就是说：

- 文档中的每一项核对可以写 `pass/fail/known-unknown`；
- 最终决策字段只写 `go/no-go/known-unknown`。

`api-samples-sanitized.md` 保存：

- 脱敏后的样本
- 稳定字段 / 可变字段 / 脱敏方式说明
- 当前样本状态（真实、blocked、known-unknown）

`docs/superpowers/wechat-stage-a/compat-host-contract.md` 继续是阶段 A 的固定交付物与阶段 B 输入之一；如果 guided smoke 对最小宿主的必需字段、运行时依赖或约束有新增发现，必须同步更新该契约文档。

### slash 采样完成标准

`/status`、`/reply`、`/allow` 三条命令必须分别满足以下最小通过条件，才算“采样完成”：

1. 原始命令文本已记录；
2. 真实入站结构已采样并脱敏写盘；
3. guard 已把消息导向 slash stub/no-op 路径；
4. 证据文件中至少包含：时间、输入、关键字段、路由结果、证据编号；
5. `api-samples-sanitized.md` 已补上该命令样本或对应引用。

最小关键字段要求：

- 命令文本
- 用户标识字段
- 消息时间或序号字段
- 路由结果（stub/no-op）

任一命令未满足上述条件，都不算阶段 A 的 slash 采样完成。

## 失败处理

脚本必须把失败当成正式输出，而不是“控制台提醒”。

### 失败分类

1. 二维码启动失败
   - 立即写 `002-qr-start.md`
   - 运行状态标记为 `blocked`
   - 最终结论写为 `known-unknown`

2. 扫码等待超时
   - 写登录阶段证据
   - 运行状态标记为 `blocked`
   - 最终结论写为 `known-unknown`

   默认超时值采用 `480_000ms`，与当前插件登录等待窗口保持一致；若实现允许覆盖，覆盖值也必须写入证据。

3. slash 采样未完成
   - 写当前阶段证据
   - 停止进入后续 `10/10`
   - 运行状态标记为 `blocked`
   - 最终结论写为 `known-unknown`

   slash 采样完成的程序化判定来源必须是：

   - 捕获到对应命令的真实入站结构；
   - guard 已作出 stub/no-op 路由判定；
   - 证据文件已写盘。

   不允许只靠人工“我发过了”口头确认。

4. 非 slash 验证任一次失败
   - 立即停止计数
   - 运行状态标记为 `completed`
   - 最终结论写为 `no-go`

   非 slash `10/10` 的程序化成功判定来源必须同时满足：

   - 捕获到本次普通文本的真实入站结构；
   - 捕获到固定中文告警文案的真实回发成功响应；
   - 该次响应已脱敏写盘。

5. 脚本异常退出
   - 全局捕获异常
   - 先写最后一个证据文件
   - 再更新运行状态与最终结论（默认 `known-unknown`，除非已满足 `no-go` 条件）

## 验证策略

### 自动化验证

自动化测试只负责证明这些东西：

- 脚本状态机正确
- 证据落盘正确
- 脱敏逻辑正确
- 文档更新正确
- ready / blocked / dry-run / known-unknown 状态转换正确
- 运行状态与最终结论的映射正确

### 真实阶段 A 完成判定

脚本只有在同时满足以下条件时，才能把阶段 A 结论写成 `go`：

1. `self-test 3/3`
2. 真实二维码登录成功
3. `/status`、`/reply`、`/allow` 真实采样落档
4. 非 slash 告警回发 `10/10`
5. 阶段 B 关键字段清单完整，无关键字段缺失
6. `go-no-go.md` 最终为 `go`

阶段 B 关键字段完整性至少包括：

- 登录后认证相关字段
- `getupdates` 中的 `msgs`、`get_updates_buf`、`context_token`
- 命令消息入站中的用户标识与消息内容结构
- 告警回发成功与失败时的响应形态

否则只能写：

- `known-unknown`
- `no-go`

## 预期文件改动

实现本设计时，预计会涉及：

- `src/wechat/compat/openclaw-smoke.ts`
- `src/wechat/compat/openclaw-guided-smoke.ts`（如拆分独立 orchestrator）
- `src/wechat/compat/slash-guard.ts`
- `test/wechat-openclaw-smoke.test.js`
- `test/wechat-openclaw-task3.test.js`
- 新增 guided smoke 测试文件（如有必要）
- `package.json`
- `docs/superpowers/wechat-stage-a/api-samples-sanitized.md`
- `docs/superpowers/wechat-stage-a/go-no-go.md`
- `docs/superpowers/wechat-stage-a/evidence/README.md`
- `docs/superpowers/wechat-stage-a/compat-host-contract.md`

## 结论

阶段 A 现在缺的不是更多 dry-run，而是一条真正能带用户走完二维码登录、命令采样、非 slash 验证和证据归档的 guided smoke 命令。

本设计把阶段 A 收敛成一个公开插件驱动的单脚本闭环，目标只有一个：

> 用一条命令跑完整个真实账号手测流程，并自动留下后续阶段真正需要的证据。
