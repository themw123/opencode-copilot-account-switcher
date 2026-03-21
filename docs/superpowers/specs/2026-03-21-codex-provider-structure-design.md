# OpenAI Codex Provider 扩展结构设计

## 背景

当前仓库本质上是一个“Copilot 增强插件”，而不是通用多-provider 框架。

现状特点：

- 认证、provider id、API 域名、quota/status、chat header 语义都强绑定 GitHub Copilot；
- routing state、部分菜单/交互组件、session 控制工具等能力已经具备一定复用价值；
- `copilot-network-retry` 这类大模块同时混合了“共享重试骨架”和“Copilot 专属错误识别/修补策略”。

用户计划未来把能力扩展到 OpenAI Codex provider，但当前阶段并不直接落地 Codex 功能；当前更重要的是先把结构收敛好，尤其是把 retry 从 Copilot 专属大模块拆成“共享骨架 + 少量 provider 特例”。

同时，用户明确给出三条重要约束：

- Codex 不需要请求头改写；
- Codex 不需要沿用 Copilot 的 `x-initiator` / header rewrite / routing 语义；
- Codex 各账号可访问模型相同，未来大概率也不需要按模型路由到不同账号。

## 目标

1. 在不重构整个插件为“通用 provider 平台”的前提下，为未来 Codex 扩展预留稳定接口。
2. 把真正值得共享的部分控制在“provider 描述层”和“重试引擎骨架”。
3. 当前阶段先把 Copilot-specific retry 从大文件中拆开：共享大部分错误处理逻辑，只保留少数 provider-specific classifier / repair policy。

## 非目标

1. 不在当前阶段落地 `/codex-status` 的实际功能。
2. 不在当前阶段把 Copilot 与 Codex 的全部命令体系统一抽象。
3. 不把 Codex 接到 `modelAccountAssignments`、`x-initiator`、header rewrite 这条 Copilot 专属路径。
4. 不提前实现 Codex 的按模型路由、多账号模型分配等能力。

## 推荐方案

采用“**薄 provider 描述层 + 共享 retry 引擎骨架 + provider-specific 策略插件**”的方案。

## 核心结构

### 1. 薄 provider 描述层

只抽一层很薄的 provider descriptor，负责：

- provider id / provider key
- 菜单入口注册
- slash command 注册
- store 命名空间
- 功能能力开关（例如是否支持 status、是否支持 retry）

这一层只解决“入口与装配”，不承载 provider 业务逻辑。

### 2. provider-specific 功能接口先预留，不在当前阶段落地 Codex 功能

当前阶段只需要把 provider-specific 功能的接口边界留出来，例如未来可以承载：

- `providers/copilot/status.ts`
- `providers/codex/status.ts`

但这次 spec 不要求马上实现 `codex-status`，只要求别把当前结构继续锁死在“只能长出 Copilot 功能”的形态里。

### 3. 共享 retry 引擎骨架

网络重试模块是应该共享的，而且共享比例应以“大部分通用、少部分 provider-specific”为目标；共享的是“引擎骨架 + 大部分错误处理逻辑”，不是把整个当前 Copilot 文件原封不动复用。

推荐拆成：

1. shared retry engine
   - 重试调度
   - fail-open 行为
   - notifier 接口
   - session patch/cleanup 调用边界
   - 大部分通用错误归一化与重试判定
2. provider-specific classifier / repair policy
   - Copilot：保留现有特有错误识别与修补策略
   - Codex：未来新增自己的错误分类与修补逻辑

这样可以避免把 Codex 生硬塞进 Copilot 的 API/错误假设里。

## 分阶段落地顺序

### 第一阶段：先做 provider 接口与 Copilot retry 解耦

第一阶段只做：

- provider descriptor / registry 的最小接口
- shared retry engine 骨架
- 现有 Copilot retry 迁到“共享骨架 + Copilot-specific policy”结构上

这一阶段不直接落地 Codex 功能，但要为它留出挂载位。

### 第二阶段：先验证 Copilot 在新结构上不回退

- 用 Copilot 现有测试确认新 retry 结构只是边界调整，不是行为回归
- 如有必要，再顺手把 Copilot 的 status/command 装配迁到 descriptor 驱动路径

### 第三阶段：再接 Codex 功能

- 再实现 `/codex-status`
- 再接 Codex-specific retry 差异

## 模块边界建议

### 建议抽象为共享层

- provider descriptor / registry（内部可承载菜单、命令、store 命名空间等入口装配信息）
- retry engine 骨架（内部可承载 notifier / fail-open 等通用能力）

### 明确保持 provider-specific

- status 查询接口与字段映射
- quota / usage 展示语义
- header 改写语义
- routing / account-group 策略
- provider API helper

## 测试策略

### 第一阶段（Copilot retry 解耦）

需要把测试至少分出两层：

1. shared retry engine contract
2. Copilot-specific retry policy
3. provider 装配层测试（descriptor 注册、能力开关、装配不回退）

### 第二阶段（retry）

Codex 接入时，再新增：

1. Codex-specific retry policy
2. Codex status 测试

## 风险与缓解

### 风险 1：过早抽象成“大而全 provider 框架”

缓解：

- 第一阶段只抽 provider descriptor
- 不提前统一所有 `/copilot-*` / `/codex-*` 命令

### 风险 2：把 Codex 错误地接到 Copilot 路由语义

缓解：

- 明确禁止 Codex 第一阶段接入 `modelAccountAssignments`
- 明确禁止 Codex 复用 `x-initiator` / header rewrite 链路

### 风险 3：retry 共享时把 Copilot 特例误做成通用逻辑

缓解：

- 只共享引擎骨架
- classifier / repair policy 必须 provider-specific

## 预期结果

完成后应达到：

1. 插件结构开始具备“按 provider 增加功能模块”的能力。
2. 当前阶段先把 Copilot retry 从大一统文件中拆成“共享骨架 + 少量特例”。
3. 后续落地 `/codex-status` 和 Codex retry 时，不需要再次重构入口层与 retry 主骨架。
