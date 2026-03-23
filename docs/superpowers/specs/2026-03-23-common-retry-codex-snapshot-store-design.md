# 通用 Retry 分层、Codex 官方 Snapshot 与 Store 归一化设计

## 背景

当前项目里的 `networkRetryEnabled`、`loopSafetyEnabled`、`experimentalSlashCommandsEnabled` 等通用能力虽然已经以 store 字段存在，但概念与入口仍然明显偏向 Copilot：

- 通用开关目前主要挂在 Copilot 菜单下；
- `networkRetryEnabled` 的实现与 Copilot 路由、Copilot 官方 snapshot 适配器缠在同一条 fetch 链里；
- OpenAI/Codex 虽然已有独立 provider 和独立菜单，但没有自己的官方 snapshot / loader adapter；
- Copilot store、Codex store、通用配置的路径规范不统一，通用设置仍借住在 Copilot store 中。

这导致两个结构性问题：

1. `networkRetryEnabled` 在语义上是全局开关，但在实现上仍然像 Copilot 专属功能；
2. Codex provider 想接入 retry 或官方 fetch 包装时，容易误入 Copilot 的账号路由、header 改写和 session repair 语义。

本次重构需要把这些边界一次摆正：

- 通用能力归通用；
- provider 专用错误处理归 provider 自己；
- Codex 像 Copilot 一样拥有自己的官方 snapshot / loader adapter；
- store 与路径规范独立且一致。

## 目标

1. 把 `networkRetryEnabled` 明确收敛为唯一的全局 retry 开关。
2. 建立 `common + codex + copilot` 三层 retry 结构：
   - common 负责 provider 无关的 transient 分类与归一化；
   - codex 负责 Codex 语义下的 transient retry；
   - copilot 保留自己的 repair / notifier / retry 语义。
3. 给 Codex provider 增加独立的官方 snapshot / loader adapter，不再借用 Copilot 官方适配器。
4. 把 `buildPluginHooks` 从“默认绑定 Copilot 官方 fetch 与 Copilot 路由”的实现，重构为“按 provider descriptor 组合官方 fetch / retry / 路由能力”的实现。
5. 把通用开关从 Copilot 私有菜单中抽离，重构为 Copilot / Codex 两边都能看到的“通用设置”。
6. 把通用设置 store 从 Copilot store 中剥离，并统一 store 路径规范。
7. 为旧路径和旧 store 结构提供平滑迁移与兼容回退。

## 非目标

1. 不把 Copilot 的 session repair、payload cleanup、`x-initiator` 补偿扩展到 Codex。
2. 不新增多个用户侧 retry 开关；用户侧仍只有一个 `networkRetryEnabled`。
3. 不改变现有 `auth.json` 的宿主路径与归属。
4. 不在本次重构中重写 Codex 状态刷新与无效账号恢复规则本身。
5. 不把 provider 彻底拆成两套完全独立的 hook builder；仍保留共享的编排层。

## 方案选择

采用“共享编排层 + provider 自带官方 fetch 适配器 + provider 自带 retry policy + 独立 common settings store”的方案。

不采用的方案：

### 方案 A：继续在 `buildPluginHooks` 内追加更多 `if provider === ...`

优点：

- 改动快。

缺点：

- 继续放大 Copilot / Codex 逻辑缠绕；
- provider 边界越来越模糊；
- 后续新增第三个 provider 时会继续复制分支。

### 方案 B：彻底拆成两套完全独立的 hook builder

优点：

- 边界最干净。

缺点：

- 重复明显增加；
- 菜单、命令、store 与测试需要重复维护；
- 当前阶段收益小于重构成本。

### 选定方案：共享编排层 + provider 能力注入

原因：

- 能把 Copilot 专属逻辑与通用编排拆开；
- 能让 Codex 安全接入自己的官方 snapshot 与 retry；
- 保留现有共享菜单 / 共享命令 / 共享 store 工具链的复用价值；
- 为后续新增 provider 留出统一扩展点。

## 设计细节

### 1. Retry 的三层模型

用户侧保留唯一开关：

```ts
type CommonSettingsStore = {
  networkRetryEnabled?: boolean
  loopSafetyEnabled?: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
  experimentalSlashCommandsEnabled?: boolean
}
```

但实现层明确拆成三层：

1. `common retry`
   - 抽出 provider 无关的 transient 错误分类 helper；
   - 负责统一 transport / timeout / transient status 的基本归一化工具；
   - 不包含任何 provider 专属 repair 或 header 语义。
2. `codex retry`
   - 只匹配 OpenAI/Codex provider 请求；
   - 在 common helper 之上补充 Codex 自己的 transient 语义；
   - 不做 session repair、payload cleanup、路由切号、`x-initiator` 干预。
3. `copilot retry`
   - 在 common helper 之上保留现有 Copilot 特有行为；
   - 包括现有 repair loop、notifier、session repair 与相关诊断日志。

`networkRetryEnabled === true` 的语义不是“当前 provider 开 retry”，而是“整个插件启用完整 retry 分层”。最终表现为：

- Copilot 请求挂 `common + copilot`；
- Codex 请求挂 `common + codex`。

### 2. Codex retry 的边界

Codex retry 保守处理，只覆盖明确的 transient 场景：

- transport error；
- 连接失败；
- timeout；
- `429`；
- `5xx`。

明确不纳入 retry 的场景：

- `400`；
- `401`；
- `403`；
- Codex 无效账号恢复语义；
- 与 Copilot 特有 session / payload / routing 相关的任何 repair。

这样可以保证：

- Codex 获得自己的 retry 能力；
- 但不会因为 retry 重构而重新进入 Copilot 路由链路。

### 3. 官方 snapshot / loader adapter 的 provider 化

当前 Copilot 已有：

- `src/upstream/copilot-plugin.snapshot.ts`
- `src/upstream/copilot-loader-adapter.ts`

本次为 Codex 增加对称结构：

- `src/upstream/codex-plugin.snapshot.ts`
- `src/upstream/codex-loader-adapter.ts`

并新增与 Copilot 同型的 Codex snapshot 同步脚本，用于从上游 `anomalyco/opencode` 的 `packages/opencode/src/plugin/codex.ts` 生成本地 snapshot。

这层的目标是：

1. Codex 的官方 fetch 行为有自己的镜像与适配层；
2. `buildPluginHooks` 不再假设“官方 snapshot 就是 Copilot”；
3. 未来上游 Codex 插件更新时，本仓库也能以一致方式同步。

### 4. Provider descriptor 的能力注入

当前 descriptor 主要声明：

- auth provider；
- enabledByDefault；
- Copilot 的 `buildPluginHooks`。

重构后，descriptor / registry 需要升级为声明 provider 自己的能力，例如：

```ts
type ProviderRuntimeCapabilities = {
  loadOfficialConfig?: ...
  loadOfficialChatHeaders?: ...
  createProviderFetchEnhancer?: ...
  createRetryEnhancer?: ...
  menuCapabilities?: {
    commonSettings: boolean
    providerSpecificSettings: string[]
  }
}
```

含义：

- Copilot provider：
  - 提供 Copilot 官方 config/chat headers 适配器；
  - 提供 Copilot 路由 enhancer；
  - 提供 Copilot retry enhancer。
- Codex provider：
  - 提供 Codex 官方 config/chat headers 适配器；
  - 不提供 Copilot 路由 enhancer；
  - 提供 Codex retry enhancer。

### 5. `buildPluginHooks` 的职责重划分

当前 `buildPluginHooks` 同时承担：

- Copilot 官方 auth loader 包装；
- Copilot model routing；
- Copilot retry 接入；
- 通用命令与系统 transform。

重构后，它只保留“编排”职责：

1. 按 provider 拿到该 provider 的官方 config / chat headers 适配器；
2. 生成该 provider 的基础 fetch；
3. 如 provider 提供 fetch enhancer，则先包 provider 自己的 fetch 行为；
4. 如 `networkRetryEnabled === true` 且 provider 提供 retry enhancer，则再包 provider 的 retry；
5. 通用命令、系统 transform、菜单 action 仍在共享层处理。

这样可以确保：

- Copilot 的 routing 不会误套到 Codex；
- Codex 的 retry 能在自己的官方 snapshot 之上工作；
- 官方 snapshot 包装与 provider retry 的责任分层清晰。

### 6. 通用设置与 provider 专属设置

菜单信息架构改为三层：

1. `当前 provider 操作`
   - 例如账号导入、刷新快照、模型同步、账号组配置等。
2. `通用设置`
   - `loopSafetyEnabled`
   - `loopSafetyProviderScope`
   - `experimentalSlashCommandsEnabled`
   - `networkRetryEnabled`
3. `provider 专属设置`
   - 当前只保留 Copilot 的 `syntheticAgentInitiatorEnabled`。

约束：

- Copilot 菜单和 Codex 菜单都要能看到 `通用设置`；
- 通用设置不能再作为 Copilot 私有 action 的一部分硬编码隐藏在 Codex 菜单外；
- `networkRetryEnabled` 的提示文案改成“全局启用 retry 分层，当前 provider 将启用对应专用 retry”；
- Copilot 专属设置仍只在 Copilot 菜单显示。

### 7. 独立的通用设置 store

通用设置不能继续借住在 Copilot store。新增：

```ts
type CommonSettingsStore = {
  loopSafetyEnabled?: boolean
  loopSafetyProviderScope?: "copilot-only" | "all-models"
  networkRetryEnabled?: boolean
  experimentalSlashCommandsEnabled?: boolean
  experimentalStatusSlashCommandEnabled?: boolean
}
```

其中：

- `experimentalStatusSlashCommandEnabled` 只作为 legacy 兼容字段保留在迁移/读取层；
- 新写入统一落到 `experimentalSlashCommandsEnabled`。

Copilot store 只保留 Copilot 账号与 Copilot 专属配置；
Codex store 只保留 Codex 账号与 Codex 专属配置；
通用设置单独放在新的 settings store 中。

### 8. 路径规范统一

新增统一的路径 helper 模块，约定插件专属目录：

```text
~/.config/opencode/account-switcher/settings.json
~/.config/opencode/account-switcher/copilot-accounts.json
~/.config/opencode/account-switcher/codex-accounts.json
```

约束：

- 通用设置、Copilot store、Codex store 全部收口到 `account-switcher/` 子目录；
- 文件命名明确反映职责；
- `auth.json` 继续沿用宿主路径，不纳入这次路径归一化。

### 9. 迁移与兼容回退

迁移策略：

1. 优先读取新路径；
2. 新路径不存在时，读取旧路径：
   - Copilot：原 `copilot-accounts.json`；
   - Codex：原 `codex-store.json`；
   - 通用设置：从旧 Copilot store 中抽取相关字段；
3. 当检测到旧路径数据时：
   - 写入新路径；
   - 在本次运行中继续以新结构工作；
   - 保持对旧路径的只读兼容回退一段时间；
4. 写入时只写新路径，不再回写旧路径。

冲突处理规则需要固定：

- 如果新路径文件已存在，则新路径优先，旧路径只用于补缺失字段，不覆盖新路径已有值；
- 如果 `settings.json` 与旧 Copilot store 同时包含通用设置字段，则以 `settings.json` 为准；
- 如果新 Copilot / Codex store 已存在，而旧路径仍存在，则账号数据以新路径为准，旧路径只用于兼容读取，不参与覆盖；
- 迁移逻辑必须幂等：重复启动不会重复污染、重复改写或把旧值回灌到新值上。

legacy 字段收敛规则需要固定：

- `experimentalSlashCommandsEnabled` 是唯一的规范字段；
- `experimentalStatusSlashCommandEnabled` 只在读取旧数据且规范字段缺失时作为 fallback；
- 当两者同时存在时，始终以 `experimentalSlashCommandsEnabled` 为准；
- 任意一次成功写入新 `settings.json` 后，都不再写回 `experimentalStatusSlashCommandEnabled`。

这样可保证：

- 旧用户不丢数据；
- 通用设置能从 Copilot store 平滑抽离；
- 新代码路径规范一次到位。

## 影响文件

- `src/plugin-hooks.ts`
  - 拆分 provider base fetch / provider routing / provider retry 编排；
  - 去除对 Copilot 官方 adapter 的默认假设。
- `src/providers/descriptor.ts`
  - 扩展 provider runtime capabilities 声明。
- `src/providers/registry.ts`
  - 为 Copilot / Codex 注入各自官方 adapter 与 retry enhancer。
- `src/store.ts`
  - 移除通用设置字段的宿主职责，仅保留 Copilot 账号与 Copilot 专属字段；
  - 接入新路径 helper 与迁移逻辑。
- `src/codex-store.ts`
  - 迁移到统一路径 helper 与新路径规范；
  - 保持 Codex 账号数据职责不变。
- `src/common-settings-store.ts`（新增）
  - 维护通用设置 schema、读写、迁移与兼容。
- `src/store-paths.ts`（新增）
  - 统一返回 `account-switcher/` 子目录下的三个 store 路径。
- `src/ui/menu.ts`
  - 新增“通用设置” section；
  - 调整 capability 归属与 provider 文案。
- `src/plugin.ts`
  - 菜单入参改为读取通用设置 store + provider store；
  - Copilot / Codex 菜单都接入通用设置。
- `src/retry/common-policy.ts`（新增）
  - provider 无关的 transient 分类与归一化 helper。
- `src/retry/codex-policy.ts`（新增）
  - Codex retry policy。
- `src/retry/copilot-policy.ts`
  - 改为建立在 common helper 之上。
- `src/upstream/codex-plugin.snapshot.ts`（新增）
  - 上游 Codex 插件 snapshot。
- `src/upstream/codex-loader-adapter.ts`（新增）
  - Codex 官方 plugin 适配器。
- `scripts/sync-codex-upstream.mjs`（新增）
  - 从上游同步 Codex plugin snapshot。

## 测试策略

### 1. Store / 路径 / 迁移

- 通用设置从旧 Copilot store 中正确迁移到 `settings.json`；
- Copilot / Codex store 迁移到 `account-switcher/` 子目录；
- 新路径优先、旧路径回退有效；
- 新写入只写新路径。
- 新旧路径同时存在且字段冲突时，覆盖规则符合文档定义；
- 部分文件已迁移、部分未迁移的混合态可稳定启动；
- 迁移中断后的再次启动具备幂等性，不重复污染数据。

### 2. 菜单

- Copilot / Codex 两边都能看到“通用设置”；
- `syntheticAgentInitiatorEnabled` 只在 Copilot 菜单可见；
- `networkRetryEnabled` 文案不再写死为 Copilot 专属；
- 菜单顺序符合“当前 provider 操作 -> 通用设置 -> provider 专属设置 -> 账号 -> 危险操作”。

### 3. Provider official adapter

- Copilot 仍走现有官方 Copilot snapshot adapter；
- Codex 走自己的官方 Codex snapshot adapter；
- OpenAI/Codex provider 不再触达 Copilot official adapter。

命名约束：

- 文档、代码与测试统一使用“Codex provider”指代 `auth.provider = openai` 的 Codex 插件路径；
- 只有在明确讨论 auth provider ID 时才写 `openai`，避免与“通用 OpenAI provider”概念混淆。

### 4. Retry policy

- Codex：
  - transient 错误进入 retry 分类；
  - `400/401/403` 不进入 retry；
  - 不出现 Copilot session repair 语义。
- Copilot：
  - 既有 repair / notifier 行为保持不回退；
  - common helper 接入后回归仍通过。

### 5. Hook 隔离

- OpenAI/Codex provider 开启 `networkRetryEnabled` 后：
  - 使用 Codex 自己的 base fetch 和 Codex retry；
  - 不进入 Copilot routing；
  - 不依赖 Copilot auth loader。
- 增加负向断言：Codex provider 的调用链不应触发 Copilot official adapter、Copilot routing enhancer、Copilot session repair enhancer。

## 风险与缓解

### 风险 1：`buildPluginHooks` 重构范围大，容易引入 provider 串线回归

缓解：

- 先拆 descriptor capability，再拆 fetch 编排；
- 用 provider 隔离测试覆盖 OpenAI / Copilot 两条路径。

### 风险 2：store 路径迁移导致历史用户数据读取异常

缓解：

- 明确新路径优先、旧路径回退；
- 对迁移逻辑补单测；
- 先实现“写新读双路径”，不做激进删除。

### 风险 3：Codex 官方 snapshot 同步流程与 Copilot 不一致

缓解：

- 复用 Copilot sync script 的结构与校验思路；
- 明确上游路径、commit 元数据与 drift 检查。

## 验收标准

1. `networkRetryEnabled` 仍然只有一个用户侧开关，但打开后 Copilot 与 Codex 都接入自己的 retry 层。
2. Codex provider 有自己的官方 snapshot / loader adapter，不再复用 Copilot adapter。
3. 通用设置不再存放在 Copilot store 中，而是进入独立 `settings.json`。
4. Copilot / Codex / Common 三类 store 路径统一落到 `~/.config/opencode/account-switcher/` 下。
5. Codex 菜单和 Copilot 菜单都能看到同一组通用设置。
6. OpenAI/Codex 请求链不会再进入 Copilot routing / session repair / `x-initiator` 语义。
7. 全量测试与新增回归测试通过。
