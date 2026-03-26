# WeChat 菜单 / 绑定 / 多账号扩展 Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把微信能力收口为通用菜单下的真正子菜单，接通 `wechat-bind` 真实绑定流程，展示当前已绑定微信账号信息，并把配置结构升级为可面向多微信账号扩展，同时显式考虑 `@tencent-weixin/openclaw-weixin@2.0.1`。

**Architecture:** 先把“账号信息/上游版本差异”隔离到单独适配层，再重构微信配置结构与菜单层级，最后接入真实绑定流程。UI 层只消费适配后的展示模型，不直接依赖官方插件原始字段；内部 transport 字段如 `baseUrl`、`getUpdatesBuf` 明确不进入用户菜单。

**Tech Stack:** TypeScript, Node.js test runner, 现有 menu runtime / provider adapters, WeChat operator/token stores, JITI-loaded `@tencent-weixin/openclaw-weixin`, planned `2.0.1` compatibility adapter

---

## 文件结构预分解

- `src/wechat/openclaw-account-adapter.ts`
  - 新建账号适配层；屏蔽 `1.0.3` / `2.0.1` 差异，输出菜单可展示的绑定信息模型
- `src/common-settings-store.ts`
  - 将平铺微信布尔值升级为嵌套微信配置对象
- `src/common-settings-actions.ts`
  - 补 `wechat-bind` / `wechat-rebind` / `wechat-unbind` / 通知 toggle 的 action
- `src/ui/menu.ts`
  - 把微信入口迁到通用菜单下的真正子菜单
- `src/menu-runtime.ts`
  - 支持微信子菜单的跳转与返回
- `src/providers/copilot-menu-adapter.ts`
  - 接入微信子菜单和真实绑定 action 的调度
- `src/providers/codex-menu-adapter.ts`
  - 接入微信子菜单和真实绑定 action 的调度
- `src/wechat/bind-flow.ts`
  - 新建绑定流程编排；负责触发绑定 / 重绑 / 解绑
- `src/wechat/operator-store.ts`
  - 若需要，扩展绑定展示所需字段读取
- `src/wechat/compat/openclaw-public-helpers.ts`
  - 明确上游 `2.0.1` 跟进点，必要时调整适配层输入
- `test/common-settings-store.test.js`
  - 更新为新微信配置结构测试
- `test/common-settings-actions.test.js`
  - 锁定新的微信 action 语义
- `test/ui-menu-wechat.test.js`
  - 锁定微信入口在通用菜单下作为真正子菜单
- `test/wechat-bind-flow.test.js`
  - 新建，锁定真实绑定流程
- `test/wechat-openclaw-public-helpers.test.js`
  - 增加 `2.0.1` 适配与账号信息读取测试

## 实施约束

- 全程严格 TDD：先写失败测试，再做最小实现，再跑通过。
- 不在菜单中展示 `baseUrl`、`getUpdatesBuf` 等内部字段。
- UI 层不能直接散落 `1.0.3` / `2.0.1` 差异判断；差异必须压进适配层。
- 本轮做“真实绑定流程”，但不顺手扩展完整通知系统或多账号推送策略本身。
- 只为未来多账号扩展预留结构，不要求本轮就做完整多账号发送策略。
- 如需 git 提交，只能在用户明确要求时进行。

### Task 1: 固定上游账号能力与 2.0.1 适配边界

**Files:**
- Create: `src/wechat/openclaw-account-adapter.ts`
- Modify: `src/wechat/compat/openclaw-public-helpers.ts`
- Test: `test/wechat-openclaw-public-helpers.test.js`

- [ ] **Step 1: 写失败测试，锁定账号展示字段与 2.0.1 适配层输出**

至少覆盖：

- `listAccountIds()` / `resolveAccount()` / `describeAccount()` 的可用性
- 适配层输出 `accountId/name/enabled/configured/userId/boundAt` 这类展示字段
- 不向 UI 暴露 `baseUrl/getUpdatesBuf`
- `2.0.1` 差异留在适配层吸收

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js`
Expected: FAIL，因为适配层尚未存在或字段边界未锁定。

- [ ] **Step 3: 实现账号适配层与 helper 输入收口**

要求：

- 新增 `openclaw-account-adapter.ts`
- `openclaw-public-helpers.ts` 只提供原始 helper，UI 可展示模型统一交给 adapter
- adapter 明确隐藏 `baseUrl` 等内部字段

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js`
Expected: PASS。

### Task 2: 把微信配置结构升级为可扩展对象

**Files:**
- Modify: `src/common-settings-store.ts`
- Modify: `src/common-settings-actions.ts`
- Test: `test/common-settings-store.test.js`
- Test: `test/common-settings-actions.test.js`

- [ ] **Step 1: 写失败测试，锁定微信配置对象结构与迁移语义**

至少覆盖：

- 旧平铺布尔值迁移到新对象
- `primaryBinding`
- `notifications.enabled/question/permission/sessionError`
- 未来 `accounts[]` 预留位不破坏当前读取

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/common-settings-store.test.js test/common-settings-actions.test.js`
Expected: FAIL，因为微信配置结构尚未升级。

- [ ] **Step 3: 实现 store 与 action 迁移**

要求：

- 将微信配置收口成嵌套对象
- action 改为操作新对象路径
- 增加 `wechat-bind` / `wechat-rebind` / `wechat-unbind` 的语义占位

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/common-settings-store.test.js test/common-settings-actions.test.js`
Expected: PASS。

### Task 3: 把微信入口迁到通用菜单下的真正子菜单

**Files:**
- Modify: `src/ui/menu.ts`
- Modify: `src/menu-runtime.ts`
- Modify: `src/providers/copilot-menu-adapter.ts`
- Modify: `src/providers/codex-menu-adapter.ts`
- Test: `test/ui-menu-wechat.test.js`

- [ ] **Step 1: 写失败测试，锁定菜单层级与子菜单跳转**

至少覆盖：

- 微信入口出现在通用菜单下，而不是顶层独立段
- 进入微信子菜单后才看到绑定信息 / 绑定动作 / 通知开关
- 子菜单返回行为稳定

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/ui-menu-wechat.test.js`
Expected: FAIL，因为当前菜单还不是通用子菜单结构。

- [ ] **Step 3: 实现子菜单层级与 provider 调度**

要求：

- 菜单 runtime 支持子菜单跳转
- provider adapter 不直接把微信项散落在主菜单上
- 绑定入口仍是明确 action

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/ui-menu-wechat.test.js`
Expected: PASS。

### Task 4: 接通真实绑定流程与已绑定信息展示

**Files:**
- Create: `src/wechat/bind-flow.ts`
- Modify: `src/providers/copilot-menu-adapter.ts`
- Modify: `src/providers/codex-menu-adapter.ts`
- Modify: `src/ui/menu.ts`
- Modify: `src/wechat/operator-store.ts`
- Test: `test/wechat-bind-flow.test.js`
- Test: `test/ui-menu-wechat.test.js`

- [ ] **Step 1: 写失败测试，锁定真实绑定流程与绑定后展示**

至少覆盖：

- 选择 `wechat-bind` 不再直接退出
- 绑定成功后写入绑定状态
- 绑定失败有明确错误
- 菜单展示当前绑定账号信息
- 菜单不展示 `baseUrl`

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-bind-flow.test.js test/ui-menu-wechat.test.js`
Expected: FAIL，因为绑定流程与展示尚未实现。

- [ ] **Step 3: 实现 bind flow 与展示模型接线**

要求：

- `wechat-bind` / `wechat-rebind` 有真实流程
- 成功后刷新菜单展示
- 菜单展示适配后的账号信息
- 不展示内部字段

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-bind-flow.test.js test/ui-menu-wechat.test.js`
Expected: PASS。

### Task 5: Follow-up 回归验收

**Files:**
- Modify: `src/wechat/openclaw-account-adapter.ts`
- Modify: `src/common-settings-store.ts`
- Modify: `src/common-settings-actions.ts`
- Modify: `src/ui/menu.ts`
- Modify: `src/menu-runtime.ts`
- Modify: `src/providers/copilot-menu-adapter.ts`
- Modify: `src/providers/codex-menu-adapter.ts`
- Modify: `src/wechat/bind-flow.ts`
- Test: `test/wechat-openclaw-public-helpers.test.js`
- Test: `test/common-settings-store.test.js`
- Test: `test/common-settings-actions.test.js`
- Test: `test/ui-menu-wechat.test.js`
- Test: `test/wechat-bind-flow.test.js`

- [ ] **Step 1: 跑 follow-up 定向测试集合**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js test/common-settings-store.test.js test/common-settings-actions.test.js test/ui-menu-wechat.test.js test/wechat-bind-flow.test.js`
Expected: PASS。

- [ ] **Step 2: 跑 JITI 入口与现有微信回归**

Run: `npm run build && node --test test/wechat-openclaw-smoke.test.js test/wechat-openclaw-guided-smoke.test.js test/wechat-openclaw-task3.test.js test/wechat-status-flow.test.js test/wechat-broker-lifecycle.test.js test/wechat-session-digest.test.js test/wechat-plugin-hooks-status.test.js`
Expected: PASS。

- [ ] **Step 3: 检查 diff 边界**

Run: `git diff -- src/wechat/openclaw-account-adapter.ts src/common-settings-store.ts src/common-settings-actions.ts src/ui/menu.ts src/menu-runtime.ts src/providers/copilot-menu-adapter.ts src/providers/codex-menu-adapter.ts src/wechat/bind-flow.ts test/wechat-openclaw-public-helpers.test.js test/common-settings-store.test.js test/common-settings-actions.test.js test/ui-menu-wechat.test.js test/wechat-bind-flow.test.js`
Expected: 只包含菜单层级、真实绑定、信息展示与多账号结构预留，不包含完整通知系统或多账号推送策略本身。

## 完成判定

只有同时满足以下条件，这份 follow-up plan 对应的工作才算完成：

1. 微信入口位于通用菜单下的真正子菜单。
2. `wechat-bind` 进入真实绑定流程，而不是直接返回。
3. 绑定成功后会展示当前已绑定微信账号的核心信息。
4. 菜单不展示 `baseUrl` 等内部字段。
5. 微信配置结构已为未来多账号绑定 / 推送预留空间。
6. 设计与实现都显式考虑了 `@tencent-weixin/openclaw-weixin@2.0.1`。
