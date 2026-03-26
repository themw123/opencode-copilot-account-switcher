# WeChat Compat 拆分与 2.0.1 迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将微信 compat 层拆分为按职责划分的 wrapper，同时把 `@tencent-weixin/openclaw-weixin` 迁移到 `2.0.1`，消除探测式签名兼容逻辑并保持绑定、状态、菜单行为稳定。

**Architecture:** 保留 `src/wechat/compat/openclaw-public-helpers.ts` 作为总装配层，把账号、gateway、updates/send、sync-buf 各自拆到独立 wrapper；业务层只消费仓库内部稳定接口，不再直接处理上游 helper 签名。账号读取主路径改为基于上游账号源 helper，而不是继续依赖 channel config surface。

**Tech Stack:** TypeScript, Node.js test runner, JITI, `@tencent-weixin/openclaw-weixin@2.0.1`, existing WeChat bind/status/menu runtime.

---

## File Structure

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/wechat/compat/openclaw-public-helpers.ts`
- Create: `src/wechat/compat/openclaw-public-entry.ts`
- Create: `src/wechat/compat/openclaw-account-helpers.ts`
- Create: `src/wechat/compat/openclaw-qr-gateway.ts`
- Create: `src/wechat/compat/openclaw-updates-send.ts`
- Create: `src/wechat/compat/openclaw-sync-buf.ts`
- Modify: `src/wechat/bind-flow.ts`
- Modify: `src/wechat/wechat-status-runtime.ts`
- Modify: `src/wechat/compat/openclaw-smoke.ts`
- Modify: `src/wechat/compat/openclaw-guided-smoke.ts`
- Test: `test/wechat-openclaw-public-helpers.test.js`
- Create: `test/wechat-openclaw-account-helpers.test.js`
- Create: `test/wechat-openclaw-qr-gateway.test.js`
- Create: `test/wechat-openclaw-updates-send.test.js`
- Create: `test/wechat-openclaw-sync-buf.test.js`
- Test: `test/wechat-bind-flow.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/ui-menu-wechat.test.js`

### Task 1: 升级依赖并锁定 2.0.1 迁移基线

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/wechat-openclaw-public-helpers.test.js`

- [ ] **Step 1: 写失败测试，锁定“只接受 2.0.1 真实签名”的装配预期**

```js
test("public helper loader assembles wrappers without function-length probing", async () => {
  const helpers = await import("../dist/wechat/compat/openclaw-public-helpers.js")
  const loaded = await helpers.loadOpenClawWeixinPublicHelpers({
    loadPublicWeixinQrGateway: async () => ({
      gateway: {
        loginWithQrStart: async (params) => ({ sessionKey: params?.accountId ?? "s" }),
        loginWithQrWait: async (params) => ({ connected: true, accountId: params?.accountId ?? "acc" }),
      },
      pluginId: "wechat-2x",
    }),
    loadPublicWeixinAccountHelpers: async () => ({
      listAccountIds: async () => ["acc-2x"],
      resolveAccount: async (accountId) => ({ accountId, enabled: true }),
      describeAccount: async (accountIdOrInput) => ({
        accountId: typeof accountIdOrInput === "string" ? accountIdOrInput : accountIdOrInput.accountId,
        configured: true,
      }),
    }),
  })

  assert.equal(loaded.pluginId, "wechat-2x")
  assert.equal(typeof loaded.accountHelpers.resolveAccount, "function")
})
```

- [ ] **Step 2: 运行测试，确认当前实现因 compat 仍内联协议逻辑而失败或不满足目标边界**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js`
Expected: 新增用例失败，或现有测试无法表达“装配层只装配不猜协议”的目标。

- [ ] **Step 3: 升级依赖到 2.0.1**

```json
{
  "dependencies": {
    "@tencent-weixin/openclaw-weixin": "2.0.1"
  }
}
```

Run: `npm install`

- [ ] **Step 4: 更新装配测试，让它以 2.0.1 为唯一目标版本**

```js
assert.deepEqual(helpers.OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES, {
  stateDir: "@tencent-weixin/openclaw-weixin/src/storage/state-dir.ts",
  syncBuf: "@tencent-weixin/openclaw-weixin/src/storage/sync-buf.ts",
  getUpdates: "@tencent-weixin/openclaw-weixin/src/api/api.ts",
  sendMessageWeixin: "@tencent-weixin/openclaw-weixin/src/messaging/send.ts",
})
```

- [ ] **Step 5: 运行测试确认基线通过**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js`
Expected: PASS，且依赖锁文件已更新到 `2.0.1`。

- [ ] **Step 6: 提交依赖升级基线**

```bash
git add package.json package-lock.json test/wechat-openclaw-public-helpers.test.js
git commit -m "chore(wechat): 升级 openclaw-weixin 到 2.0.1"
```

### Task 2: 拆出账号 wrapper 并切换到上游账号源 helper

**Files:**
- Create: `src/wechat/compat/openclaw-account-helpers.ts`
- Modify: `src/wechat/compat/openclaw-public-helpers.ts`
- Create: `test/wechat-openclaw-account-helpers.test.js`
- Modify: `test/wechat-openclaw-public-helpers.test.js`

- [ ] **Step 1: 写失败测试，锁定账号 wrapper 的稳定输出**

```js
test("account helper wrapper reads account source helpers and returns stable account info", async () => {
  const mod = await import("../dist/wechat/compat/openclaw-account-helpers.js")

  const helpers = mod.createOpenClawAccountHelpers({
    listAccountIds: () => ["acc-real"],
    loadAccount: () => ({ token: "token", baseUrl: "https://ilinkai.weixin.qq.com", userId: "user-real" }),
    resolveAccount: () => ({ accountId: "acc-real", enabled: true, configured: true, name: "Real" }),
  })

  assert.deepEqual(await helpers.listAccountIds(), ["acc-real"])
  assert.deepEqual(await helpers.resolveAccount("acc-real"), {
    accountId: "acc-real",
    enabled: true,
    configured: true,
    name: "Real",
    userId: "user-real",
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && node --test test/wechat-openclaw-account-helpers.test.js`
Expected: FAIL，提示缺少新模块或导出。

- [ ] **Step 3: 写最小账号 wrapper**

```ts
export function createOpenClawAccountHelpers(input: {
  listAccountIds: () => string[] | Promise<string[]>
  loadAccount: (accountId: string) => unknown | Promise<unknown>
  resolveAccount: (accountId: string) => unknown | Promise<unknown>
}) {
  return {
    async listAccountIds() {
      const ids = await input.listAccountIds()
      return Array.isArray(ids) ? ids.filter((it): it is string => typeof it === "string" && it.length > 0) : []
    },
    async resolveAccount(accountId: string) {
      const resolved = await input.resolveAccount(accountId) as Record<string, unknown>
      const stored = await input.loadAccount(accountId) as Record<string, unknown>
      return {
        accountId,
        enabled: resolved.enabled !== false,
        configured: Boolean(resolved.configured ?? stored.token),
        name: typeof resolved.name === "string" ? resolved.name : undefined,
        userId: typeof stored.userId === "string" ? stored.userId : undefined,
      }
    },
  }
}
```

- [ ] **Step 4: 在装配层改为使用账号 wrapper，而不是 channel config surface**

```ts
const accountHelpers = await loadOpenClawAccountHelpers({
  stateDirModulePath: OPENCLAW_WEIXIN_JITI_SRC_HELPER_MODULES.stateDir,
})
```

- [ ] **Step 5: 运行账号与装配测试确认通过**

Run: `npm run build && node --test test/wechat-openclaw-account-helpers.test.js test/wechat-openclaw-public-helpers.test.js`
Expected: PASS

- [ ] **Step 6: 提交账号 wrapper**

```bash
git add src/wechat/compat/openclaw-account-helpers.ts src/wechat/compat/openclaw-public-helpers.ts test/wechat-openclaw-account-helpers.test.js test/wechat-openclaw-public-helpers.test.js
git commit -m "refactor(wechat): 拆分账号 compat wrapper"
```

### Task 3: 拆出 gateway、updates/send、sync-buf wrapper

**Files:**
- Create: `src/wechat/compat/openclaw-public-entry.ts`
- Create: `src/wechat/compat/openclaw-qr-gateway.ts`
- Create: `src/wechat/compat/openclaw-updates-send.ts`
- Create: `src/wechat/compat/openclaw-sync-buf.ts`
- Modify: `src/wechat/compat/openclaw-public-helpers.ts`
- Create: `test/wechat-openclaw-qr-gateway.test.js`
- Create: `test/wechat-openclaw-updates-send.test.js`
- Create: `test/wechat-openclaw-sync-buf.test.js`

- [ ] **Step 1: 写 gateway wrapper 失败测试**

```js
test("qr gateway wrapper requires object params and returns stable bind payload", async () => {
  const mod = await import("../dist/wechat/compat/openclaw-qr-gateway.js")
  const gateway = mod.createOpenClawQrGateway({
    loginWithQrStart: async (params) => ({ sessionKey: params.accountId ?? "s", qrDataUrl: "data:image/png;base64,abc" }),
    loginWithQrWait: async (params) => ({ connected: true, accountId: params.accountId ?? "acc" }),
  })

  const started = await gateway.loginWithQrStart({ accountId: "acc-2x" })
  const waited = await gateway.loginWithQrWait({ accountId: "acc-2x" })

  assert.equal(started.sessionKey, "acc-2x")
  assert.equal(waited.accountId, "acc-2x")
})
```

- [ ] **Step 2: 写 updates/send/sync-buf 失败测试**

```js
test("updates/send/sync-buf wrappers expose only runtime-safe fields", async () => {
  const mod = await import("../dist/wechat/compat/openclaw-updates-send.js")
  const sync = await import("../dist/wechat/compat/openclaw-sync-buf.js")

  assert.equal(typeof mod.createOpenClawUpdatesHelper, "function")
  assert.equal(typeof mod.createOpenClawSendHelper, "function")
  assert.equal(typeof sync.createOpenClawSyncBufHelper, "function")
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run build && node --test test/wechat-openclaw-qr-gateway.test.js test/wechat-openclaw-updates-send.test.js test/wechat-openclaw-sync-buf.test.js`
Expected: FAIL，提示缺少新模块或导出。

- [ ] **Step 4: 实现最小 wrapper 并把公共入口抽到单独文件**

```ts
export async function loadRegisteredWeixinPluginPayloads(): Promise<Array<{ plugin?: unknown }>> {
  const plugin = await loadOpenClawWeixinDefaultExport()
  const payloads: Array<{ plugin?: unknown }> = []
  plugin.register({
    runtime: { channelRuntime: { mode: "guided-smoke" }, gateway: { startAccount: { source: "guided-smoke" } } },
    registerChannel(payload) { payloads.push(payload as { plugin?: unknown }) },
    registerCli() {},
  })
  return payloads
}
```

- [ ] **Step 5: 让 `openclaw-public-helpers.ts` 只做装配**

```ts
const entry = await resolveOpenClawWeixinPublicEntry()
const payloads = await loadRegisteredWeixinPluginPayloads()
const qrGateway = await loadOpenClawQrGateway(payloads)
const accountHelpers = await loadOpenClawAccountHelpers()
const updatesSend = await loadOpenClawUpdatesAndSendHelpers()
const syncBuf = await loadOpenClawSyncBufHelper()
```

- [ ] **Step 6: 运行 wrapper 与装配测试确认通过**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js test/wechat-openclaw-qr-gateway.test.js test/wechat-openclaw-updates-send.test.js test/wechat-openclaw-sync-buf.test.js`
Expected: PASS

- [ ] **Step 7: 提交 compat 拆分**

```bash
git add src/wechat/compat/openclaw-public-entry.ts src/wechat/compat/openclaw-qr-gateway.ts src/wechat/compat/openclaw-updates-send.ts src/wechat/compat/openclaw-sync-buf.ts src/wechat/compat/openclaw-public-helpers.ts test/wechat-openclaw-public-helpers.test.js test/wechat-openclaw-qr-gateway.test.js test/wechat-openclaw-updates-send.test.js test/wechat-openclaw-sync-buf.test.js
git commit -m "refactor(wechat): 拆分 compat 装配与运行时 wrapper"
```

### Task 4: 切换业务层到稳定接口并补回归

**Files:**
- Modify: `src/wechat/bind-flow.ts`
- Modify: `src/wechat/wechat-status-runtime.ts`
- Modify: `src/wechat/compat/openclaw-smoke.ts`
- Modify: `src/wechat/compat/openclaw-guided-smoke.ts`
- Modify: `test/wechat-bind-flow.test.js`
- Modify: `test/wechat-status-flow.test.js`
- Modify: `test/ui-menu-wechat.test.js`

- [ ] **Step 1: 写失败测试，锁定业务层不再依赖上游 helper shape**

```js
test("wechat bind flow uses stable compat account helpers only", async () => {
  const { runWechatBindFlow } = await import("../dist/wechat/bind-flow.js")

  const result = await runWechatBindFlow({
    action: "wechat-bind",
    loadPublicHelpers: async () => ({
      latestAccountState: { accountId: "acc-stable", token: "token", baseUrl: "https://internal.example" },
      qrGateway: {
        loginWithQrStart: async () => ({ sessionKey: "s", qrUrl: "https://example.test/qr" }),
        loginWithQrWait: async () => ({ connected: true, accountId: "acc-stable" }),
      },
      accountHelpers: {
        listAccountIds: async () => ["acc-stable"],
        resolveAccount: async () => ({ accountId: "acc-stable", enabled: true, configured: true, userId: "user-stable" }),
        describeAccount: async () => ({ accountId: "acc-stable", configured: true, userId: "user-stable" }),
      },
    }),
    bindOperator: async (binding) => binding,
    readCommonSettings: async () => ({ wechat: { notifications: { enabled: true, question: true, permission: true, sessionError: true } } }),
    writeCommonSettings: async () => {},
    now: () => 1718000000000,
  })

  assert.equal(result.userId, "user-stable")
})
```

- [ ] **Step 2: 运行相关回归确认当前尚未全部通过或仍依赖旧兼容路径**

Run: `npm run build && node --test test/wechat-bind-flow.test.js test/wechat-status-flow.test.js test/ui-menu-wechat.test.js`
Expected: 至少一条新增回归失败，或需要调整业务调用点。

- [ ] **Step 3: 将业务文件改为只消费稳定接口**

```ts
const helpers = await loadOpenClawWeixinPublicHelpers()
const menuAccount = await buildOpenClawMenuAccount({
  latestAccountState: helpers.latestAccountState,
  accountHelpers: helpers.accountHelpers,
})
```

- [ ] **Step 4: 扩展业务回归，覆盖真实 bug 与 2.0.1 契约**

```js
await assert.rejects(
  () => runWechatBindFlow({ /* 缺 accountId 场景 mock */ }),
  /missing accountId after qr login/i,
)
```

- [ ] **Step 5: 运行业务回归确认通过**

Run: `npm run build && node --test test/wechat-bind-flow.test.js test/wechat-status-flow.test.js test/ui-menu-wechat.test.js`
Expected: PASS

- [ ] **Step 6: 提交业务接线迁移**

```bash
git add src/wechat/bind-flow.ts src/wechat/wechat-status-runtime.ts src/wechat/compat/openclaw-smoke.ts src/wechat/compat/openclaw-guided-smoke.ts test/wechat-bind-flow.test.js test/wechat-status-flow.test.js test/ui-menu-wechat.test.js
git commit -m "refactor(wechat): 切换业务层到稳定 compat 接口"
```

### Task 5: 跑完整验证并清理旧逻辑

**Files:**
- Modify: `src/wechat/compat/openclaw-public-helpers.ts`
- Test: `test/wechat-openclaw-public-helpers.test.js`
- Test: `test/wechat-openclaw-account-helpers.test.js`
- Test: `test/wechat-openclaw-qr-gateway.test.js`
- Test: `test/wechat-openclaw-updates-send.test.js`
- Test: `test/wechat-openclaw-sync-buf.test.js`
- Test: `test/wechat-bind-flow.test.js`
- Test: `test/wechat-status-flow.test.js`
- Test: `test/ui-menu-wechat.test.js`

- [ ] **Step 1: 删除残余的探测式兼容逻辑**

```ts
// 删除类似逻辑：
rawAccountHelpers.resolveAccount.length >= 2
accountHelpers.listAccountIds.length >= 1
```

- [ ] **Step 2: 用测试锁定“不再允许 function.length 探测”**

```js
test("public helper assembly no longer depends on function-length probing", async () => {
  const source = await import("../dist/wechat/compat/openclaw-public-helpers.js")
  assert.equal("normalizeWeixinAccountHelpers" in source, false)
})
```

- [ ] **Step 3: 运行 focused test 套件**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js test/wechat-openclaw-account-helpers.test.js test/wechat-openclaw-qr-gateway.test.js test/wechat-openclaw-updates-send.test.js test/wechat-openclaw-sync-buf.test.js`
Expected: PASS

- [ ] **Step 4: 运行完整微信相关回归**

Run: `npm run build && node --test test/wechat-openclaw-public-helpers.test.js test/wechat-openclaw-account-helpers.test.js test/wechat-openclaw-qr-gateway.test.js test/wechat-openclaw-updates-send.test.js test/wechat-openclaw-sync-buf.test.js test/wechat-bind-flow.test.js test/wechat-status-flow.test.js test/ui-menu-wechat.test.js`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认没有外溢回归**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 提交最终清理**

```bash
git add src/wechat/compat/openclaw-public-helpers.ts test/wechat-openclaw-public-helpers.test.js test/wechat-openclaw-account-helpers.test.js test/wechat-openclaw-qr-gateway.test.js test/wechat-openclaw-updates-send.test.js test/wechat-openclaw-sync-buf.test.js
git commit -m "test(wechat): 补齐 2.0.1 compat 回归覆盖"
```
