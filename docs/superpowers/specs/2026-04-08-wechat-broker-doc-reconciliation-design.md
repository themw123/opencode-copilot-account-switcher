# WeChat Broker 文档归档对齐设计

## 背景

当前仓库中已经存在两份 `2026-03-23` 的 WeChat broker 文档：

- `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`

但用户又找回了同日期的外部原始文件：

- `C:\Users\34404\2026-03-23-wechat-broker-bridge-design.md`
- `C:\Users\34404\2026-03-23-wechat-broker-bridge-phased-implementation.md`

比对后确认，这不是同文小漂移，而是两套不同定位的文档：

1. 外部文件是 2026-03-23 当时的原始 broker/bridge 总体设计与 phased implementation。
2. 仓库现有同名文件是后续在“原文丢失”背景下，基于当时已落地实现重建出的替代版本。

因此这次工作的目标不是简单覆盖文本，而是重新建立清晰、可追溯的文档主从关系。

## 目标

1. 让 2026-03-23 的主文档重新回到原始设计语义。
2. 保留仓库中后写出的“重建版”文档，避免丢失后续整理时形成的上下文。
3. 额外产出一份“原始设计 vs 当前实现”的差距说明，帮助后续判断哪些路线已兑现、偏离或废弃。

## 非目标

1. 不修改原始找回文档的设计结论和历史措辞。
2. 不把差距分析直接揉进原始设计正文。
3. 不在这一步顺手改动实现代码或功能行为。

## 方案

### 1. 主文档恢复原则

以下两份仓库文件恢复为“原始主文档”：

- `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`

它们的内容直接采用用户找回的外部文件版本，以恢复 2026-03-23 当时的真实设计语义。

### 2. 重建版归档原则

当前仓库里的“事后重建版”不删除，改名归档保存。例如：

- `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design-reconstructed.md`
- `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md`

归档版文件头应补一段简短说明，明确：

- 这是原文缺失期间基于实现反推写出的重建稿；
- 不是 2026-03-23 的原始文档；
- 原始主文档现已恢复到同目录主路径。

### 3. 差距分析产物

新增一份独立说明文档，放在 `docs/superpowers/specs/` 下，使用当前日期命名，例如：

- `docs/superpowers/specs/2026-04-08-wechat-broker-doc-reconciliation-gap-analysis.md`

这份文档不改写原始设计，而是回答：

1. 当前实现哪些部分与原始设计一致。
2. 当前实现哪些部分已经落地，但路径和原始设计不同。
3. 原始设计中的哪些部分尚未实现，或已被后续方案替代/废弃。

建议固定三类结构：

- 已实现且一致
- 已实现但路径改变
- 未实现 / 已废弃

## 文件改动设计

本次整理完成后，仓库文档关系应为：

1. `2026-03-23-wechat-broker-bridge-design.md`
   - 原始主设计
2. `2026-03-23-wechat-broker-bridge-phased-implementation.md`
   - 原始主计划
3. `2026-03-23-wechat-broker-bridge-design-reconstructed.md`
   - 后写重建稿归档
4. `2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md`
   - 后写重建计划归档
5. `2026-04-08-wechat-broker-doc-reconciliation-gap-analysis.md`
   - 原始设计与当前实现的差距说明

## 风险与处理

### 风险 1：现有阶段文档引用的是重建版语义

处理：

- 不删除重建版，而是保留为明确命名的归档文件。
- 差距分析文档中补充“后续阶段文档更多沿哪条线推进”的说明。

### 风险 2：用户以后误把两份文档当成同一时间写成的两个版本

处理：

- 在重建版文件头明确标识“重建稿”身份。
- 在差距分析文档首段写明主从关系和形成时间背景。

## 验证

整理完成后至少要检查：

1. 主路径文件内容已切回外部原始版本。
2. 重建版已成功另存为归档文件，且文件头说明完整。
3. 差距分析文档已写出三类结论，不留占位符。
4. 仓库内对 `2026-03-23` broker 文档的后续引用仍可追溯到原始版、重建版和差距分析三者关系。
