# Codex Provider Structure Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把插件结构收敛到“薄 provider descriptor + 共享 retry 引擎骨架 + Copilot-specific retry policy”，为未来 `/codex-status` 与 Codex retry 扩展留出稳定接口，但当前不落地 Codex 实际功能。

**Architecture:** 当前实现分两条线推进：一条是引入最小 provider descriptor / registry，只负责 provider 装配与能力声明；另一条是把现有 `copilot-network-retry` 拆成 shared retry engine 与 Copilot-specific classifier / repair policy。整个过程优先保证 Copilot 行为不回退，不把 Codex 接到 Copilot 的 header/routing 语义链上。

**Tech Stack:** TypeScript, Node test runner, existing plugin hooks, current Copilot retry implementation

---

## 文件结构与职责映射

### 新增

- `src/providers/descriptor.ts`
  - 定义 provider descriptor / capability 形状

- `src/providers/registry.ts`
  - 组织当前已注册 provider 的入口描述

- `src/retry/shared-engine.ts`
  - 共享 retry 调度骨架、fail-open、notifier 接口边界

- `src/retry/copilot-policy.ts`
  - 从现有 Copilot retry 中拆出的 provider-specific classifier / repair policy

### 修改

- `src/copilot-network-retry.ts`
  - 收缩为 Copilot 适配入口或桥接层，避免继续承载全部共享逻辑

- `src/plugin-hooks.ts`
  - 接入 provider descriptor / shared retry engine，但保持现有 Copilot 行为不变

- `test/copilot-network-retry.test.js`
  - 拆出 shared engine contract 与 Copilot-specific policy 断言

- `test/plugin.test.js`
  - 补 provider descriptor / 装配层不回退测试

---

### Task 1: 先锁定“只做结构调整、不改 Copilot 行为”的红灯测试

**Files:**
- Modify: `test/copilot-network-retry.test.js`
- Modify: `test/plugin.test.js`

- [ ] **Step 1: 为 provider descriptor 装配层写失败测试**

```js
test("provider registry exposes copilot descriptor without changing current plugin wiring", async () => {})
test("provider descriptor capabilities gate future provider-specific features without enabling codex yet", async () => {})
```

- [ ] **Step 2: 为 shared retry engine / Copilot policy 分层写失败测试**

```js
test("shared retry engine contract can drive Copilot retry without changing existing outcomes", async () => {})
test("copilot-specific retry policy remains responsible for Copilot-only classifier and repair behavior", async () => {})
```

- [ ] **Step 3: 跑聚焦测试确认红灯**

Run:

```bash
node --test test/copilot-network-retry.test.js test/plugin.test.js
```

Expected: FAIL，且失败点落在 descriptor / shared-engine / copilot-policy 尚未拆分，而不是测试语法错误。

---

### Task 2: 引入最薄 provider descriptor / registry

**Files:**
- Create: `src/providers/descriptor.ts`
- Create: `src/providers/registry.ts`
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 定义 provider descriptor 的最小形状**

```ts
export type ProviderDescriptor = {
  key: string
  providerIDs: string[]
  storeNamespace: string
  commands: string[]
  menuEntries: string[]
  capabilities: {
    status: boolean
    retry: boolean
  }
}
```

- [ ] **Step 2: 只注册当前 Copilot descriptor**

```ts
export const providerRegistry = {
  copilot: { ... },
}
```

- [ ] **Step 3: 在 plugin 装配层改用 descriptor 读能力，不改变当前行为**

- [ ] **Step 4: 跑 descriptor 聚焦测试确认转绿**

Run:

```bash
node --test test/plugin.test.js --test-name-pattern "descriptor|provider registry"
```

Expected: PASS

---

### Task 3: 抽出 shared retry engine 骨架

**Files:**
- Create: `src/retry/shared-engine.ts`
- Modify: `src/copilot-network-retry.ts`
- Test: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 先把纯共享部分搬到 shared engine**

共享候选包括：

- retry 调度
- fail-open 包装
- notifier 调用时机
- session patch/cleanup 调用边界
- 大部分通用错误归一化与重试判定
- provider policy 回调接口

- [ ] **Step 2: 让 `src/copilot-network-retry.ts` 先变成 shared engine 的 Copilot 入口封装**

```ts
return createSharedRetryEngine({
  policy: createCopilotRetryPolicy(...),
  notifier,
  ...
})
```

- [ ] **Step 3: 跑聚焦测试确认 Copilot 现有 retry 行为不回退**

- [ ] **Step 4: 把测试断言分成 shared contract 与 Copilot policy 两层，保证失败时能快速定位共享层还是 provider 特例**

Run:

```bash
node --test test/copilot-network-retry.test.js
```

Expected: PASS

---

### Task 4: 拆出 Copilot-specific retry policy

**Files:**
- Create: `src/retry/copilot-policy.ts`
- Modify: `src/copilot-network-retry.ts`
- Modify: `test/copilot-network-retry.test.js`

- [ ] **Step 1: 把 Copilot 专属 classifier / repair 行为移到 policy 模块**

至少包括：

- Copilot host / path 识别
- Copilot-specific rate-limit / JSONParse / 499 等判定
- Copilot-specific session patch / cleanup 触发条件

- [ ] **Step 2: 保持 shared engine 不知道 Copilot 专属错误细节**

- [ ] **Step 3: 明确把“通用错误归一化/判定”留在 shared engine，把 Copilot host/path/classifier/repair 这类差异留在 policy**

- [ ] **Step 4: 跑 retry 聚焦测试确认 shared / policy 分层后仍全绿**

Run:

```bash
node --test test/copilot-network-retry.test.js
```

Expected: PASS

---

### Task 5: 全量验证与未来 Codex 接口检查

**Files:**
- Verify all touched source/tests

- [ ] **Step 1: 跑本轮聚焦验证**

Run:

```bash
node --test test/copilot-network-retry.test.js test/plugin.test.js
```

Expected: PASS

- [ ] **Step 2: 跑全量测试**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 3: 自检以下边界**

确认：

- 当前仍未落地 `/codex-status` 实际功能
- 当前仍未把 Codex 接入 Copilot 的 header/routing 语义
- retry 大部分逻辑已收进 shared engine，Copilot-specific 只剩 policy 差异

- [ ] **Step 4: 向用户回报结果（不提交 git，除非用户另行要求）**

回报内容应包含：

- 新增/修改的抽象边界文件
- Copilot 行为是否完全不回退
- 未来接 `/codex-status` 时现在可以复用的接口点
