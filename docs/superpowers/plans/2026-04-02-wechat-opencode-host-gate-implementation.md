# WeChat Opencode Host Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 WeChat `wechat-bind` 增加一条高保真宿主验证闸门，在本地以接近 Opencode/Bun + 已发布插件包的方式复现并分类 `provider adapter -> wechat-bind -> bind-flow -> compat helper` 链路。

**Architecture:** 先在测试侧实现一个四层 harness：产物层负责生成待测发布物，cache layout 层负责搭临时 opencode-like 安装目录，plugin load 层负责用 Bun 风格加载已安装插件，scenario driver 层负责真实触发 `wechat-bind` 并把失败归类成模块加载、provider 路由、compat helper 装配或业务失败。第一阶段优先不改生产代码，而是通过已发布形态 `dist/` 文件与临时安装目录来驱动真实路径；只有当测试侧完全无法驱动真实链路时，才允许补最小、通用的测试友好入口。

**Tech Stack:** Node.js test runner、Bun CLI、`node:fs/promises`、`node:child_process`、现有 `dist/` 产物、`src/providers/*-menu-adapter.ts`、`src/wechat/bind-flow.ts`

---

## 文件结构预分解

### 新增文件

- `test/helpers/opencode-host-harness.js`
  - 负责：打包当前插件、搭临时 opencode-like cache layout、调用 Bun、收集结构化阶段结果。
- `test/wechat-opencode-host-gate.test.js`
  - 负责：串起整条 host gate，验证产物安装、插件加载、provider 路由、bind-flow 到达 compat helper 装配，并区分失败阶段。

### 修改文件

- `package.json`
  - 新增 `test:wechat-host-gate` 脚本。
- 如实现中发现文件路径或分类名与 spec 有微调：
  - `docs/superpowers/specs/2026-04-02-wechat-opencode-host-gate-design.md`
  - 仅在最终命令名、文件名或阶段分类发生变化时同步修正文档。

### 只读参考文件

- `src/providers/copilot-menu-adapter.ts`
- `src/providers/codex-menu-adapter.ts`
- `src/wechat/bind-flow.ts`
- `src/plugin.ts`
- `src/internal.ts`
- `test/plugin.test.js`
- `test/wechat-bind-flow.test.js`

## 实施约束

1. 先做测试侧 harness，不先改生产代码。
2. 产物输入必须来自当前仓库已构建的发布形态，而不是直接从 `src/` 目录把源码当插件装载。
3. Gate 第一阶段不接真实微信账号；只要求稳定到达 compat helper 装配边界，并能正确分类失败。
4. Gate 必须至少区分：`module-load`、`provider-route`、`compat-assembly`、`business-error`。
5. 只有用户明确要求时才创建 git commit；本计划不默认要求提交。

## Task 1: Artifact 与 Cache Layout Harness

**Files:**
- Create: `test/helpers/opencode-host-harness.js`
- Test: `test/wechat-opencode-host-gate.test.js`

- [ ] **Step 1: 先写失败测试，锁住“真实发布物 + 临时 cache layout”最小闭环**

```js
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createHostArtifact, createOpencodeLikeCacheLayout } from "./helpers/opencode-host-harness.js"

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

test("host gate artifact: packs current plugin and installs it into temporary opencode-like cache layout", async () => {
  const artifact = await createHostArtifact({
    repoRoot: REPO_ROOT,
  })

  assert.match(artifact.tarballPath, /opencode-copilot-account-switcher-.*\.tgz$/)

  const layout = await createOpencodeLikeCacheLayout({
    artifact,
  })

  assert.match(layout.cacheRoot, /opencode-host-gate/i)
  assert.equal(
    layout.cachePackageJson.dependencies["opencode-copilot-account-switcher"],
    `file:./artifacts/${path.basename(artifact.tarballPath)}`,
  )
  assert.equal(typeof layout.installedPluginRoot, "string")
  assert.equal(layout.installedPluginPackage.name, "opencode-copilot-account-switcher")
  assert.ok(layout.installedPluginDistExists)
})
```

- [ ] **Step 2: 运行测试，确认它先红在 harness 缺失**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js --test-name-pattern "artifact"`

Expected: FAIL，报 `Cannot find module './helpers/opencode-host-harness.js'` 或 `createHostArtifact is not a function` 一类错误，而不是业务断言通过。

- [ ] **Step 3: 实现最小 harness，负责 pack 当前包并搭临时 opencode-like cache layout**

```js
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...options,
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`))
    })
  })
}

export async function createHostArtifact({ repoRoot }) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-artifact-"))
  const { stdout } = await runCommand("npm", ["pack", "--json", "--pack-destination", tempRoot], {
    cwd: repoRoot,
  })
  const [packResult] = JSON.parse(stdout)
  return {
    tempRoot,
    tarballPath: path.join(tempRoot, packResult.filename),
    cleanup: async () => rm(tempRoot, { recursive: true, force: true }),
  }
}

export async function createOpencodeLikeCacheLayout({ artifact }) {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-host-gate-cache-"))
  const artifactsDir = path.join(cacheRoot, "artifacts")
  await mkdir(artifactsDir, { recursive: true })
  const tarballName = path.basename(artifact.tarballPath)
  const stagedTarballPath = path.join(artifactsDir, tarballName)
  await copyFile(artifact.tarballPath, stagedTarballPath)
  const packageJsonPath = path.join(cacheRoot, "package.json")
  const packageJson = {
    private: true,
    type: "module",
    dependencies: {
      "opencode-copilot-account-switcher": `file:./artifacts/${tarballName}`,
    },
  }
  await mkdir(cacheRoot, { recursive: true })
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf8")
  await runCommand("npm", ["install"], { cwd: cacheRoot })

  const installedPluginRoot = path.join(cacheRoot, "node_modules", "opencode-copilot-account-switcher")
  const installedPluginPackage = JSON.parse(await readFile(path.join(installedPluginRoot, "package.json"), "utf8"))
  return {
    cacheRoot,
    cachePackageJson: packageJson,
    installedPluginRoot,
    installedPluginPackage,
    installedPluginDistExists: true,
    cleanup: async () => rm(cacheRoot, { recursive: true, force: true }),
  }
}
```

- [ ] **Step 4: 复跑最小测试，确认 Artifact/Cache Layout 绿灯**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js --test-name-pattern "artifact"`

Expected: PASS，能拿到 tarball、临时 cache 根目录、`node_modules/opencode-copilot-account-switcher/package.json`。

## Task 2: Bun 风格 Plugin Load 层

**Files:**
- Modify: `test/helpers/opencode-host-harness.js`
- Modify: `test/wechat-opencode-host-gate.test.js`

- [ ] **Step 1: 先写失败测试，锁住“Bun 风格宿主能加载已安装插件入口”**

```js
test("host gate plugin-load: bun-style host can import installed plugin entry and internal helper entry", async () => {
  const artifact = await createHostArtifact({ repoRoot: REPO_ROOT })
  const layout = await createOpencodeLikeCacheLayout({ artifact })

  const result = await loadInstalledPluginInBunStyle({
    cacheRoot: layout.cacheRoot,
  })

  assert.equal(result.ok, true)
  assert.equal(result.stage, "plugin-load")
  assert.equal(result.pluginPackageName, "opencode-copilot-account-switcher")
  assert.equal(result.internalHasBuildPluginHooks, true)
})
```

- [ ] **Step 2: 跑测试，确认先红在 `loadInstalledPluginInBunStyle` 缺失**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js --test-name-pattern "plugin-load"`

Expected: FAIL，报 `loadInstalledPluginInBunStyle is not a function` 或等价缺失错误。

- [ ] **Step 3: 在 harness 里实现 Bun 风格加载层，直接从临时 cache 的已安装包导入入口**

```js
export async function loadInstalledPluginInBunStyle({ cacheRoot }) {
  const script = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const cacheRoot = process.argv[2];
    const packageRoot = path.join(cacheRoot, "node_modules", "opencode-copilot-account-switcher");
    const pluginEntry = pathToFileURL(path.join(packageRoot, "dist", "index.js")).href;
    const internalEntry = pathToFileURL(path.join(packageRoot, "dist", "internal.js")).href;

    try {
      const pluginMod = await import(pluginEntry);
      const internalMod = await import(internalEntry);
      const payload = {
        ok: true,
        stage: "plugin-load",
        pluginPackageName: "opencode-copilot-account-switcher",
        internalHasBuildPluginHooks: typeof internalMod.buildPluginHooks === "function",
        rootHasDefault: Boolean(pluginMod.default),
      };
      console.log(JSON.stringify(payload));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        stage: "module-load",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `

  const { stdout } = await runCommand("bun", ["--eval", script, cacheRoot], { cwd: cacheRoot })
  return JSON.parse(stdout.trim())
}
```

- [ ] **Step 4: 复跑测试，确认 plugin load 层绿灯**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js --test-name-pattern "plugin-load"`

Expected: PASS，返回 `{ ok: true, stage: "plugin-load" }`，并确认 `internal.buildPluginHooks` 可见。

## Task 3: `wechat-bind` Scenario Driver 与阶段分类

**Files:**
- Modify: `test/helpers/opencode-host-harness.js`
- Modify: `test/wechat-opencode-host-gate.test.js`

- [ ] **Step 1: 先写失败测试，锁住“至少能走到 provider adapter -> wechat-bind -> bind-flow”**

```js
test("host gate scenario: provider adapter routes to wechat-bind and reaches compat-assembly boundary", async () => {
  const artifact = await createHostArtifact({ repoRoot: REPO_ROOT })
  const layout = await createOpencodeLikeCacheLayout({ artifact })

  const result = await runWechatBindScenario({
    cacheRoot: layout.cacheRoot,
  })

  assert.equal(result.stage === "compat-assembly" || result.stage === "business-error", true)
  assert.equal(result.reachedProviderRoute, true)
  assert.equal(result.reachedBindFlow, true)
})
```

- [ ] **Step 2: 运行测试，确认先红在 Scenario Driver 缺失或旧分类不够细**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js --test-name-pattern "scenario"`

Expected: FAIL，报 `runWechatBindScenario is not a function`，或阶段分类与断言不匹配。

- [ ] **Step 3: 在 harness 里实现最小场景驱动，并通过安装目录内文件替换构造 deterministic compat 装配边界**

```js
import { readFile, writeFile } from "node:fs/promises"

async function patchInstalledCompatLoader({ installedPluginRoot }) {
  const target = path.join(installedPluginRoot, "dist", "wechat", "compat", "openclaw-public-helpers.js")
  const original = await readFile(target, "utf8")
  const replacement = `
    export async function loadOpenClawWeixinPublicHelpers() {
      globalThis.__wechatHostGateProbe = {
        reachedCompatAssembly: true,
      };
      return {
        entry: {},
        pluginId: "host-gate-plugin",
        qrGateway: {
          async loginWithQrStart() {
            return { qrTerminal: "HOST-GATE-QR", sessionKey: "host-gate-session" };
          },
          async loginWithQrWait() {
            throw new Error("host-gate-stop-after-compat-assembly");
          },
        },
        accountHelpers: {
          async listAccountIds() { return []; },
          async resolveAccount(accountId) { return { accountId, enabled: true, configured: true }; },
          async describeAccount(input) {
            const accountId = typeof input === "string" ? input : input.accountId;
            return { accountId, enabled: true, configured: true, userId: "host-gate-user" };
          },
        },
        latestAccountState: null,
        async getUpdates() { return {}; },
        async sendMessageWeixin() { return { messageId: "noop" }; },
      };
    }
  `
  await writeFile(target, replacement, "utf8")
  return async () => writeFile(target, original, "utf8")
}

export async function runWechatBindScenario({ cacheRoot }) {
  const installedPluginRoot = path.join(cacheRoot, "node_modules", "opencode-copilot-account-switcher")
  const restoreCompat = await patchInstalledCompatLoader({ installedPluginRoot })
  const script = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const cacheRoot = process.argv[2];
    const packageRoot = path.join(cacheRoot, "node_modules", "opencode-copilot-account-switcher");
    const adapterEntry = pathToFileURL(path.join(packageRoot, "dist", "providers", "copilot-menu-adapter.js")).href;

    const adapterMod = await import(adapterEntry);
    const adapter = adapterMod.createCopilotMenuAdapter({
      client: {},
      readCommonSettings: async () => ({
        wechat: {
          notifications: { enabled: true, question: true, permission: true, sessionError: true },
        },
      }),
      writeCommonSettings: async () => {},
      readStore: async () => ({ active: undefined, accounts: {}, networkRetryEnabled: true, loopSafetyEnabled: false }),
      writeStore: async () => {},
      readAuthEntries: async () => ({}),
      promptText: async () => "",
    });

    try {
      await adapter.applyAction?.(
        { active: undefined, accounts: {}, networkRetryEnabled: true, loopSafetyEnabled: false },
        { type: "provider", name: "wechat-bind" },
      );
      console.log(JSON.stringify({ ok: false, stage: "provider-route", error: "wechat-bind unexpectedly completed" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reachedCompatAssembly = globalThis.__wechatHostGateProbe?.reachedCompatAssembly === true;
      console.log(JSON.stringify({
        ok: false,
        stage: reachedCompatAssembly ? "compat-assembly" : "business-error",
        reachedProviderRoute: true,
        reachedBindFlow: true,
        error: message,
      }));
    }
  `

  try {
    const { stdout } = await runCommand("bun", ["--eval", script, cacheRoot], { cwd: cacheRoot })
    return JSON.parse(stdout.trim())
  } finally {
    await restoreCompat()
  }
}
```

- [ ] **Step 4: 复跑场景测试，确认能稳定到达 compat 装配边界并给出结构化阶段结果**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js --test-name-pattern "scenario"`

Expected: PASS，返回 `reachedProviderRoute: true`、`reachedBindFlow: true`，并在 `stage` 上明确落到 `compat-assembly` 或 `business-error`。

## Task 4: 真实模块失败归类与 release gate 命令接入

**Files:**
- Modify: `test/helpers/opencode-host-harness.js`
- Modify: `test/wechat-opencode-host-gate.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试，锁住“真实模块解析错误必须在 gate 里被直接归类”**

```js
test("host gate classification: real compat failure is reported as compat-assembly instead of generic test failure", async () => {
  const artifact = await createHostArtifact({ repoRoot: REPO_ROOT })
  const layout = await createOpencodeLikeCacheLayout({ artifact })

  const result = await runWechatBindScenario({
    cacheRoot: layout.cacheRoot,
    usePatchedCompat: false,
  })

  assert.equal(result.ok, false)
  assert.equal(result.stage === "module-load" || result.stage === "compat-assembly" || result.stage === "business-error", true)
  assert.equal(typeof result.error, "string")
})
```

- [ ] **Step 2: 运行测试，确认先红在 `usePatchedCompat: false` 分支未实现或分类不准**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js --test-name-pattern "classification"`

Expected: FAIL，报未实现或阶段不匹配，而不是直接通过。

- [ ] **Step 3: 扩展 harness 支持真实 compat 分支，并把新 gate 接到 npm script**

```js
// package.json
{
  "scripts": {
    "test:wechat-host-gate": "npm run build && node --test test/wechat-opencode-host-gate.test.js"
  }
}
```

```js
// test/helpers/opencode-host-harness.js 中的 runWechatBindScenario 增加开关
export async function runWechatBindScenario({ cacheRoot, usePatchedCompat = true }) {
  const installedPluginRoot = path.join(cacheRoot, "node_modules", "opencode-copilot-account-switcher")
  const restoreCompat = usePatchedCompat
    ? await patchInstalledCompatLoader({ installedPluginRoot })
    : async () => {}

  // 其余脚本保持一致；如果 Bun import 阶段直接炸，返回 stage: "module-load"
  // 如果 provider 已进入 bind-flow 且 compat helper 装配时报错，返回 stage: "compat-assembly"
}
```

- [ ] **Step 4: 运行新的 gate 命令，确认它既能过成功场景，也能在真实 compat 失败时给出可归类结果**

Run: `npm run test:wechat-host-gate`

Expected: PASS；至少包含两条通过用例：
- 一个 patched compat 场景，证明业务路径可到达 compat 装配边界
- 一个 real compat 场景，证明当前真实模块错误会被 gate 直接归类而不是逃逸到用户机器

## Task 5: 发布流程对齐与最终验证

**Files:**
- Modify: `docs/superpowers/specs/2026-04-02-wechat-opencode-host-gate-design.md`
  - 仅当命令名、阶段枚举或文件名与最终实现不一致时修正
- Test: `test/wechat-opencode-host-gate.test.js`

- [ ] **Step 1: 对照 spec 逐条检查实现是否覆盖以下要求**

```txt
1. 真实发布形态输入（package/dist）
2. 临时 opencode-like cache layout
3. Bun 风格插件加载
4. provider adapter -> wechat-bind -> bind-flow -> compat helper 装配
5. 失败分类：module-load / provider-route / compat-assembly / business-error
6. release gate 命令：npm run test:wechat-host-gate
```

- [ ] **Step 2: 如果实现名和 spec 文字有偏差，只做最小文档收口**

```md
## 运行命令设计

- `npm run test:wechat-host-gate`

## 第一阶段必须锁住的断言

- `module-load`
- `provider-route`
- `compat-assembly`
- `business-error`
```

- [ ] **Step 3: 运行最终验证，确认新 gate 可以进入发布前证据**

Run: `npm run build && node --test test/wechat-opencode-host-gate.test.js`

Expected: PASS，gate 主测试全绿。

Run: `npm run test:wechat-host-gate`

Expected: PASS，脚本可直接用于发布前检查。

Run: `npm test`

Expected: PASS，且新增 host gate 不破坏现有全量测试。

## 自检清单

- spec 里要求的四层结构是否都在 harness 文件中有清晰落点。
- `npm run test:wechat-host-gate` 是否已真正加入 `package.json`。
- 主 gate 是否至少覆盖“patched compat 成功到达边界”和“real compat 失败可归类”两类场景。
- 计划里是否避免了“先改生产代码再补测试”的顺序错误。
- 是否保持第一阶段无真实微信账号依赖。
