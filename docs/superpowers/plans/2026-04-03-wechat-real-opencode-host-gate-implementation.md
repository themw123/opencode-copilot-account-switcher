# WeChat Real Opencode Host Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一条基于真实 `opencode` 进程的 WeChat 宿主验证闸门，在隔离宿主中真实走到 `微信通知 -> 绑定 / 重绑微信`，并把原始错误文本或 `qr-wait-reached` 作为发布前证据。

**Architecture:** 先自举一个完全隔离的临时 `opencode` 宿主，再用真实插件安装语义把当前插件产物装入宿主，最后由真实 `opencode` 进程和菜单驱动层跑完整菜单链并收集结构化结果。旧的模拟型 `test:wechat-host-gate` 已删除，发布前 WeChat 宿主验证统一收敛到真实 gate。

**Tech Stack:** Node.js test runner, Bun/Opencode CLI, npm pack/install, 临时目录与进程控制, PTY/ConPTY 驱动（`@lydell/node-pty`）

---

## 文件结构预分解

### 新增文件

- `test/helpers/opencode-real-host-harness.js`
  - 负责：
    - 准备隔离宿主目录
    - 解析/准备临时 `opencode` 运行体
    - 通过真实安装命令把待测插件装入宿主
    - 启动真实 `opencode` 进程并收集 stdout/stderr/logs
    - 提供菜单驱动和最终结果归类辅助

- `test/wechat-opencode-real-host-gate.test.js`
  - 负责：
    - 锁住真实 `opencode` 宿主 gate 的关键回归
    - 覆盖 host bootstrap / plugin install / menu chain / final classification

### 修改文件

- `package.json`
  - 新增 `test:wechat-real-host-gate`
  - 调整 WeChat 发布前 gate 命令口径

- `docs/superpowers/specs/2026-04-03-wechat-real-opencode-host-gate-design.md`
  - 如命令名、阶段枚举或迁移策略与最终实现有偏差，只做最小同步修正

### 已删除的旧文件

- `test/helpers/opencode-host-harness.js`
- `test/wechat-opencode-host-gate.test.js`

说明：旧的模拟型 host gate 已直接移除，不再保留辅助入口。

## 实施约束

- 第一阶段必须使用**真实 `opencode` 进程**，不能再只停留在 `plugin.js` / `adapter` 级手工 import。
- 临时宿主必须与开发者真实 `opencode` 数据目录隔离，不能写入真实 `~/.cache/opencode`、真实配置目录或真实会话目录。
- 插件安装必须尽量复用真实 `opencode plugin <module>` 语义，而不是手工复制 `node_modules`。
- Gate 第一阶段不要求真实扫码成功；只要稳定复现原始错误或到达 `qr-wait-reached` 即可。
- 若本机没有可运行 `opencode`，不能默默跳过，必须清晰归类为 `host-bootstrap-failed`。
- 不改生产代码，除非测试侧完全无法驱动且必须新增通用入口；若遇到这种情况，先停下并说明。
- 只有用户明确要求时才创建 git commit。

## Task 1: Runtime Bootstrap 与隔离宿主根目录

**Files:**
- Create: `test/helpers/opencode-real-host-harness.js`
- Test: `test/wechat-opencode-real-host-gate.test.js`

- [ ] **Step 1: 写失败测试，锁住隔离宿主根目录与可运行 `opencode` 的最小契约**

```js
test("real host bootstrap: creates isolated opencode host root and resolves runnable opencode binary", async () => {
  const host = await createRealOpencodeHostRoot({
    repoRoot: REPO_ROOT,
    opencodePathResolver: async () => undefined,
  })

  assert.equal(host.ok, false)
  assert.equal(host.stage, "host-bootstrap-failed")
  assert.match(host.error, /opencode binary/i)
})
```

- [ ] **Step 2: 运行测试，确认它先红且失败原因正确**

Run: `node --test --test-name-pattern "real host bootstrap" test/wechat-opencode-real-host-gate.test.js`

Expected: FAIL，提示缺少 `createRealOpencodeHostRoot` 导出或 `host-bootstrap-failed` 断言未满足。

- [ ] **Step 3: 写最小实现，提供隔离宿主根目录与运行体解析**

```js
export async function createRealOpencodeHostRoot({
  repoRoot,
  mkdtempImpl = mkdtemp,
  whichOpencodeImpl = resolveOpencodeBinary,
}) {
  const hostRoot = await mkdtempImpl(path.join(os.tmpdir(), "opencode-real-host-"))

  try {
    const runtimePath = await whichOpencodeImpl()
    if (!runtimePath) {
      return {
        ok: false,
        stage: "host-bootstrap-failed",
        error: "opencode binary unavailable for real-host gate",
      }
    }

    const cacheRoot = path.join(hostRoot, "cache")
    const configRoot = path.join(hostRoot, "config")
    const dataRoot = path.join(hostRoot, "data")
    const logRoot = path.join(hostRoot, "logs")

    await Promise.all([
      mkdir(cacheRoot, { recursive: true }),
      mkdir(configRoot, { recursive: true }),
      mkdir(dataRoot, { recursive: true }),
      mkdir(logRoot, { recursive: true }),
    ])

    return {
      ok: true,
      stage: "host-bootstrap-ready",
      hostRoot,
      cacheRoot,
      configRoot,
      dataRoot,
      logRoot,
      runtimePath,
      cleanup: async () => rm(hostRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(hostRoot, { recursive: true, force: true })
    throw error
  }
}
```

- [ ] **Step 4: 重新运行测试，确认通过**

Run: `node --test --test-name-pattern "real host bootstrap" test/wechat-opencode-real-host-gate.test.js`

Expected: PASS，能清晰区分“缺少运行体”与“已准备隔离宿主”。

## Task 2: 真实插件安装路径

**Files:**
- Modify: `test/helpers/opencode-real-host-harness.js`
- Test: `test/wechat-opencode-real-host-gate.test.js`

- [ ] **Step 1: 写失败测试，锁住真实插件安装语义**

```js
test("real host install: installs packed plugin through opencode plugin command semantics", async () => {
  const result = await installPluginIntoRealHost({
    host: { runtimePath: "opencode", hostRoot: "C:/tmp/host", configRoot: "C:/tmp/host/config" },
    artifact: { tarballPath: "C:/tmp/plugin.tgz" },
    runCommandImpl: async () => ({ stdout: "", stderr: "" }),
  })

  assert.equal(result.stage, "plugin-install-ready")
})
```

- [ ] **Step 2: 运行测试，确认先红**

Run: `node --test --test-name-pattern "real host install" test/wechat-opencode-real-host-gate.test.js`

Expected: FAIL，提示 `installPluginIntoRealHost` 缺失或阶段不匹配。

- [ ] **Step 3: 写最小实现，先用真实 `opencode plugin` 命令装入 tarball**

```js
export async function installPluginIntoRealHost({ host, artifact, runCommandImpl = runCommand }) {
  const env = buildRealHostEnv(host)

  await runCommandImpl(host.runtimePath, [
    "plugin",
    artifact.tarballPath,
    "--force",
  ], {
    cwd: host.hostRoot,
    env,
    timeoutMs: 120_000,
  })

  return {
    ok: true,
    stage: "plugin-install-ready",
  }
}
```

- [ ] **Step 4: 重新运行测试，确认通过**

Run: `node --test --test-name-pattern "real host install" test/wechat-opencode-real-host-gate.test.js`

Expected: PASS，并且后续可以从临时宿主目录观察到插件已进入真实安装路径。

## Task 3: 真实进程启动与菜单驱动

**Files:**
- Modify: `test/helpers/opencode-real-host-harness.js`
- Test: `test/wechat-opencode-real-host-gate.test.js`

- [ ] **Step 1: 写失败测试，锁住真实 `opencode` 进程与完整菜单链**

```js
test("real host menu chain: drives 微信通知 -> 绑定 / 重绑微信 through real opencode process", async () => {
  const result = await runWechatBindThroughRealOpencode({
    host: fixtureHost,
    sendInputImpl: async () => {},
    readBufferImpl: async () => "",
  })

  assert.equal(result.reachedWechatMenu, true)
  assert.equal(result.reachedBindAction, true)
})
```

- [ ] **Step 2: 运行测试，确认先红**

Run: `node --test --test-name-pattern "real host menu chain" test/wechat-opencode-real-host-gate.test.js`

Expected: FAIL，因为 `runWechatBindThroughRealOpencode` 尚未实现，或无法给出菜单路径结果。

- [ ] **Step 3: 写最小实现，启动真实进程并通过 PTY/ConPTY 驱动菜单链**

```js
export async function runWechatBindThroughRealOpencode({ host }) {
  const session = await spawnRealOpencode({
    runtimePath: host.runtimePath,
    cwd: host.hostRoot,
    env: buildRealHostEnv(host),
  })

  try {
    await waitForMenuBuffer(session, /微信通知/)
    await sendKeys(session, ["ENTER"])
    await waitForMenuBuffer(session, /绑定 \/ 重绑微信/)
    await sendKeys(session, ["ENTER"])

    return {
      ok: true,
      stage: "menu-chain-reached",
      reachedWechatMenu: true,
      reachedBindAction: true,
      session,
    }
  } finally {
    await stopRealOpencode(session)
  }
}
```

- [ ] **Step 4: 重新运行测试，确认完整菜单链可达**

Run: `node --test --test-name-pattern "real host menu chain" test/wechat-opencode-real-host-gate.test.js`

Expected: PASS，能稳定走到“微信通知 -> 绑定 / 重绑微信”，且不是只靠 `stdio: pipe` 假驱动。

## Task 4: 原始错误文本/二维码等待归类

**Files:**
- Modify: `test/helpers/opencode-real-host-harness.js`
- Test: `test/wechat-opencode-real-host-gate.test.js`

- [ ] **Step 1: 写失败测试，锁住最终结果分类**

```js
test("real host classification: preserves raw wechat bind error text when host reproduces import failure", async () => {
  const result = await classifyRealOpencodeWechatBindResult({
    transcript: "wechat bind failed: Missing 'default' export in module '...json5/lib/index.js'.",
  })

  assert.equal(result.stage, "wechat-bind-import-failed")
  assert.match(result.error, /json5\/lib\/index\.js/i)
})

test("real host classification: qr wait is not reported as generic success", async () => {
  const result = await classifyRealOpencodeWechatBindResult({
    transcript: "QR URL fallback: https://host-gate.invalid/qr",
  })

  assert.equal(result.stage, "qr-wait-reached")
})
```

- [ ] **Step 2: 运行测试，确认先红**

Run: `node --test --test-name-pattern "real host classification" test/wechat-opencode-real-host-gate.test.js`

Expected: FAIL，因为分类器尚未实现或当前断言不成立。

- [ ] **Step 3: 写最小实现，把真实错误文本与二维码等待边界分类**

```js
export function classifyRealOpencodeWechatBindResult({ transcript, logText }) {
  const source = `${transcript ?? ""}
${logText ?? ""}`

  if (/wechat bind failed:/i.test(source) && /Missing 'default' export/i.test(source)) {
    return {
      ok: false,
      stage: "wechat-bind-import-failed",
      error: source,
    }
  }

  if (/wechat bind failed:/i.test(source)) {
    return {
      ok: false,
      stage: "wechat-bind-runtime-failed",
      error: source,
    }
  }

  if (/QR URL fallback:|sessionKey|qr login/i.test(source)) {
    return {
      ok: false,
      stage: "qr-wait-reached",
      error: source,
    }
  }

  return {
    ok: false,
    stage: "menu-chain-failed",
    error: source || "unknown real-host failure",
  }
}
```

- [ ] **Step 4: 重新运行测试，确认通过**

Run: `node --test --test-name-pattern "real host classification" test/wechat-opencode-real-host-gate.test.js`

Expected: PASS，能够区分导入失败、运行时失败与二维码等待边界。

## Task 5: 命令接入、文档收口与最终验证

**Files:**
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-04-03-wechat-real-opencode-host-gate-design.md`
- Test: `test/wechat-opencode-real-host-gate.test.js`

- [ ] **Step 1: 新增真实宿主 gate 命令**

```json
{
  "scripts": {
    "test:wechat-real-host-gate": "npm run build && node --test test/wechat-opencode-real-host-gate.test.js"
  }
}
```

- [ ] **Step 2: 如果实现细节与 spec 有偏差，只做最小文档收口**

```md
## 命令设计

- `npm run test:wechat-real-host-gate`

## 迁移策略

- 删除旧的 `test:wechat-host-gate` 入口，避免和真实宿主 gate 并存
- `test:wechat-real-host-gate` 替换 WeChat 发布前 gate
```

- [ ] **Step 3: 运行最终验证**

Run: `npm run build && node --test test/wechat-opencode-real-host-gate.test.js`

Expected: PASS，真实宿主 gate 主测试全绿。

Run: `npm run test:wechat-real-host-gate`

Expected: PASS，可直接作为发布前 gate 命令。

Run: `npm test`

Expected: PASS，新增真实宿主 gate 不破坏现有全量测试。

## 自检清单

- 是否真的使用了真实 `opencode` 进程 + PTY/ConPTY，而不是继续停在 `plugin.js` / `adapter` 手工 import 或 `stdio: pipe` 假驱动。
- 是否通过真实安装路径装入待测插件，而不是手工复制文件冒充安装。
- 是否已彻底移除旧的模拟型 host gate，避免继续给出双轨口径。
- 是否对原始错误文本和 `qr-wait-reached` 都有明确断言。
- 是否在没有可运行 `opencode` 时给出清晰的 `host-bootstrap-failed`，而不是默默跳过。
