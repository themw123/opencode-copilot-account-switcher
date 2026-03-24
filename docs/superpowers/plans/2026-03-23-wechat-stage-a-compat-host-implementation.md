# 阶段 A Guided Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把阶段 A 的真实账号手测收敛成一条 `wechat:smoke:guided` 命令，完成二维码登录、slash 采样、非 slash `10/10` 验证、证据脱敏写盘与 `go-no-go` 更新。

**Architecture:** 继续复用现有 `openclaw-host.ts`、`slash-guard.ts` 与 `openclaw-smoke.ts`。新增一个 guided orchestrator 负责把 `self-test`、二维码登录、采样状态机、证据编号写盘和结论更新串成一个闭环，但仍严格停留在阶段 A 的 compat host 与 stub/no-op 边界内。

**Tech Stack:** TypeScript, Node.js test runner, `@tencent-weixin/openclaw-weixin`, markdown/json evidence files

---

## 文件结构预分解

- `package.json`
  - 增加 `wechat:smoke:guided` 命令入口
- `src/wechat/compat/openclaw-guided-smoke.ts`
  - guided smoke 状态机、二维码登录、阶段调度、异常收口
- `src/wechat/compat/openclaw-smoke.ts`
  - 保留 `self-test` / `dry-run`，并提供 guided orchestrator 复用的脱敏与文档更新辅助函数
- `src/wechat/compat/slash-guard.ts`
  - 继续作为 slash-only 分流入口
- `test/wechat-openclaw-guided-smoke.test.js`
  - guided smoke 状态机、证据写盘、结论更新测试
- `test/wechat-openclaw-task3.test.js`
  - 保持 dry-run、blocked、ready、脱敏与文档骨架回归测试
- `docs/superpowers/wechat-stage-a/compat-host-contract.md`
  - 如 guided smoke 发现新的宿主约束，则同步补充
- `docs/superpowers/wechat-stage-a/api-samples-sanitized.md`
  - 由 guided run 更新真实样本索引与字段说明
- `docs/superpowers/wechat-stage-a/go-no-go.md`
  - 由 guided run 更新运行状态、证据引用与最终结论
- `docs/superpowers/wechat-stage-a/evidence/<run-id>/`
  - 保存本次 guided run 的编号证据

### Task 1: 锁定 guided smoke 状态机与命令入口

**Files:**
- Create: `src/wechat/compat/openclaw-guided-smoke.ts`
- Modify: `package.json`
- Test: `test/wechat-openclaw-guided-smoke.test.js`

- [ ] **Step 1: 写 guided smoke 的失败测试**

在 `test/wechat-openclaw-guided-smoke.test.js` 先写这些断言：

- `test("guided smoke preflight writes 001-preflight evidence")`
- `test("guided smoke preflight records cwd node version dependency versions and run id")`
- `test("guided smoke preflight validates public entry load and evidence directory creation")`
- `test("guided smoke preflight aborts when compat host self-test fails")`
- `test("guided smoke command invokes self-test before qr login")`
- `test("guided smoke evidence names are fixed as 001 002 003")`

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-openclaw-guided-smoke.test.js`
Expected: FAIL，因为 guided orchestrator 尚未实现。

- [ ] **Step 3: 实现 guided orchestrator 最小骨架**

在 `src/wechat/compat/openclaw-guided-smoke.ts` 先实现：

- `createGuidedSmokeRun()`：生成 run id 与阶段状态
- `runGuidedSmoke()`：顺序调用各阶段
- `failGuidedSmoke()`：统一写失败状态
- `writePreflightEvidence()`：固定写 `001-preflight.md`

预检证据必须至少写入：

- run id
- 当前工作目录
- Node 版本
- `@tencent-weixin/openclaw-weixin` 版本
- `openclaw` 版本
- 公开入口加载结果
- `evidence/<run-id>/` 创建结果
- self-test 结果

此步只做预检与状态机骨架，不接真实二维码登录和真实采样。

- [ ] **Step 4: 增加命令入口**

在 `package.json` 增加：

- `wechat:smoke:guided`

入口只调用 `dist/wechat/compat/openclaw-guided-smoke.js`。

同时把旧入口口径锁死：

- `wechat:smoke:real-account` 仅保留 dry-run / 准备检查语义
- 所有真实账号手测提示、帮助文案和文档引用都统一指向 `wechat:smoke:guided`

- [ ] **Step 5: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-openclaw-guided-smoke.test.js`
Expected: PASS，状态机和命令入口成立。

### Task 2: 接入公开二维码登录与 slash 采样

**Files:**
- Modify: `src/wechat/compat/openclaw-guided-smoke.ts`
- Modify: `src/wechat/compat/openclaw-smoke.ts`
- Modify: `test/wechat-openclaw-guided-smoke.test.js`

- [ ] **Step 1: 写二维码登录与 slash 采样的失败测试**

新增断言：

- `loginWithQrStart` 失败会写 `002-qr-start.md`
- `loginWithQrWait` 默认超时 `480_000ms`
- `loginWithQrWait` 超时会把运行状态写成 `blocked`、最终结论写成 `known-unknown`
- 全局异常会先写最后一个证据文件，再更新结论
- `/status`、`/reply`、`/allow` 都必须采样到真实入站结构才算完成
- slash 三条命令各自必须产出 `004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-openclaw-guided-smoke.test.js`
Expected: FAIL，因为二维码登录与 slash 采样尚未接线。

- [ ] **Step 3: 接入公开二维码登录**

在 `src/wechat/compat/openclaw-guided-smoke.ts` 必须先通过 `openclaw-host.ts` 的公开入口加载与 `registerChannel` 获取真实 `weixinPlugin`，然后只通过该真实插件对象调用：

- `loginWithQrStart`
- `loginWithQrWait`

要求：

- 优先打印二维码
- 回退打印二维码 URL
- 登录结果立即交给证据写盘层
- 二维码启动失败时固定写 `002-qr-start.md`
- 登录成功时固定写 `003-login-success.md`
- 超时值默认 `480_000ms`，若覆盖则写入证据文件

- [ ] **Step 4: 接入 slash 采样状态机**

在 guided orchestrator 中顺序引导并采样：

- `/status`
- `/reply <text>`
- `/allow <text>`

完成标准以程序化采样为准，不允许只靠人工确认。

每条命令通过前必须同时满足：

- 原始命令文本已记录
- 真实入站结构已脱敏写盘
- 路由结果为 stub/no-op
- slash 场景若无真实出站，证据中明确标注“无出站”；若实现中观察到真实出站，则作为附加信息记录，但不提高通过门槛
- 证据文件包含时间、输入、关键字段、路由结果、证据编号
- `api-samples-sanitized.md` 已补上该命令样本或引用

- [ ] **Step 5: 写 slash 失败即中止的失败测试**

新增断言：

- `test("guided smoke stops before non-slash verification when slash sampling is incomplete")`
- 当 `/status`、`/reply`、`/allow` 任一未完成采样时：
  - 后续非 slash `10/10` 不再执行
  - 运行状态写为 `blocked`
  - 最终结论写为 `known-unknown`

- [ ] **Step 6: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-openclaw-guided-smoke.test.js`
Expected: PASS，二维码登录与 slash 采样路径成立。

### Task 3: 完成非 slash `10/10`、证据写盘与文档更新

**Files:**
- Modify: `src/wechat/compat/openclaw-guided-smoke.ts`
- Modify: `src/wechat/compat/openclaw-smoke.ts`
- Modify: `test/wechat-openclaw-guided-smoke.test.js`
- Modify: `test/wechat-openclaw-task3.test.js`
- Modify: `docs/superpowers/wechat-stage-a/api-samples-sanitized.md`
- Modify: `docs/superpowers/wechat-stage-a/go-no-go.md`
- Modify: `docs/superpowers/wechat-stage-a/evidence/README.md`
- Modify: `docs/superpowers/wechat-stage-a/compat-host-contract.md`

- [ ] **Step 1: 写非 slash `10/10` 与证据写盘的失败测试**

新增断言：

- 非 slash 每次成功都必须同时采样到入站结构与告警回发成功响应
- 任一次失败立即停止并把最终结论写成 `no-go`
- 每个阶段证据都写入 `docs/superpowers/wechat-stage-a/evidence/<run-id>/`
- 新发现的宿主约束会同步更新 `compat-host-contract.md`
- 证据文件名必须固定编号并包含最小字段：时间、输入、关键字段、路由结果、证据编号
- 当写盘内容仍含未脱敏敏感字段时，证据写入必须失败并把运行状态改为 `blocked`
- `test("guided smoke real-account command refuses full handtest through legacy real-account entry")`

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-openclaw-guided-smoke.test.js test/wechat-openclaw-task3.test.js`
Expected: FAIL，因为 `10/10` 计数和证据写盘尚未完整实现。

- [ ] **Step 3: 实现非 slash `10/10` 计数与失败收口**

要求：

- 成功判定必须同时满足：真实入站 + 固定告警文案回发成功 + 证据写盘完成
- 任一次失败立即停止计数并写 `no-go`
- 第一次普通文本成功文件名固定从 `007-nonslash-warning-01.json` 开始递增

- [ ] **Step 4: 实现证据与文档更新**

要求：

- 所有原始内容先过脱敏器再写盘
- `go-no-go.md` 只记录运行状态、检查结果、证据引用、最终结论
- `api-samples-sanitized.md` 更新样本索引和字段说明
- `compat-host-contract.md` 更新新增宿主发现（如有）
- 当发现新的敏感字段或已有脱敏规则未命中时，先补脱敏测试与规则，再允许证据写盘恢复

关键字段完整性检查必须固定落盘到：

- `docs/superpowers/wechat-stage-a/evidence/<run-id>/090-key-fields-check.md`

该文件至少包含：

- 登录字段检查结果
- `getupdates` 关键字段检查结果
- slash 入站字段检查结果
- 告警回发成功/失败字段检查结果

并且必须同步把逐项结果写入 `go-no-go.md` 的检查清单。

- [ ] **Step 5: 跑回归测试确认转绿**

Run: `npm run build && node --test test/wechat-openclaw-guided-smoke.test.js test/wechat-openclaw-task3.test.js`
Expected: PASS，`10/10` 状态机与文档更新成立。

### Task 4: 执行真实 guided smoke 手测并完成阶段 A 结论

**Files:**
- Modify: `docs/superpowers/wechat-stage-a/api-samples-sanitized.md`
- Modify: `docs/superpowers/wechat-stage-a/go-no-go.md`
- Modify: `docs/superpowers/wechat-stage-a/evidence/README.md`
- Create: `docs/superpowers/wechat-stage-a/evidence/<run-id>/*`

- [ ] **Step 1: 运行全量自动化验证**

Run: `npm run build && node --test test/wechat-openclaw-host.test.js test/wechat-openclaw-smoke.test.js test/wechat-openclaw-task3.test.js test/wechat-openclaw-guided-smoke.test.js`
Expected: PASS。

- [ ] **Step 2: 连续运行 `self-test 3/3`**

Run: `npm run wechat:smoke:self-test && npm run wechat:smoke:self-test && npm run wechat:smoke:self-test`
Expected: 三次都成功。

- [ ] **Step 3: 运行 guided smoke 真实账号手测**

Run: `npm run wechat:smoke:guided`
Expected:

- 二维码登录成功
- `/status`、`/reply`、`/allow` 采样落档
- 非 slash 告警回发 `10/10`

- [ ] **Step 4: 检查阶段 B 关键字段清单完整性**

检查：

- 登录后认证相关字段
- `getupdates` 的 `msgs`、`get_updates_buf`、`context_token`
- 命令入站的用户标识与消息内容结构
- 告警回发成功/失败响应形态

Expected: 无关键字段缺失，并把结果写入 `090-key-fields-check.md` 与 `go-no-go.md`。

- [ ] **Step 5: 更新最终结论**

要求：

- 全部通过时写 `go`
- 明确失败时写 `no-go`
- 中断或证据不完整时写 `known-unknown`

## 阶段 A 完成判定

只有同时满足以下条件，阶段 A 才算完成：

1. `test/wechat-openclaw-host.test.js` 通过
2. `test/wechat-openclaw-smoke.test.js` 通过
3. `test/wechat-openclaw-task3.test.js` 通过
4. `test/wechat-openclaw-guided-smoke.test.js` 通过
5. `self-test 3/3` 成功
6. guided smoke 完成真实二维码登录
7. `/status`、`/reply`、`/allow` 真实采样完成
8. 非 slash 告警回发 `10/10`
9. 阶段 B 关键字段清单完整
10. `go-no-go.md` 最终为 `go`
