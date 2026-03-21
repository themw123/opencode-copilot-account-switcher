# Release Note Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 `v0.10.9` 到 `v0.11.0` 的 5 个 GitHub Release body，让它们回到更自然的“用户视角短导语 + 变化列表”风格。

**Architecture:** 不修改仓库源码、tag 或历史，只原地编辑 5 个 GitHub Release 的 body。每个版本都先核对相邻 tag 的提交与现有文档事实，再写成短导语 + `## 你会看到的变化`，最后逐个回读验证线上内容。

**Tech Stack:** Git tags, GitHub Releases (`gh release view/edit`), local spec/plan docs

---

## 文件结构与职责映射

### 修改

- GitHub Release `v0.10.9`
  - 改写为更自然的 hotfix 升级说明

- GitHub Release `v0.10.10`
  - 改写为账号路由语义收敛与 `unbound-fallback` 用户可见行为说明

- GitHub Release `v0.10.11`
  - 改写为 `AI_JSONParseError` 自动重试边界说明

- GitHub Release `v0.10.12`
  - 改写为 `/copilot-status` 展示体验升级说明

- GitHub Release `v0.11.0`
  - 改写为 feature release，强调 `/copilot-compact`、`/copilot-stop-tool` 与 status 省略号修复，并修掉 body 中的字面量 `\n`

### 参考

- `docs/superpowers/specs/2026-03-21-release-note-rewrite-design.md`
  - 重写风格与边界约束的事实来源

---

### Task 1: 先锁定事实来源与写作边界

**Files:**
- Reference: `docs/superpowers/specs/2026-03-21-release-note-rewrite-design.md`
- Reference: GitHub Releases `v0.10.8` ~ `v0.11.0`

- [ ] **Step 1: 读取 `v0.10.8`、`v0.10.9`、`v0.10.10`、`v0.10.11`、`v0.10.12`、`v0.11.0` 当前 release body**

Run:

```bash
gh release view v0.10.8 --json body
gh release view v0.10.9 --json body
gh release view v0.10.10 --json body
gh release view v0.10.11 --json body
gh release view v0.10.12 --json body
gh release view v0.11.0 --json body
```

- [ ] **Step 2: 核对每个目标版本的提交范围**

Run:

```bash
git log --oneline v0.10.8..v0.10.9
git log --oneline v0.10.9..v0.10.10
git log --oneline v0.10.10..v0.10.11
git log --oneline v0.10.11..v0.10.12
git log --oneline v0.10.12..v0.11.0
```

- [ ] **Step 3: 为每个版本先写出一句“为什么值得升级”草稿**

要求：

- 只能使用提交、spec/plan、测试名里能支撑的事实
- 不写文件级动作
- 不写空泛形容词

---

### Task 2: 重写 `v0.10.9` 与 `v0.10.10`

**Files:**
- Modify: GitHub Release `v0.10.9`
- Modify: GitHub Release `v0.10.10`

- [ ] **Step 1: 重写 `v0.10.9` 文案**

结构必须是：

```md
<1 段短导语>

## 你会看到的变化
- ...
- ...
- ...
```

- [ ] **Step 2: 用 `gh release edit` 直接更新 `v0.10.9`**

Run:

```bash
gh release edit v0.10.9 --notes "<rewritten body>"
```

- [ ] **Step 3: 回读 `v0.10.9` 验证线上内容**

Run:

```bash
gh release view v0.10.9 --json body,url
```

Expected: body 采用短导语 + `## 你会看到的变化`，且不再是机械 `## Summary`

- [ ] **Step 4: 按同样结构重写 `v0.10.10`**

- [ ] **Step 5: 用 `gh release edit` 更新并回读 `v0.10.10`**

Run:

```bash
gh release edit v0.10.10 --notes "<rewritten body>"
gh release view v0.10.10 --json body,url
```

Expected: body 能读出账号路由语义收敛与 `unbound-fallback` 的用户可见变化

---

### Task 3: 重写 `v0.10.11` 与 `v0.10.12`

**Files:**
- Modify: GitHub Release `v0.10.11`
- Modify: GitHub Release `v0.10.12`

- [ ] **Step 1: 重写 `v0.10.11`**

要求：

- 导语要先解释：某类 Copilot 响应解析错误现在会自动重试
- bullet 要明确：不是所有 parse error 都被放进重试范围

- [ ] **Step 2: 更新并回读 `v0.10.11`**

Run:

```bash
gh release edit v0.10.11 --notes "<rewritten body>"
gh release view v0.10.11 --json body,url
```

- [ ] **Step 3: 重写 `v0.10.12`**

要求：

- 导语先告诉用户 `/copilot-status` 现在更容易看懂
- bullet 要写清楚分组、固定宽度布局、空态 / 超长值处理这些可感知结果

- [ ] **Step 4: 更新并回读 `v0.10.12`**

Run:

```bash
gh release edit v0.10.12 --notes "<rewritten body>"
gh release view v0.10.12 --json body,url
```

---

### Task 4: 重写 `v0.11.0` 并收尾验证

**Files:**
- Modify: GitHub Release `v0.11.0`

- [ ] **Step 1: 重写 `v0.11.0` feature release 文案**

必须覆盖：

- `/copilot-compact`
- `/copilot-stop-tool`
- `/copilot-status` 的 `…`

并且：

- stop-tool 文案不能暗示“真单 tool cancel”
- 必须消除当前 body 中的字面量 `\n`

- [ ] **Step 2: 更新并回读 `v0.11.0`**

Run:

```bash
gh release edit v0.11.0 --notes "<rewritten body>"
gh release view v0.11.0 --json body,url
```

Expected: body 正常换行、结构统一、重点清楚

- [ ] **Step 3: 做最终一致性检查**

Run:

```bash
gh release view v0.10.9 --json body,url
gh release view v0.10.10 --json body,url
gh release view v0.10.11 --json body,url
gh release view v0.10.12 --json body,url
gh release view v0.11.0 --json body,url
```

确认：

- 5 个版本都采用短导语 + `## 你会看到的变化`
- 不再出现 `## Summary`
- `v0.11.0` 没有字面量 `\n`
- 每个版本都能看出自己的升级理由与用户可见变化
- GitHub 返回的 `url` 字段正常存在，release 链接可用

- [ ] **Step 4: 校验 tag 与历史未被改动**

Run:

```bash
git tag --list v0.10.9 v0.10.10 v0.10.11 v0.10.12 v0.11.0
git log --oneline -5
```

Expected: 仅 release body 被改写；tag 名称与最近提交历史都未被改动

- [ ] **Step 5: 向用户回报最终结果**

回报内容应包含：

- 5 个 release 的 URL
- 每个版本一句话摘要
- 是否存在任何无法从提交 / 文档事实中支撑、因此被刻意省略的点
