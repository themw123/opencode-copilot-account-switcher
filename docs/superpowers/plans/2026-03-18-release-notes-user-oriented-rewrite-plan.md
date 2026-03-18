# Release Notes 用户导向统一改写计划

> **对于代理工作线程：** 必需：使用 superpowers:subagent-driven-development（如果子代理可用）或 superpowers:executing-plans 来实现此功能计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 将 `v0.7.1` 到 `v0.5.0` 的 GitHub Release Notes 统一改写为面向用户、保留实验性边界说明的稳定风格，并产出后续可复用模板。

**架构：** 先依据规格文档逐版核对事实来源，再按统一结构分别改写 GitHub release 正文。改写完成后，回读线上 release 内容确认结构、措辞和实验性说明都满足规格要求。

**技术栈：** GitHub CLI（`gh`）、GitHub Releases、Markdown

---

## Chunk 1: 事实核对与改写草稿

### Task 1: 核对 `v0.7.1` 与 `v0.7.0`

**Files:**
- 参考：`docs/superpowers/specs/2026-03-18-release-notes-user-oriented-design.md`
- 参考：GitHub Releases `v0.7.1`、`v0.7.0`
- 参考：相关提交与现有测试/文档

- [ ] **Step 1: 读取 `v0.7.1`、`v0.7.0` 当前 release 正文与相关提交**

运行：`gh release view v0.7.1 --json body,name && gh release view v0.7.0 --json body,name && git show --stat --no-patch v0.7.1 && git show --stat --no-patch v0.7.0`
预期结果：能看到两版当前正文与对应 tag 提交，供事实校验。

- [ ] **Step 2: 补查 `v0.7.1`、`v0.7.0` 可直接佐证的文档或测试**

运行：查阅以下文件或按关键词搜索：
- `README.md`
- `docs/superpowers/specs/2026-03-18-copilot-inject-wait-interaction-policy-design.md`
- `test/plugin.test.js`
- `test/wait-tool.test.js`
关键词：`copilot-inject`、`copilot-status`、`wait`、`question`、`notify`
预期结果：新版正文中每个用户可见表述都能找到对应事实来源。

- [ ] **Step 3: 根据规格为 `v0.7.1` 起草新版正文**

要求：
- 包含 1 句价值总结
- 包含 1-2 条“适合谁升级”
- 包含 2-5 条“你会看到的变化”
- 无实验性能力则不写“实验性功能”

- [ ] **Step 4: 根据规格为 `v0.7.0` 起草新版正文**

要求：
- 明确 `/copilot-inject` 与 `wait` 的用户价值
- 保留实验性说明
- 若需要说明“用于验证某条交互路径/工作流”，必须采用用户预期管理口吻

- [ ] **Step 5: 自检两版草稿是否满足规格硬约束**

检查项：
- 是否回答“为什么值得升级”
- 是否回答“谁会关心这次更新”
- 是否避免内部实现/复盘口吻
- “适合谁升级”是否为 1-2 条
- “你会看到的变化”是否为 2-5 条
- 主体是否保持 5-10 行可扫读

- [ ] **Step 6: 将 `v0.7.1`、`v0.7.0` 草稿分别写入临时文件**

创建：
- `tmp/release-notes-v0.7.1.md`
- `tmp/release-notes-v0.7.0.md`

预期结果：两份 `gh release edit --notes-file` 可直接使用的 Markdown 文件已生成。

### Task 2: 核对 `v0.6.1`、`v0.6.0`、`v0.5.0`

**Files:**
- 参考：`docs/superpowers/specs/2026-03-18-release-notes-user-oriented-design.md`
- 参考：GitHub Releases `v0.6.1`、`v0.6.0`、`v0.5.0`
- 参考：相关提交与现有测试/文档

- [ ] **Step 1: 读取 `v0.6.1`、`v0.6.0`、`v0.5.0` 当前 release 正文与相关提交**

运行：`gh release view v0.6.1 --json body,name && gh release view v0.6.0 --json body,name && gh release view v0.5.0 --json body,name && git show --stat --no-patch v0.6.1 && git show --stat --no-patch v0.6.0 && git show --stat --no-patch v0.5.0`
预期结果：能看到三版当前正文与对应 tag 提交，供逐版重写。

- [ ] **Step 2: 补查 `v0.6.1`、`v0.6.0`、`v0.5.0` 可直接佐证的文档或测试**

运行：查阅以下文件或按关键词搜索：
- `README.md`
- `docs/superpowers/specs/2026-03-17-copilot-status-toast-command-design.md`
- `docs/superpowers/specs/2026-03-17-guided-loop-safety-notify-question-design.md`
- `docs/superpowers/specs/2026-03-17-guided-loop-safety-derived-session-design.md`
- `test/status-command.test.js`
- `test/plugin.test.js`
关键词：`copilot-status`、`toast`、`notify`、`question`、`derived session`
预期结果：三版正文中的关键表述都有事实来源支撑。

- [ ] **Step 3: 起草 `v0.6.1` 新版正文**

要求：
- 强调 `/copilot-status` toast 修复对用户的直接帮助
- 避免技术事故分析口吻

- [ ] **Step 4: 起草 `v0.6.0` 新版正文**

要求：
- 明确 `/copilot-status` 的使用价值
- 保留实验性说明
- 可以说明该入口当前主要用于验证 slash 交互路径，但必须从用户预期角度表述

- [ ] **Step 5: 起草 `v0.5.0` 新版正文**

要求：
- 明确 notify/question 分流与 derived session 修复带来的用户感受变化

- [ ] **Step 6: 自检三版草稿是否满足规格硬约束**

检查项：
- 结构是否统一
- 实验性说明是否只在需要时出现
- 是否没有写入无法从事实来源佐证的内容
- “适合谁升级”是否为 1-2 条
- “你会看到的变化”是否为 2-5 条
- 主体是否保持 5-10 行可扫读

- [ ] **Step 7: 将 `v0.6.1`、`v0.6.0`、`v0.5.0` 草稿分别写入临时文件**

创建：
- `tmp/release-notes-v0.6.1.md`
- `tmp/release-notes-v0.6.0.md`
- `tmp/release-notes-v0.5.0.md`

预期结果：三份 `gh release edit --notes-file` 可直接使用的 Markdown 文件已生成。

## Chunk 2: 回写 GitHub Releases 与模板沉淀

### Task 3: 更新 GitHub Release 正文

**Files:**
- 修改：GitHub Releases `v0.7.1`、`v0.7.0`、`v0.6.1`、`v0.6.0`、`v0.5.0`
- 创建：`tmp/`
- 创建：`tmp/release-notes-v0.7.1.md`
- 创建：`tmp/release-notes-v0.7.0.md`
- 创建：`tmp/release-notes-v0.6.1.md`
- 创建：`tmp/release-notes-v0.6.0.md`
- 创建：`tmp/release-notes-v0.5.0.md`

- [ ] **Step 1: 确保临时目录存在**

运行：`mkdir -p tmp`
预期结果：`tmp/` 目录存在，可供存放五个 release 正文草稿。

- [ ] **Step 2: 使用 `gh release edit` 更新 `v0.7.1` 正文**

运行：`gh release edit v0.7.1 --notes-file tmp/release-notes-v0.7.1.md`
预期结果：release 正文更新成功。

- [ ] **Step 3: 使用 `gh release edit` 更新 `v0.7.0` 正文**

运行：`gh release edit v0.7.0 --notes-file tmp/release-notes-v0.7.0.md`
预期结果：release 正文更新成功。

- [ ] **Step 4: 使用 `gh release edit` 更新 `v0.6.1` 正文**

运行：`gh release edit v0.6.1 --notes-file tmp/release-notes-v0.6.1.md`
预期结果：release 正文更新成功。

- [ ] **Step 5: 使用 `gh release edit` 更新 `v0.6.0` 正文**

运行：`gh release edit v0.6.0 --notes-file tmp/release-notes-v0.6.0.md`
预期结果：release 正文更新成功。

- [ ] **Step 6: 使用 `gh release edit` 更新 `v0.5.0` 正文**

运行：`gh release edit v0.5.0 --notes-file tmp/release-notes-v0.5.0.md`
预期结果：release 正文更新成功。

### Task 4: 产出后续复用模板并验证线上结果

**Files:**
- 创建：`docs/release-notes-template.md`
- 参考：`docs/superpowers/specs/2026-03-18-release-notes-user-oriented-design.md`

- [ ] **Step 1: 生成一份后续可复用的 Release Notes 模板**

内容要求：
- 含价值总结、适合谁升级、你会看到的变化、实验性功能、注意事项骨架
- 标明哪些段落可省略

- [ ] **Step 2: 回读五个线上 release，确认正文已更新**

运行：
- `gh release view v0.7.1 --json body,name`
- `gh release view v0.7.0 --json body,name`
- `gh release view v0.6.1 --json body,name`
- `gh release view v0.6.0 --json body,name`
- `gh release view v0.5.0 --json body,name`
预期结果：五个版本正文均为新内容。

- [ ] **Step 3: 对照规格做最终验收**

检查项：
- 每版都有价值总结
- 每版都有“适合谁升级”和“你会看到的变化”
- “适合谁升级”是否控制在 1-2 条
- “你会看到的变化”是否控制在 2-5 条
- 主体是否保持 5-10 行可扫读
- 实验性能力说明边界清楚
- 不存在明显研发复盘口吻

- [ ] **Step 4: 汇总交付结果**

输出：
- 改写了哪些 release
- 统一后的风格要点
- 后续可复用模板
