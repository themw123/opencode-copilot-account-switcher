# WeChat Broker 文档归档对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2026-03-23 的 broker/bridge 原始设计与 phased plan 恢复为仓库主文档，归档当前重建版，并补一份“原始设计 vs 当前实现”的差距分析说明。

**Architecture:** 文档整理分三步走：先保护当前重建版并改名归档，再用外部找回版本恢复主路径文档，最后新增一份独立差距分析文档解释“已实现 / 路径变化 / 未实现或废弃”。整个过程不改实现代码，只整理文档主从关系和说明口径。

**Tech Stack:** Markdown, existing `docs/superpowers/specs`, existing `docs/superpowers/plans`, local filesystem via apply_patch

---

## 文件结构与职责

- `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
  - 恢复为 2026-03-23 原始主设计
- `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`
  - 恢复为 2026-03-23 原始主计划
- `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design-reconstructed.md`
  - 归档当前仓库里的重建设计版本，并在文件头补身份说明
- `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md`
  - 归档当前仓库里的重建计划版本，并在文件头补身份说明
- `docs/superpowers/specs/2026-04-08-wechat-broker-doc-reconciliation-gap-analysis.md`
  - 新增差距分析文档，说明原始设计与当前实现的兑现、偏离与缺口

### Task 1: 归档当前重建版文档

**Files:**
- Create: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design-reconstructed.md`
- Create: `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md`
- Read from: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- Read from: `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`

- [ ] **Step 1: 复制当前仓库里的重建版到归档文件名**

把当前两份仓库文件完整复制到新路径：

```text
docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design-reconstructed.md
docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md
```

- [ ] **Step 2: 在两个归档文件头部补身份说明**

两个归档文件顶部都增加如下说明块：

```md
> 说明：本文件是原始 2026-03-23 文档缺失期间，基于当时现有实现反推写出的重建稿。
> 它不是 2026-03-23 的原始版本；原始主文档现已恢复到同目录主路径。
```

- [ ] **Step 3: 检查归档文件内容仍完整保留重建版正文**

核对要点：

- 标题、正文、章节顺序未丢失
- 只新增文件头说明，不额外改写正文结论

### Task 2: 用找回原稿恢复主路径文档

**Files:**
- Modify: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- Modify: `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`
- Source: `C:/Users/34404/2026-03-23-wechat-broker-bridge-design.md`
- Source: `C:/Users/34404/2026-03-23-wechat-broker-bridge-phased-implementation.md`

- [ ] **Step 1: 用外部原始设计覆盖主路径 spec 文件**

目标内容源：

```text
C:/Users/34404/2026-03-23-wechat-broker-bridge-design.md
```

覆盖目标：

```text
docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md
```

- [ ] **Step 2: 用外部原始计划覆盖主路径 plan 文件**

目标内容源：

```text
C:/Users/34404/2026-03-23-wechat-broker-bridge-phased-implementation.md
```

覆盖目标：

```text
docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md
```

- [ ] **Step 3: 复核主路径标题与正文已回到原始语义**

核对要点：

- spec 标题应回到 `基于单例 Broker 的 OpenCode-WeChat Bridge PoC 设计`
- plan 标题应回到 `OpenCode-WeChat Broker Bridge 分阶段实施计划 Implementation Plan`
- 主路径正文不再是“基于当前实现重建”的版本

### Task 3: 新增差距分析文档

**Files:**
- Create: `docs/superpowers/specs/2026-04-08-wechat-broker-doc-reconciliation-gap-analysis.md`
- Reference: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- Reference: `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`
- Reference: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design-reconstructed.md`
- Reference: `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md`

- [ ] **Step 1: 写差距分析文档骨架**

文档至少包含这几个一级标题：

```md
# WeChat Broker 原始设计与当前实现差距分析

## 背景
## 已实现且与原始设计一致
## 已实现但路径改变
## 仍未实现 / 已废弃
## 结论
```

- [ ] **Step 2: 填“已实现且一致”章节**

至少覆盖这些例子（按实际内容再细化）：

- 单例 broker / bridge 总体方向
- `/status` 聚合主线
- request / handle / slash 命令作为微信交互主入口

- [ ] **Step 3: 填“已实现但路径改变”章节**

至少覆盖这些例子（按实际内容再细化）：

- 当前仓库后来演化出的阶段 A/B/C 与 compat 迁移路线
- 真实 host gate、菜单绑定流、JITI/compat 层等并不在原始 3 月 23 日文档中，但已成为现在的实现路径

- [ ] **Step 4: 填“仍未实现 / 已废弃”章节**

至少覆盖这些例子（按实际内容再细化）：

- 原始设计里尚未兑现的可靠性/恢复/死信类能力
- 被后续实现收敛掉或改成其他路径的旧假设

- [ ] **Step 5: 写结论，说明主文档、重建稿与差距分析三者关系**

结论必须明确：

- 哪份文件是原始主文档
- 哪份文件是重建稿归档
- 差距分析文档应如何被阅读和引用

### Task 4: 自检与最终核对

**Files:**
- Check: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- Check: `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md`
- Check: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design-reconstructed.md`
- Check: `docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation-reconstructed.md`
- Check: `docs/superpowers/specs/2026-04-08-wechat-broker-doc-reconciliation-gap-analysis.md`

- [ ] **Step 1: 检查主路径和归档路径没有互相覆盖错位**

预期：

- 主路径是找回原稿
- `-reconstructed` 路径是当前重建稿

- [ ] **Step 2: 检查差距分析文档无占位符、无“待补充”语句**

预期：

- 不出现 `TODO`、`TBD`、`待补` 等残留
- 三类结论都已写实

- [ ] **Step 3: 检查文档关系说明是否清楚**

预期：

- 读者能理解“原稿 / 重建稿 / 差距分析”三者分别是什么
- 不会误以为重建稿就是原始 2026-03-23 文档
