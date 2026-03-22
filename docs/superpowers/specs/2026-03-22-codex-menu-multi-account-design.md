# Codex 独立菜单与多账号切换设计

## 背景

当前仓库已经有一套完整的 Copilot 账号菜单与切换能力：

- 菜单主循环集中在 `src/plugin.ts` 的 `runMenu()`；
- 菜单文案与账号列表渲染在 `src/ui/menu.ts`；
- 通用菜单开关动作在 `src/plugin-actions.ts`；
- Copilot 账号池、active account、默认账号组、自动刷新等状态存放在 Copilot store；
- 用户已经明确希望为 Codex 增加“和 Copilot 同款”的菜单体验，包括多账号登录、账号切换与 snapshot 刷新；
- 同时用户明确要求：Codex 仍然保持独立菜单，不并入当前 GitHub Copilot 菜单；首版登录方式采用上游 OpenAI OAuth 逻辑，并在首次启动时自动从 `auth.json` 导入现有 `openai` 凭据。

当前问题不是功能不可做，而是如果直接复制 Copilot 的整套 `runMenu()`，未来 Copilot / Codex 两边的菜单、导入、切换、snapshot 刷新会出现持续复制与漂移。

## 目标

1. 为 OpenAI Codex provider 提供独立菜单入口，并直接接管 `openai` provider 的账号菜单。
2. 支持 Codex 多账号登录、账号切换、账号删除与首启自动导入。
3. 让 Codex 菜单复用 Copilot 现有的菜单交互与 snapshot 刷新机制，而不是再复制一份主循环。
4. 保持 Codex 与 Copilot 的 provider 语义隔离：Codex 不进入 Copilot routing、`x-initiator`、`modelAccountAssignments`、network-retry 语义。
5. 为未来第三个 provider 预留稳定的菜单扩展边界。

## 非目标

1. 不把 Codex 并入当前 GitHub Copilot 单一菜单。
2. 不把 Codex 接入 `modelAccountAssignments` 或按模型分配账号组逻辑。
3. 不让 Codex 复用 Copilot 的 quota/models 文案或 GitHub 身份拉取逻辑。
4. 不在本次把整个插件重构成大而全的 provider 平台。
5. 不新增手工录入 OpenAI token 的菜单入口；首版只支持上游 OAuth 登录与首次自动导入 `auth.json`。

## 设计选择

采用“独立 Codex 菜单入口 + 共享菜单骨架 + provider adapter”的方案。

原因：

- 保留独立 Codex 菜单，符合当前 provider descriptor 结构；
- 共享菜单骨架，避免复制第二份 `runMenu()`；
- 用 adapter 承载 provider 差异，后续增加第三个 provider 时不需要再次拆主循环。

## 总体结构

### 1. 独立菜单入口

- `GitHub Copilot` 继续保留现有入口，并直接进入 Copilot 账号菜单；
- `openai` provider 入口由本插件接管，并直接进入 Codex 账号菜单；
- 不再把 Codex 作为 `github-copilot` 的第二个 auth method，避免用户在 Copilot 入口下再看到一层“Copilot / Codex”二选一菜单；
- provider registry / descriptor 层继续保留 Codex 能力声明，但入口装配必须与 `openai` provider id 对齐。

这一点是本次设计的硬约束：Codex 的“独立”指独立于 Copilot 菜单，而不是在 Copilot 菜单前再套一层选择器。

### 2. 共享菜单骨架

从当前 `src/plugin.ts` 中抽出一套共享 runtime，负责：

- 首次 bootstrap 导入；
- 菜单循环；
- 账号列表渲染与选择；
- 通用 action：`switch`、`remove`、`remove-all`、`cancel`；
- 自动刷新触发与调度；
- 调用 adapter 执行 provider-specific 登录、snapshot 刷新与切换。

这层不感知 GitHub / OpenAI 细节，只负责交互骨架。

### 3. Provider Adapter

Copilot 与 Codex 各提供一个 adapter。建议最小接口：

```ts
type ProviderMenuAdapter = {
  key: string
  title: string
  providerId: string
  loadStore: () => Promise<ProviderStore>
  writeStore: (store: ProviderStore, meta?: StoreWriteDebugMeta) => Promise<void>
  bootstrapAuthImport: (store: ProviderStore) => Promise<boolean>
  authorizeNewAccount: () => Promise<ProviderAccountEntry | undefined>
  refreshSnapshots: (store: ProviderStore) => Promise<void>
  switchAccount: (client: AuthClient, entry: ProviderAccountEntry) => Promise<void>
  toMenuInfo: (store: ProviderStore) => Promise<AccountInfo[]>
  applyAction?: (ctx: ProviderActionContext) => Promise<boolean>
}
```

其中：

- `bootstrapAuthImport` 负责 provider 自己的首启导入规则；
- `authorizeNewAccount` 负责新增账号流程；
- `refreshSnapshots` 负责 provider 自己的 snapshot 采集；
- `switchAccount` 决定写回哪个 auth provider；
- `toMenuInfo` 决定菜单里展示哪些摘要字段。

共享 runtime 与 adapter 的调用顺序固定为：

1. `loadStore()`
2. `bootstrapAuthImport()`
3. 若 bootstrap 改变 store，则 `writeStore()`
4. `refreshSnapshots()`（仅在用户动作或 auto refresh 触发时调用）
5. `toMenuInfo()`
6. `showMenu()`
7. 对通用 action 由 runtime 处理；对 provider-specific action 交给 `applyAction()`
8. 只有在 action 真正修改 store 时才 `writeStore()`；只有在 action 为切换账号时才调用 `switchAccount()`

这样可以把“何时写 store、何时切 auth、何时刷新 snapshot”固定下来，避免 provider-specific 逻辑重新泄漏回共享层。

### 4. provider auth 装配方式

当前错误实现的问题在于：插件把 Copilot 与 Codex 都挂到了 `github-copilot` 这一个 auth provider 的 `methods` 里，导致用户先进入 GitHub Copilot，再被迫在第二层菜单里选择一次“Copilot 还是 Codex”。

修正后的装配原则是：

- Copilot hooks 继续注册到 `github-copilot`；
- Codex hooks 单独注册到 `openai`；
- 两边仍可共用同一套 shared runtime 与各自 adapter；
- 入口层只改 provider auth 装配，不重写菜单业务逻辑。

这能让最终用户体验恢复成：

1. 选择 `GitHub Copilot` -> 直接进入 Copilot 账号菜单；
2. 选择 `OpenAI` -> 直接进入 Codex 账号菜单。

## Codex Provider 设计

### 1. 登录方式

Codex 首版只提供两种账号来源：

1. **首次自动导入 `auth.json`**
   - 仅在本地 Codex store 还没有账号池时执行一次；
   - 只筛选 `openai` 凭据；
   - 导入后用户在 Codex 菜单里的命名、删除、切换优先，后续不再重复覆盖。

2. **新增账号走上游 OpenAI OAuth 登录**
   - 直接复用 `opencode/packages/opencode/src/plugin/codex.ts` 里的上游认证逻辑；
   - 登录完成后得到新的 OpenAI OAuth 凭据；
   - 写入 Codex store，并按当前 active 规则决定是否激活。

本次不加手动 token 录入，避免在首版再扩一层 OpenAI token 校验和命名逻辑。

同时，既然用户已明确接受由插件整体接管 `openai` provider 菜单，本次设计默认 `openai` 入口只服务 Codex OAuth / 多账号切换语义，不保留原版 OpenAI 通用登录菜单。

### 2. 切换逻辑

Codex 切换账号时：

- 只写回 `client.auth.set({ path: { id: "openai" } })`；
- 不触碰 `github-copilot` / `github-copilot-enterprise`；
- 不更新 Copilot store 中的 `active` / `activeAccountNames`；
- Codex store 自己维护 `active`、`activeAccountNames`、`lastAccountSwitchAt`。

### 3. Snapshot 机制

Codex 沿用“和 Copilot 同款的 snapshot 机制”，但 snapshot 内容保持 Codex 语义：

- 身份：`email`、`accountId`、`plan`；
- 配额摘要：`5h`、`week`、必要时 `credits`；
- 刷新时间：`lastSnapshotRefresh`；
- 失败时允许保留历史 snapshot，并把错误以摘要形式显示在菜单 hint 或状态字段中。

Codex snapshot 的数据来源：

- 优先使用已实现的 `/codex-status` 路径与对应 fetcher；
- 对每个账号单独刷新，避免共用当前全局 active provider 造成互相覆盖。

### 4. Codex Store

Codex store 建议扩成与 Copilot store 平行的账号池结构，但字段只保留 Codex 需要的部分：

```ts
type CodexStoreFile = {
  accounts: Record<string, CodexAccountEntry>
  active?: string
  activeAccountNames?: string[]
  autoRefresh?: boolean
  refreshMinutes?: number
  lastSnapshotRefresh?: number
  bootstrapAuthImportTried?: boolean
  bootstrapAuthImportAt?: number
}

type CodexAccountEntry = {
  name: string
  providerId: "openai"
  refresh: string
  access: string
  expires: number
  accountId?: string
  email?: string
  addedAt?: number
  lastUsed?: number
  source?: "auth" | "oauth"
  snapshot?: {
    plan?: string
    usage5h?: { remainingPercent?: number; resetAt?: number }
    usageWeek?: { remainingPercent?: number; resetAt?: number }
    updatedAt?: number
    error?: string
  }
}
```

这里不引入 Copilot 的 routing、quota group、model assignment 字段。

### 5. `codex-store` 迁移兼容

当前仓库里的 `src/codex-store.ts` 仍然是单账号快照结构，因此这次必须定义兼容策略：

- 读路径继续兼容旧结构：如果检测到旧的 `activeAccountId` / `activeEmail` / `account` / `status`，就把它提升为新结构中的一个默认账号条目；
- 写路径统一写新结构；
- `/codex-status` 不直接假设 store 已是新格式，而是统一经 `codex-store` helper 做兼容读写；
- 第一次成功写入新结构后，旧字段不再继续扩散，但 reader 仍保留兼容，避免用户本地已有旧文件时立即读写不兼容。

这样可以保证菜单多账号与当前 `/codex-status` 能逐步迁移，而不是一次切断。

## 共享菜单运行时设计

### 1. 首启 bootstrap

共享 runtime 启动后先调用 adapter 的 `bootstrapAuthImport()`：

- Copilot adapter：沿用当前 GitHub Copilot / Enterprise 的导入逻辑；
- Codex adapter：仅当 store 为空时，从 `auth.json` 导入 `openai`。

返回值表示 store 是否发生变化，runtime 决定是否持久化。

为了满足“初次启动时自动导入一次”的要求，Codex store 需要记录：

- `bootstrapAuthImportTried?: boolean`
- `bootstrapAuthImportAt?: number`

规则：

- 只要首次 bootstrap 流程真正跑过一次，就把 `bootstrapAuthImportTried` 标成 `true`；
- 即使 `auth.json` 里没有 `openai` 或字段不完整，也视为“已经尝试过”；
- 后续不再自动重复导入，除非用户显式执行导入/重建动作。

### 2. 菜单循环

共享 runtime 承担：

- 自动刷新调度；
- 构造 `AccountInfo[]`；
- 调用 `showMenu()`；
- 对通用 action 做统一处理。

provider-specific action（比如 Codex 新增账号）交给 adapter。

### 3. Provider 菜单裁剪

当前 `src/ui/menu.ts` 内含不少 Copilot 专属动作，因此共享 runtime 不能直接把整套菜单原样给 Codex。需要新增一层 provider menu capabilities，例如：

- Copilot：保留 loop-safety、network-retry、model group、slash command 开关等现有项；
- Codex：只暴露和账号池、snapshot、自动刷新直接相关的动作；
- `buildMenuItems()` 改成接受 provider-specific copy / capability 集合，只渲染该 provider 被允许的动作。

这样可以把 Copilot / Codex 的 UI 边界在菜单层也硬性隔离，而不是靠调用方“别去点到那些 action”。

### 4. 插件装配回归约束

除了菜单项裁剪，还需要在插件装配层增加回归约束：

- `github-copilot` auth methods 中不能再出现 Codex 菜单 label；
- `openai` auth provider 必须直接调用 `runCodexMenu()`；
- 任何测试如果还需要在 Copilot 入口下手动选择 Codex，都说明装配方式再次退化。

### 5. Action 处理边界

- 通用 action：`switch`、`remove`、`remove-all`、`cancel`、`toggle-refresh`、`set-interval`；
- provider-specific action：`add-account`、`refresh-snapshot`，以及任何只对该 provider 有意义的动作；
- `plugin-actions.ts` 里现在那些明显全局开关型的逻辑继续留在共享层；provider-specific 菜单动作不塞进去。

## 测试策略

### 1. 共享层测试

新增共享 runtime 测试，至少覆盖：

- store 为空时 bootstrap 导入只执行一次；
- `switch/remove/remove-all/cancel` 的通用行为；
- auto refresh 的触发与持久化；
- adapter 返回当前 active 账号时的菜单退出行为。

建议文件：

- `test/provider-menu-runtime.test.js`
- `test/ui/menu.test.js`

### 2. Copilot 回归测试

确保迁移到 adapter 后，以下行为不回退：

- 账号切换；
- 导入 `auth.json`；
- quota / identity / models 刷新；
- store 写入与 debug meta；
- 菜单文案与开关动作。

建议文件：

- 继续复用现有 `test/plugin.test.js`
- 继续复用现有菜单与 store 相关测试

### 3. Codex 新增测试

至少覆盖：

- 首次自动导入 `openai` auth；
- 上游 OAuth 登录新增账号；
- `github-copilot` 入口下不再出现 Codex 二级选择；
- `openai` 入口被插件接管后直接进入 Codex 菜单；
- 切换账号只写回 `openai` provider；
- snapshot 展示 `email/plan/5h/week`；
- Codex 菜单不会读写 Copilot routing/network-retry/model assignment 字段；
- 删除/移除全部账号不会误删 Copilot store。

建议文件：

- `test/codex-store.test.js`
- `test/codex-status-command.test.js`
- `test/codex-menu-runtime.test.js`
- 必要时新增 `test/codex-plugin-config.test.js` 断言独立入口装配

## 风险与缓解

### 风险 1：共享骨架抽过头

缓解：

- 共享层只抽菜单循环和通用 action；
- snapshot 拉取、OAuth 登录、store 结构、展示字段继续保留在 adapter 层。

### 风险 2：Codex 菜单污染 Copilot 语义

缓解：

- Codex adapter 禁止访问 `modelAccountAssignments`、routing state、network retry 配置；
- 切换账号时只写回 `openai` auth provider。

### 风险 3：首次自动导入覆盖用户已有管理结果

缓解：

- bootstrap 只在 Codex store 为空时执行；
- 一旦用户已有 Codex 账号池，后续不再自动重建。

## 实现顺序

1. 抽共享菜单 runtime，并先让 Copilot 迁移过去。
2. 保持 Copilot 行为不变，补共享层与 Copilot 回归测试。
3. 新增 Codex adapter、Codex store 与独立菜单入口。
4. 接入上游 OpenAI OAuth 登录与首次 `auth.json` 自动导入。
5. 接入 Codex snapshot 刷新与菜单展示。

## 预期结果

完成后应达到：

1. 用户可以在独立 Codex 菜单里管理多个 OpenAI/Codex 账号；
2. Codex 拥有和 Copilot 同款的登录、切换、删除、snapshot 刷新体验；
3. 共享菜单骨架只负责交互与通用流程，provider-specific 差异继续清晰隔离；
4. 后续再扩更多 provider 时，不需要再次复制整套菜单主循环。
