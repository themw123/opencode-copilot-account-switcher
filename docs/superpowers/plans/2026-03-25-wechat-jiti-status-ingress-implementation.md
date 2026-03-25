# WeChat JITI `/status` 真实入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 guided smoke 已验证的 JITI + public helper 路线，接通真实微信 `/status` 入口，并补上最小“微信通知”子菜单与设置面。

**Architecture:** 继续复用阶段 C 已完成的 broker / bridge / digest / formatter 内核，但把真实微信入口改成一个 broker 侧最小运行时：它只负责通过 JITI helper 做 QR 登录、账号状态恢复、`getUpdates` 轮询、slash 识别和 `sendMessageWeixin` 回复。菜单层单独补一个最小“微信通知”子菜单，提供绑定入口与通知开关，但不提前实现完整通知系统。

**Tech Stack:** TypeScript, Node.js test runner, `jiti`, `@tencent-weixin/openclaw-weixin` 源码 helper（通过 JITI 加载）, 现有 WeChat broker IPC 与阶段 C `/status` 内核

---

## 文件结构预分解

- `src/wechat/compat/openclaw-public-helpers.ts`
  - 收敛 JITI helper：public entry、QR 登录、account state、`getUpdates`、`sendMessageWeixin`
- `src/wechat/wechat-status-runtime.ts`
  - 新建 broker 侧最小微信运行时：恢复账号、轮询 `getUpdates`、维护 `get_updates_buf`、识别 slash、回发 reply
- `src/wechat/command-parser.ts`
  - 从测试辅助提升为真实 slash 解析层；仍只识别 `/status`
- `src/wechat/broker-server.ts`
  - 增加真实 slash 入口到现有 `collectStatus()` 的最小桥接
- `src/wechat/broker-entry.ts`
  - 启动 / 关闭 `wechat-status-runtime`
- `src/common-settings-store.ts`
  - 新增微信通知子菜单相关配置项
- `src/common-settings-actions.ts`
  - 新增微信通知 toggle action
- `src/ui/menu.ts`
  - 新增“微信通知”子菜单及 5 个最小菜单项
- `src/menu-runtime.ts`
  - 接入子菜单编排与 action 流
- `src/providers/copilot-menu-adapter.ts`
  - 接入微信通知子菜单 action
- `src/providers/codex-menu-adapter.ts`
  - 接入微信通知子菜单 action
- `test/wechat-openclaw-public-helpers.test.js`
  - 锁定 JITI helper 装载能力
- `test/wechat-openclaw-guided-smoke.test.js`
  - 锁定 guided smoke 默认路径仍可完整运行
- `test/wechat-status-flow.test.js`
  - 锁定真实微信 `/status` 入站 -> `collectStatus()` -> 回复链路
- `test/common-settings-store.test.js`
  - 锁定微信通知配置项读写与默认值（若文件不存在则新建）
- `test/common-settings-actions.test.js`
  - 锁定微信通知 toggle action（若文件不存在则新建）
- `test/ui-menu-wechat.test.js`
  - 锁定“微信通知”子菜单可见项与顺序（若文件不存在则新建）

## 实施约束

- 全程严格 TDD：先写失败测试，再做最小实现，再跑通过。
- 真实微信入口只接 `/status`，不接 `/reply` / `/allow`。
- 非 slash 输入继续固定提示，不进入 AI reply。
- 不重新引入 compat 编译宿主路线。
- 菜单层只落最小“微信通知”子菜单，不顺手扩展完整通知系统。
- 如果需要 git 提交，只能在用户明确要求时进行。

### Task 1: 固定 JITI public helper 的完整边界

**Files:**
- Modify: `src/wechat/compat/openclaw-public-helpers.ts`
- Test: `test/wechat-openclaw-public-helpers.test.js`

- [ ] **Step 1: 写失败测试，锁定 helper 能覆盖完整 guided smoke 所需能力**

至少覆盖：

- public entry 解析
- QR 登录方法装载
- 最新账号状态恢复
- `getUpdates()` helper
- `sendMessageWeixin()` helper

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js`
Expected: FAIL，如果 helper 仍有缺口或接口不稳定。

- [ ] **Step 3: 实现 / 收敛 `openclaw-public-helpers.ts`**

要求：

- 统一导出最小 helper 装载接口；
- 不再暴露 compat 旧语义；
- 对缺 helper 给出明确错误，而不是静默 fallback。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js`
Expected: PASS。

### Task 2: 实现 broker 侧最小微信运行时

**Files:**
- Create: `src/wechat/wechat-status-runtime.ts`
- Modify: `src/wechat/broker-entry.ts`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定运行时只做轮询 / slash / 回复三件事**

至少覆盖：

- 恢复账号状态与 `get_updates_buf`
- 调 `getUpdates()` 长轮询
- `getUpdates()` 失败时可恢复重试，且不会清空既有 `get_updates_buf`
- 提取真实文本 slash
- 把 reply 通过 `sendMessageWeixin()` 发回
- 非 slash 只发固定提示

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: FAIL，因为真实微信运行时尚未存在。

- [ ] **Step 3: 实现 `src/wechat/wechat-status-runtime.ts` 最小运行时**

至少实现：

- `createWechatStatusRuntime()`
- `start()` / `close()`
- 内部 `getUpdates` 轮询与 `get_updates_buf` 推进

- [ ] **Step 4: 在 `src/wechat/broker-entry.ts` 启动 / 关闭运行时**

要求：

- broker 生命周期与微信运行时生命周期绑定；
- 真实微信入口失败不应拖垮 broker IPC 启动。

- [ ] **Step 5: 跑定向测试确认运行时骨架转绿**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: PASS，说明真实微信运行时骨架与失败重试语义已经成立。

### Task 3: 把真实微信 `/status` 入站接到现有 `collectStatus()`

**Files:**
- Modify: `src/wechat/command-parser.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/wechat-status-runtime.ts`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定真实 `/status` -> `collectStatus()` -> reply 文本**

至少覆盖：

- `/status` 真实入站调用现有 `collectStatus()`
- reply 文本来自现有 formatter
- `/status` handler 失败时返回稳定错误提示，而不是内部堆栈
- 非 slash 不触发 `collectStatus()`
- `/reply` / `/allow` 仍不实现

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: FAIL，因为真实 slash 路由尚未接通。

- [ ] **Step 3: 收敛 `command-parser.ts` 为真实运行时解析层**

要求：

- 只识别 `/status`
- 其它 slash 返回未实现 / 未匹配

- [ ] **Step 4: 在 `broker-server.ts` 增加最小 slash handler**

要求：

- 只负责调用现有 `collectStatus()`
- 不重写 digest / formatter 逻辑

- [ ] **Step 5: 在 `wechat-status-runtime.ts` 接上 slash handler 和回复发送**

要求：

- 识别 `/status` 后调用 broker slash handler
- 通过 `sendMessageWeixin()` 把 reply 发回当前会话
- slash handler 失败时转换为稳定错误提示

- [ ] **Step 6: 跑定向测试确认真实 `/status` 入口转绿**

Run: `npm run build && node --test test/wechat-status-flow.test.js`
Expected: PASS。

### Task 4: 增加“微信通知”最小子菜单与设置项

**Files:**
- Modify: `src/common-settings-store.ts`
- Modify: `src/common-settings-actions.ts`
- Modify: `src/ui/menu.ts`
- Modify: `src/menu-runtime.ts`
- Modify: `src/providers/copilot-menu-adapter.ts`
- Modify: `src/providers/codex-menu-adapter.ts`
- Test: `test/common-settings-store.test.js`
- Test: `test/common-settings-actions.test.js`
- Test: `test/ui-menu-wechat.test.js`

- [ ] **Step 1: 写失败测试，锁定微信通知子菜单和设置项**

至少覆盖：

- 子菜单可见
- 5 个最小项目存在且顺序稳定
- toggle 写回后可持久读取
- 绑定入口会触发明确 action

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/common-settings-store.test.js test/common-settings-actions.test.js test/ui-menu-wechat.test.js`
Expected: FAIL，因为微信通知菜单与配置项尚未实现。

- [ ] **Step 3: 在 `common-settings-store.ts` 增加最小配置字段**

建议至少包含：

- `wechatNotificationsEnabled`
- `wechatQuestionNotifyEnabled`
- `wechatPermissionNotifyEnabled`
- `wechatSessionErrorNotifyEnabled`

- [ ] **Step 4: 在 `common-settings-actions.ts` 增加 toggle action**

要求：

- 与现有 common settings action 风格一致；
- 不混淆既有 slash / retry / loop-safety。

- [ ] **Step 5: 在 menu / adapters / runtime 中接上子菜单**

要求：

- 新增“绑定 / 重绑微信”入口 action
- 新增 4 个 toggle 项
- 维持现有 provider menu 风格

- [ ] **Step 6: 跑定向测试确认菜单层转绿**

Run: `npm run build && node --test test/common-settings-store.test.js test/common-settings-actions.test.js test/ui-menu-wechat.test.js`
Expected: PASS。

### Task 5: Guided smoke 与回归验收

**Files:**
- Modify: `src/wechat/compat/openclaw-public-helpers.ts`
- Modify: `src/wechat/wechat-status-runtime.ts`
- Modify: `src/wechat/command-parser.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/broker-entry.ts`
- Modify: `src/common-settings-store.ts`
- Modify: `src/common-settings-actions.ts`
- Modify: `src/ui/menu.ts`
- Modify: `src/menu-runtime.ts`
- Modify: `src/providers/copilot-menu-adapter.ts`
- Modify: `src/providers/codex-menu-adapter.ts`
- Test: `test/wechat-openclaw-public-helpers.test.js`
- Test: `test/wechat-openclaw-smoke.test.js`
- Test: `test/wechat-openclaw-guided-smoke.test.js`
- Test: `test/wechat-openclaw-task3.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/common-settings-store.test.js`
- Test: `test/common-settings-actions.test.js`
- Test: `test/ui-menu-wechat.test.js`

- [ ] **Step 1: 跑新 spec 定向测试集合**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js test/wechat-openclaw-smoke.test.js test/wechat-openclaw-guided-smoke.test.js test/wechat-openclaw-task3.test.js test/wechat-status-flow.test.js test/common-settings-store.test.js test/common-settings-actions.test.js test/ui-menu-wechat.test.js`
Expected: PASS。

- [ ] **Step 2: 跑阶段 B / C 内核回归**

Run: `npm run build && node --test test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js test/wechat-session-digest.test.js test/wechat-plugin-hooks-status.test.js`
Expected: PASS。

- [ ] **Step 3: 检查 diff 边界**

Run: `git diff -- src/wechat/compat/openclaw-public-helpers.ts src/wechat/wechat-status-runtime.ts src/wechat/command-parser.ts src/wechat/broker-server.ts src/wechat/broker-entry.ts src/common-settings-store.ts src/common-settings-actions.ts src/ui/menu.ts src/menu-runtime.ts src/providers/copilot-menu-adapter.ts src/providers/codex-menu-adapter.ts test/wechat-openclaw-public-helpers.test.js test/wechat-openclaw-smoke.test.js test/wechat-openclaw-guided-smoke.test.js test/wechat-openclaw-task3.test.js test/wechat-status-flow.test.js test/common-settings-store.test.js test/common-settings-actions.test.js test/ui-menu-wechat.test.js`
Expected: 只包含 JITI 路线真实 `/status` 入口与最小微信通知子菜单，不包含 `/reply`、`/allow`、AI reply、完整通知系统。

## 完成判定

只有同时满足以下条件，这份 plan 对应的工作才算完成：

1. compat 旧路径不再作为运行时设计基础。
2. JITI + public helper 路线能够完整支撑 guided smoke 所需能力。
3. 真实微信 `/status` 入站会调用现有 `collectStatus()`。
4. reply 文本会通过 `sendMessageWeixin()` 发回当前会话。
5. 非 slash 输入继续固定提示，不进入 AI reply。
6. `/reply` / `/allow` 仍然不实现。
7. 菜单中存在“微信通知”子菜单，并至少提供绑定入口、总开关、`question`、`permission`、`session error` 五项。
