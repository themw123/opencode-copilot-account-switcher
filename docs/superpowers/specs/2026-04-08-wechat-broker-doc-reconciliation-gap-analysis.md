# WeChat Broker 原始设计与当前实现差距分析

## 背景

2026-03-23 的 broker/bridge 原始设计与 phased implementation 已重新找回，并恢复为仓库主文档：

- `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`

原先仓库里的同名文件并不是原稿，而是在原文缺失期间基于当时实现反推写出的重建稿，现已改名归档：

- `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design-reconstructed.md`
- `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md`

本文件只做一件事：对照 2026-03-23 原始设计，说明当前仓库实现已经兑现了什么、沿着不同路径落地了什么、以及哪些原始目标仍未完整收口。

## 已实现且与原始设计一致

### 1. 单例 broker + 多实例 bridge 的总体方向

原始设计把用户级单例 broker 选为正式方案，要求 broker 独占微信 transport，bridge 留在每个 OpenCode 实例内负责本实例事件与 API 调用。当前仓库已经沿这条主线落地，而不是退回“每实例一个 sidecar”或“无 broker 纯实例内 leader 竞选”的路线。

### 2. `/status` 作为最先成立的微信主入口

原始设计把 `/status` 定义成微信侧最核心的聚合入口。当前实现也确实先把 `/status` 做成了真实链路：微信入站 slash 命令进入 broker，broker 向 bridge 收集摘要，再把聚合结果发回微信会话。

### 3. slash-only 交互约束

原始设计明确不支持“在微信里自由聊天驱动 OpenCode AI”，而是只接受 `/status`、`/reply`、`/allow` 这一类命令式交互。当前实现仍保持这个边界，没有把微信入口扩成通用聊天入口。

### 4. request / handle 驱动的回复闭环方向

原始设计要求 question / permission 通过 broker 生成 handle，再由微信侧用 `/reply <qid>`、`/allow <pid>` 之类命令完成回路。当前实现已经沿这个方向收口，不再把微信回复建立在“猜第一条 pending 请求”这种模糊语义上。

### 5. 单操作者与绑定状态模型

原始设计假定单操作者模型，用 `operator.json` / binding 状态固定当前微信操作者。当前实现同样沿着“单主绑定 + 本地持久化绑定信息”的方向落地，而不是做多用户广播或自动抢占。

## 已实现但路径改变

### 1. 原始总设计被拆成了多个阶段文档推进

原始文档是一份“大一统总体设计 + phased plan”。实际落地过程中，仓库后来把这条主线拆成了更细的阶段文档推进，例如：

- compat host / guided smoke
- broker foundation
- status slice
- JITI status ingress
- menu binding follow-up
- compat 2.0.1 migration
- real opencode host gate

也就是说，当前实现并没有完全按原始 phased plan 的任务边界推进，而是把风险拆成更小的阶段逐步收敛。

### 2. 当前实现额外补上了“真实 opencode 宿主 gate”

原始 2026-03-23 设计关注的是 broker/bridge/微信链路本身，并没有把“真实 opencode 宿主级回归闸门”作为核心文档内容。当前仓库后来增加了真实 `opencode` host gate，这属于超出原始设计范围、但为后续发布稳定性补上的新能力。

### 3. 菜单绑定与配置面成为了显式产品表面

原始设计重点更偏 broker、状态、slash 交互和 transport 承载。当前实现则进一步发展出了菜单入口、绑定 / 重绑、通知总开关与分项开关这些 UI/配置面。这些不是对原始设计的背离，但属于后续演化出的更完整用户表面。

### 4. 当前 compat / host 适配层比原始设计更具体

原始设计只强调“最小 compat host + slash-only”，但没有展开后续面对 `@tencent-weixin/openclaw-weixin` 版本漂移、JITI/TS 入口、2.0.1 迁移时的具体适配策略。当前实现已经把这些差异沉淀成了更明确的 compat 层，这部分属于后续实现中长出来的细化结构。

## 仍未实现 / 已被后续路线替代

### 1. 原始设计里的“完整恢复与 dead-letter 体系”仍未完全闭环

原始设计在恢复、TTL、expired、dead-letter、broker idle 退出语义上定义得比较完整。当前实现已经具备部分最小可靠性语义，但更完整的重放、人工恢复、系统化 dead-letter 编排、恢复轨迹与更结构化错误码，仍然没有完全达到原始设计的理想状态。

### 2. 原始 phased plan 中的一些任务边界已不再是实际执行路径

例如原计划把 `Task 1 / 1.5 / 2 / 3 / 4 / 5 / 6` 作为主要推进骨架，但真实落地过程后来被更细的阶段文档和多次架构收敛替代。它们仍然是重要历史设计，但已不是当前仓库最准确的“实际落地顺序”。

### 3. 原始设计中的部分 PoC 术语已被后续实现语义取代

原稿经常用“PoC”语气描述范围收缩。当前仓库已经不只是一个早期 PoC：真实微信链路、真实宿主 gate、真实绑定流程、实际 release 都已经发生。因此原稿中的一些“PoC 临时边界”现在更适合被当作历史约束，而不是当前系统的完整状态描述。

## 结论

当前仓库与 2026-03-23 原始设计的关系可以概括为：

1. 架构主线没有跑偏：单例 broker、bridge、slash-only、`/status`、handle 驱动回复这些关键方向基本保持一致。
2. 真实落地路径比原始 phased plan 更碎片化，也更工程化；很多风险是通过后续阶段文档逐步收敛，而不是一次性按原计划整包完成。
3. 当前系统已经比原始 PoC 设想更完整，但在恢复、dead-letter、人工恢复、观测等可靠性层面，仍然存在原始设计里提出但尚未完全闭环的部分。

因此，后续阅读顺序建议是：

1. 先读原始主文档，理解 2026-03-23 当时的设计意图；
2. 再读重建稿，理解原文缺失期间团队如何基于现状重新描述系统；
3. 最后读本差距分析，判断当前实现相对原始设计到底已经走到了哪一步。
