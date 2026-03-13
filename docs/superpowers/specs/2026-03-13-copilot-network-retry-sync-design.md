# Copilot Network Retry Sync 设计

## 目标

在 `opencode-copilot-account-switcher` 插件中，为 GitHub Copilot provider 增加一个默认关闭、可选开启的 `Copilot network retry` 开关，并且把对官方 `opencode/packages/opencode/src/plugin/copilot.ts` 的复用方式收敛成“脚本生成的已提交快照 + 稳定适配层”的结构。

这次设计要同时解决两类问题：

- 网络重试能力需要尽量复用官方 `auth.loader` 的 request fetch 行为，只在最后一跳叠加窄范围 retry/backoff。
- 仓库里的 `src/upstream/copilot-plugin.snapshot.ts` 不能再依赖手工编辑维护，否则会混入人工改写噪音，削弱与 upstream 的可比对性，也会让后续 drift 检查失真。

## 非目标

- 不修改 OpenCode core。
- 不在运行时依赖远端仓库源码。
- 不把 retry 逻辑混入快照文件本体。
- 不让非 Copilot URL、不可安全重放的请求、`AbortError` 等进入重试路径。
- 不改变现有账号管理、Guided Loop Safety、配额查询、模型检查等既有功能边界。

## 设计结论

推荐并确认采用以下方案：

1. `src/upstream/copilot-plugin.snapshot.ts` 改为“由脚本生成、并提交进仓库的产物”。
2. 新增 `scripts/sync-copilot-upstream.mjs`，由它读取本地 upstream 文件或远端源码，再按固定规则生成 snapshot。
3. snapshot 允许差异只包括三类：来源注释块、单一 `LOCAL_SHIMS` 区块、脚本追加的显式导出块。
4. 主插件代码不直接依赖 snapshot 的内部类型名，而是通过 `src/upstream/copilot-loader-adapter.ts` 获取插件自有的稳定契约。
5. 后续 `auth.loader` 接线统一依赖这个稳定契约，拿到 `baseURL`、`apiKey`、`fetch`，再按开关决定是否套 retry 包装。

这样做的原因：

- 快照文件仍然是可审阅、可离线构建、可测试的已提交产物。
- 快照主体由脚本生成，可以排除手工编辑对结构和 diff 的干扰。
- 适配层把 snapshot 与主插件隔离开，避免后续 Task 5/6 继续扩大耦合面。

## 快照生成策略

### `scripts/sync-copilot-upstream.mjs`

这是 snapshot 的唯一生成入口，负责：

- 读取 `--source <file-or-url>` 指定的 upstream `copilot.ts`
- 默认优先尝试本地 `opencode` checkout，找不到时再允许使用远端 URL
- 生成并写入 `src/upstream/copilot-plugin.snapshot.ts`
- 支持 `--check` 模式，只校验当前 snapshot 是否等于脚本生成结果，不改文件
- 支持注入元数据，如 `--upstream-commit`、`--sync-date`

脚本生成流程必须是确定性的：

1. 读取 upstream 源文件
2. 统一换行格式
3. 保留官方主体结构
4. 注入来源注释块
5. 注入单一 `LOCAL_SHIMS` 区块
6. 注入脚本生成的显式导出块，例如 `createOfficialCopilotLoader()`
7. 输出最终 snapshot

`--check` 模式比较的是“当前文件内容”与“脚本重新生成的结果”是否完全一致。只要有人手工改了 snapshot 主体、shim、导出块或来源元数据，这个模式就必须报 `mismatch` 并返回非零退出码。

脚本参数契约需要锁死为：

- `--source <file-or-url>`：可选；未提供时优先尝试本地 checkout，找不到再退回默认 upstream URL
- `--output <path>`：可选；默认写入 `src/upstream/copilot-plugin.snapshot.ts`
- `--upstream-commit <sha>`：生成正式 snapshot 时必须提供；若缺失，只允许在临时 fixture 测试中使用占位值
- `--sync-date <YYYY-MM-DD>`：生成正式 snapshot 时必须提供；用于稳定输出与可复现审阅
- `--check`：只校验，不改文件

正式仓库工作流里，`sync` 与 `check` 都必须记录并校验 `upstream-commit` 和 `sync-date`，不能依赖脚本临时生成当前日期或模糊来源。

### 结构漂移 fail-fast 规则

脚本不能“尽力而为”地生成 snapshot，必须依赖固定锚点，并在锚点异常时立即失败。

最低要求的锚点包括：

- import 区块存在且位于文件头部
- `export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks>` 存在且仅出现一次
- `auth.loader(getAuth, provider)` 代码块存在且仅出现一次
- `methods: [` 锚点存在，用于界定 loader 代码块结束位置

若出现以下情况，脚本必须 fail-fast，而不是输出“看起来能编译”的文件：

- 锚点缺失
- 锚点重复
- 无法唯一提取 loader 主体
- 已有 snapshot 中出现多个 `LOCAL_SHIMS` 或多个脚本生成导出块

这样可以确保 upstream 结构变化先暴露在同步脚本，而不是悄悄污染 snapshot。

### `src/upstream/copilot-plugin.snapshot.ts`

这个文件是生成产物，不再手工维护主体逻辑。仓库中保留它的原因不是为了让人手写修改，而是为了：

- 让构建和测试不依赖网络
- 让 PR 可以直接审阅 snapshot 差异
- 让后续 check/sync 有固定目标文件

文件必须满足以下约束：

- 文件头写明来源仓库、原始路径、同步日期、upstream commit
- 只允许一个 `LOCAL_SHIMS` 区块
- 必须保留官方 `CopilotAuthPlugin` 主体结构
- 必须包含脚本追加的显式导出入口，例如 `createOfficialCopilotLoader()`
- 不得混入 retry、store、菜单、风险提示等插件业务逻辑

## 本地 Shim 边界

`LOCAL_SHIMS` 的职责只限于让 upstream 文件能在当前插件仓库里编译和测试，允许包括：

- `Hooks` / `PluginInput` 的本地最小类型替代
- `Installation.VERSION`、`iife()`、`Bun.sleep()` 等编译期依赖的最小替代
- 生成导出所需的本地辅助类型

不允许把业务决策塞进 shim，例如：

- retry 规则
- store 开关读取
- 风险提示文案
- plugin wiring

如果 snapshot 结构需要变化，必须先改同步脚本，再重新生成 snapshot；不能直接手改生成文件。

## 运行时适配层

### `src/upstream/copilot-loader-adapter.ts`

这个文件是主插件和 snapshot 之间的稳定边界。

它不应该把 snapshot 的内部类型名继续往外暴露，而应该定义插件自有的窄接口，例如：

```ts
type CopilotAuthState = {
  type: string
  refresh?: string
  access?: string
  expires?: number
  enterpriseUrl?: string
}

type OfficialCopilotConfig = {
  baseURL?: string
  apiKey: string
  fetch: (request: Request | URL | string, init?: RequestInit) => Promise<Response>
}
```

推荐主入口为：

- `loadOfficialCopilotConfig(input)`：返回 `Promise<OfficialCopilotConfig | undefined>`

如果保留 `createOfficialFetchAdapter(...)`，它必须只是对 `loadOfficialCopilotConfig()` 的薄封装，不能成为生产代码唯一可用入口。生产代码在 Task 6 中应直接消费稳定配置对象，而不是被迫回退到 snapshot 内部签名。

`loadOfficialCopilotConfig(input)` 的精确契约定义为：

```ts
type LoadOfficialCopilotConfigInput = {
  getAuth: () => Promise<{
    type: string
    refresh?: string
    access?: string
    expires?: number
    enterpriseUrl?: string
  } | undefined>
  baseFetch?: typeof fetch
  provider?: {
    models?: Record<string, {
      id?: string
      api: { url?: string; npm?: string }
      cost?: unknown
    }>
  }
  version?: string
}
```

行为约束：

- 这是异步函数，因为内部需要读取最新 auth 状态
- 当 `getAuth()` 返回 `undefined` 或 `type !== "oauth"` 时，返回 `undefined`
- 当 `type === "oauth"` 时，返回完整 `OfficialCopilotConfig`
- `baseFetch` 缺失时使用全局 `fetch`
- `version` 缺失时使用 snapshot 内的 `Installation.VERSION` 默认值
- `provider.models` 若存在，必须保留官方对 `cost` 与 `api.npm` 的改写语义

`OfficialCopilotConfig.fetch` 的 header 契约也需要明确：

- 保留官方 `Authorization`、`Openai-Intent`、`x-initiator`、`Copilot-Vision-Request` 注入语义
- 删除调用方传入的 `authorization` / `x-api-key`
- 继续保留无冲突的业务 header，例如 `x-trace-id`

生产代码约束：

- 除 `src/upstream/copilot-loader-adapter.ts` 外，其他生产代码不得直接 import `src/upstream/copilot-plugin.snapshot.ts`
- `src/index.ts` 只在测试需要时 re-export 适配层入口，不 re-export snapshot 内部类型

这个适配层需要保证：

- 非 oauth auth 时返回 `undefined`，而不是把 snapshot 的 `Record<string, never>` 继续往外泄漏
- oauth auth 时稳定返回 `baseURL`、`apiKey`、`fetch`
- `fetch` 行为保持官方 header 注入语义
- 主插件不需要知道 snapshot 里具体导出了哪些辅助类型

## Retry 接线边界

后续 `src/copilot-network-retry.ts` 和 `src/plugin-hooks.ts` / `src/plugin.ts` 应建立在稳定适配层之上：

1. 通过适配层得到官方 `baseURL` / `apiKey` / `fetch`
2. 当 `networkRetryEnabled === false` 时，直接返回官方配置
3. 当 `networkRetryEnabled === true` 时，只替换 `fetch` 为 retry 包装版
4. 不改写 `baseURL`、`apiKey` 或其他 provider 选项

这样可以把“官方行为复用”和“本插件 retry 增量逻辑”拆成两层，便于测试和后续 drift 检查。

## 错误处理

### 同步脚本

- 源文件读取失败时，脚本应直接失败并给出明确错误
- `--check` 模式 mismatch 时返回非零退出码，并输出首个差异摘要
- 输出路径不存在时自动创建父目录

### 运行时适配层

- 非 oauth auth 时不伪造半完整配置，直接返回 `undefined`
- 上游 fetch 行为里原本允许透传的 header 必须继续保留
- 不能通过替换 `globalThis.fetch` 等全局状态来注入依赖，避免并发串扰

## 测试计划

### 脚本与快照

至少覆盖：

1. 脚本可从 fixture upstream 源生成 snapshot
2. 生成结果包含来源元数据、`LOCAL_SHIMS`、显式导出入口
3. `--check` 模式能识别手工改动并报 `mismatch`
4. snapshot 继续保留官方主体结构关键锚点

### 适配层

至少覆盖：

1. 与官方一致的 header 注入行为
2. 非 oauth 时返回空结果/`undefined` 的稳定契约
3. `baseURL` 在 enterprise auth 下可稳定透传
4. 不泄漏全局 fetch 副作用
5. 若通过 `src/index.ts` 暴露测试入口，re-export 契约保持稳定

### 后续集成

在 Task 5/6 里继续补：

1. retryable error 分类
2. 可安全重放判定
3. 开关关闭时保持官方行为
4. 开关开启时只包装 `fetch`

## 用户可见行为

用户可见的新能力仍然是菜单里的 `Copilot network retry` 开关：

- 默认关闭
- hint 明确说明它覆盖官方 fetch 路径，可能随 upstream 漂移
- 开启后只影响 Copilot 相关请求路径

但这个用户可见能力背后的 upstream 同步机制变成“脚本生成 + check 校验”，从而减少人工维护漂移。

## 交付标准

满足以下条件后，才算这个设计落地正确：

- snapshot 明确是脚本生成产物，且手工编辑会被 check 模式抓住
- 快照主体与官方 `copilot.ts` 的关系保持清晰、可比较
- 适配层对主插件暴露稳定契约，不泄漏 snapshot 内部类型
- 后续 retry 接线可以只依赖稳定适配层，不必重新回到 snapshot 内部取值
