# Release 流程护栏与 0.14.x Release Notes 回写设计

## 背景

当前仓库里已经存在一套明确的 release notes 模板与历史修正文档：

- `docs/release-notes-template.md`
- `docs/superpowers/specs/2026-03-18-release-notes-user-oriented-design.md`
- `docs/superpowers/plans/2026-03-18-release-notes-user-oriented-rewrite-plan.md`
- `docs/superpowers/specs/2026-03-21-release-note-rewrite-design.md`
- `docs/superpowers/plans/2026-03-21-release-note-rewrite-implementation.md`

因此当前问题不是“没有模板”，而是“模板和约束没有继续被执行”。结果是：

1. `0.14.x` 的 GitHub Release 正文逐步退化，从 `v0.13.0 / v0.14.0` 的用户导向结构退回到技术化、过短、甚至 one-liner 风格；
2. 仓库根没有项目级 `AGENTS.md` 去把发版流程重新抬回最高优先级约束，导致后续发版又回到临时手写。

## 目标

1. 在仓库根新增项目级 `AGENTS.md`，把 release notes 与发版验证重新接回顶层流程护栏。
2. 只针对 `0.14.x` 中已经退化的 GitHub Release 正文做重新研究与回写。
3. 恢复到 `v0.13.0 / v0.14.0` 代表的用户导向风格，而不是继续输出技术流水账。

## 非目标

1. 不回看全历史所有 release，只处理 `0.14.x`。
2. 不在这一轮里引入 GitHub Action 校验器、release 生成器脚本或 bot。
3. 不重写已有模板本身的整体风格，只接回并执行它。

## 方案选择

### 方案 A：项目级 AGENTS + 0.14.x Release 回写

做法：

1. 根目录新增 `AGENTS.md`，把 release 流程规则升到项目级。
2. 重新研究 `0.14.x` 里退化的 GitHub Release 正文，并按现有模板重写。

优点：

- 同时处理“以后不再漂”与“已经漂掉的版本”。
- 不需要新发明模板，直接复用已存在规范。

缺点：

- 这次工作既有仓库内文档改动，也有远端 GitHub Release 正文回写，执行面稍宽。

### 方案 B：只加 AGENTS，不改历史 Release

优点：

- 范围最小。

缺点：

- 历史上已经退化的 `0.14.x` release notes 仍然保留错误示范。

### 方案 C：只改历史 Release，不加 AGENTS

优点：

- 能立刻修复外部可见文本。

缺点：

- 流程护栏仍然缺失，后续容易再次漂移。

### 结论

采用方案 A。

## 设计细节

### 1. 项目级 `AGENTS.md` 的职责

根目录新增 `AGENTS.md`，但保持中等强度，只收反复漂移且已有依据的规则：

1. GitHub Release 正文必须遵守 `docs/release-notes-template.md`
2. `## 适合谁升级` 与 `## 你会看到的变化` 不得省略
3. 发版前必须有 fresh 验证证据，不能沿用旧测试结果
4. 版本 bump、tag、push、GitHub Release 是完整链路，不能只做其中一部分
5. 现有模板已固化时，应优先引用模板而不是临时自由发挥

这个 `AGENTS.md` 是流程护栏，不替代已有详细 docs。

### 2. `0.14.x` 历史 Release 正文回写范围

本轮只处理 `0.14.x` 中已经明显退化的版本，而不是全量历史版本。

研究方式：

1. 以 `v0.13.0`、`v0.14.0` 为正向对照样本
2. 拉取并比较 `0.14.x` 里代表性退化 release body
3. 确定哪些版本需要回写

回写后的正文要恢复到用户导向结构，而不是继续保留技术流水账。

### 3. 目标 release notes 风格

回写后应统一回到这种结构：

1. 一句话说明这版最直接的升级价值
2. `## 适合谁升级`
3. `## 你会看到的变化`
4. 仅在必要时加：
   - `## 实验性功能`
   - `## 注意事项`

要求：

- 面向用户感知，而不是研发过程流水账
- 不写成单行 `Summary + Test Plan`
- 不只罗列底层文件/命令

### 4. 研究与回写边界

为了避免范围失控，这次只做：

1. 研究 `0.14.x` 中哪些 release notes 已经退化
2. 回写这些远端 GitHub Release 正文
3. 在仓库里新增 `AGENTS.md` 接回流程护栏

不会在这轮里做：

1. release 自动化脚本
2. CI 强校验
3. 更大范围的历史 release 全量重写

## 验证

完成后应满足：

1. 仓库根存在项目级 `AGENTS.md`
2. `AGENTS.md` 中明确要求 release notes 引用现有模板、保留关键小节、发版前 fresh 验证
3. 已选择的 `0.14.x` 退化 release 已被回写为用户导向结构
4. 新规则与现有 `docs/release-notes-template.md` 及旧 release-note 设计文档不冲突
