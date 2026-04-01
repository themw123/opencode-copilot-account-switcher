# Codex 登录回切 Upstream Snapshot 设计

## 背景

当前仓库里，Codex provider 的官方能力实际上被拆成了两半：

- `fetch` / `chat.headers` 通过 `src/upstream/codex-plugin.snapshot.ts` 与 `src/upstream/codex-loader-adapter.ts` 接入；
- 但“新增账号 / OAuth 登录”没有走 snapshot，而是在 `feat(codex): 新增独立菜单与多账号切换能力` 时新增了 `src/codex-oauth.ts`，并由 `src/providers/codex-menu-adapter.ts` 直接调用 `runCodexOAuth()`。

这和既定设计目标不一致。用户的目标是：Codex 像 Copilot 一样，凡是上游已有官方 provider 逻辑的部分，都应优先通过 upstream snapshot 适配，而不是在插件里再手写一套并长期漂移。

这次暴露出来的 Windows 浏览器打开失败，只是这个偏差的一个症状：

- 实际报错来自 `src/codex-oauth.ts` 的本地浏览器打开实现；
- 宿主日志显示失败点在本插件自己的 `dist/codex-oauth.js`，而不是 upstream / snapshot；
- 最新 upstream `packages/opencode/src/plugin/codex.ts` 已经包含完整的 browser + headless OAuth methods；
- 但当前 `src/upstream/codex-plugin.snapshot.ts` 仍停留在旧快照，只保留了占位 `methods`，没有同步完整 auth methods；
- 当前 `sync-codex-upstream.mjs` 的 shim 也只足够支撑 `auth.loader` / `chat.headers` 这一级，并不足以安全承载最新 upstream 的完整 `codex.ts`。

因此，本次问题不能只修 `cmd /c start`。那样只是修掉一个症状，仍然保留偏离上游的登录链路。正确方向是把 Codex 登录整条链路回切到 upstream snapshot 级别。

## 目标

1. 让 Codex 登录链路与 Copilot 达到同一级别的 upstream snapshot 集成程度。
2. 让 Codex 的 `auth methods` 与 `auth.loader` / `chat.headers` 一样，直接来源于 upstream `packages/opencode/src/plugin/codex.ts`。
3. 让菜单层只负责多账号管理与落库，不再自定义 OAuth 细节。
4. 删除或彻底停用 `src/codex-oauth.ts`，消除后续再次漂移的源头。
5. 保持现有 Codex 多账号 store、菜单入口与 snapshot 展示能力不变。

## 非目标

1. 不修改 Copilot 登录链路。
2. 不重写 Codex 多账号 store 结构。
3. 不改变现有 Codex 菜单信息架构、刷新按钮与多账号切换体验。
4. 不在插件业务代码中复制 upstream OAuth 逻辑作为“兜底实现”。
5. 不在本次顺手扩展与本问题无关的 Codex 功能。

## 核心结论

本次改动的本质不是“修一个 Windows 打开浏览器命令”。

本次改动的本质是：

- 补齐 `sync-codex-upstream.mjs` 与 `codex-plugin.snapshot.ts`，使其能够承载最新 upstream `codex.ts`；
- 在 `codex-loader-adapter.ts` 暴露官方 `auth.methods`；
- 将 `codex-menu-adapter.ts` 的新增账号流程切回官方 `authorize -> callback` 链路；
- 把 `src/codex-oauth.ts` 从登录主路径中移除。

这样浏览器打开责任会自然回到 upstream / snapshot 语义，宿主只再负责它原本就该负责的 provider auth 流程。

## 方案选择

### 方案 A：只修本地 `openUrlDefault()`

做法：

- 在 `src/codex-oauth.ts` 中修正 Windows 下浏览器打开逻辑；
- 保留其余自定义 OAuth 结构不变。

优点：

- 最快见效；
- 对当前测试改动最少。

缺点：

- 仍然保留和上游分叉的登录实现；
- 下次 upstream `codex.ts` 演进时仍会继续漂移；
- 违背“至少达到和 Copilot 相同程度”的目标。

### 方案 B：保留本地外壳，内部尽量包装 snapshot

做法：

- 继续保留 `runCodexOAuth()` 这样的本地登录入口；
- 但内部尽量转调官方 `authorize()` / `callback()`。

优点：

- 可以减少对现有菜单代码的冲击；
- 短期兼容测试可能更容易。

缺点：

- 仍有一层本地登录外壳；
- 责任边界仍不干净；
- 长期看依然容易在“官方行为”和“插件行为”之间出现双重语义。

### 方案 C：完整回切到 upstream snapshot 级别

做法：

- 同步最新 upstream `packages/opencode/src/plugin/codex.ts`；
- 让 snapshot 真正包含完整官方 auth methods；
- 在 loader adapter 层导出官方 methods；
- 在 menu adapter 层只做“调用官方方法并归一化结果”的薄适配；
- 删除或停用 `src/codex-oauth.ts`。

优点：

- 最符合设计目标；
- 与 Copilot 的 snapshot 策略对齐；
- 后续只要维护 sync / snapshot，不再需要同时维护第二套本地 OAuth 细节。

缺点：

- 需要同步修改 sync 脚本、snapshot、loader adapter、menu adapter 与测试；
- 一次性改动面较大。

### 选定方案

采用方案 C。

原因：用户已明确要求“完全贴近上游，至少达到和 Copilot 相同的程度”，而不是先做一个症状修复或半回切折中方案。

## 现状与差异

### 1. 当前本仓库的 Codex 登录链路

- `src/plugin.ts`
  - `Manage OpenAI Codex accounts` 通过 `runCodexMenu()` 进入独立菜单；
- `src/providers/codex-menu-adapter.ts`
  - `authorizeNewAccount()` 当前直接调用 `runCodexOAuth()`；
- `src/codex-oauth.ts`
  - 自己实现 browser/headless 模式选择；
  - 自己实现本地 OAuth server；
  - 自己实现 `openUrlDefault()`；
  - 自己做 token 交换、claims 解析与结果归一化。

这说明当前 Codex 登录主路径是“插件自定义 OAuth 实现”，不是“官方 snapshot 驱动”。

### 2. 当前 snapshot 的状态

- `src/upstream/codex-plugin.snapshot.ts`
  - `auth.loader` 存在；
  - `chat.headers` 存在；
  - `methods` 仍是占位 browser method，`authorize()` 返回空 URL 与失败 callback；
- `src/upstream/codex-loader-adapter.ts`
  - 目前只暴露官方 fetch / chat headers 适配；
  - 没有暴露官方 auth methods。

### 3. 最新 upstream 的状态

最新 upstream `packages/opencode/src/plugin/codex.ts` 已包含：

- browser OAuth method；
- headless OAuth method；
- API key method；
- 本地 OAuth server；
- access token refresh；
- 更完整的 model 过滤与 cost 归零逻辑。

这证明“官方登录逻辑已存在”，问题不在 upstream 缺能力，而在本仓库 snapshot 与接线没有跟上。

### 4. 当前 sync 脚本的缺口

`scripts/sync-codex-upstream.mjs` 目前的 shim 只覆盖了：

- `AsyncLocalStorage` bridge；
- `Installation.VERSION`；
- `fetch` 替换；
- `OAUTH_DUMMY_KEY` 常量。

但最新 upstream `codex.ts` 还引入或依赖：

- `Log.create(...)`；
- `sleep(...)`；
- 更复杂的 auth refresh 行为；
- 完整 `methods` 实现；
- 以及比旧 snapshot 更大的运行时代码面。

这意味着，如果直接把最新 upstream 内容塞进当前 snapshot 生成器，生成结果并不能保证可运行。必须先扩展 sync shim 与对应测试。

## 设计细节

### 1. `sync-codex-upstream.mjs` 升级为“完整 auth snapshot 同步器”

目标：让它像 Copilot 的 sync 脚本一样，生成一个可以运行最新 upstream `codex.ts` 核心行为的 snapshot，而不是只保留部分锚点。

需要调整：

1. 扩展 `buildShimBlock()`：
   - 补充 `sleep()` shim；
   - 补充 `Bun` 兼容 shim（若最新 upstream 仍依赖类似运行时能力）；
   - 补充最小 `Log` shim；
   - 补充 `Auth` / `OAUTH_DUMMY_KEY` 等运行时所需桥接；
   - 仅补齐“让 snapshot 可运行”所需的本地 shim，不在 snapshot 文件中手写业务逻辑。
2. 扩展锚点校验：
   - 不再只检查 `CodexAuthPlugin` / `auth.loader` / `chat.headers`；
   - 需要增加对 `methods` 存在与结构的校验，确保 sync 不会把 auth methods 丢掉。
3. 扩展 drift 测试：
   - fixture 不能再只覆盖空壳 `methods`；
   - 必须覆盖 browser / headless / api 三类 method 至少存在的结构性断言。

原则：

- 所有上游业务逻辑仍来自同步结果；
- 本地 sync 只负责“把上游文件变成在本仓库 snapshot 环境可运行的等价形态”。

### 2. `codex-loader-adapter.ts` 增加官方 auth methods 导出

当前该文件只暴露：

- `loadOfficialCodexConfig()`；
- `loadOfficialCodexChatHeaders()`。

本次增加第三类能力：

- `loadOfficialCodexAuthMethods()`。

职责：

1. 通过与现有 `runWithOfficialBridge()` 相同的桥接上下文加载 upstream `CodexAuthPlugin()`；
2. 读取其 `auth.methods`；
3. 向上层返回“可直接执行 `authorize()` 的官方 methods”；
4. 不在 adapter 内重写方法行为，只做类型整理与桥接。

这样可以形成一致模式：

- 官方 fetch 行为走 `loadOfficialCodexConfig()`；
- 官方 chat headers 走 `loadOfficialCodexChatHeaders()`；
- 官方 auth methods 走 `loadOfficialCodexAuthMethods()`。

### 3. `codex-menu-adapter.ts` 改为薄接线层

`authorizeNewAccount()` 的新职责应该是：

1. 加载官方 auth methods；
2. 根据菜单需要选择 browser/headless 两种 OAuth method；
3. 执行官方 `authorize()`，拿到 `url` / `instructions` / `method` / `callback`；
4. 执行官方 `callback()`；
5. 将成功结果最小归一化为本地 `CodexAccountEntry`；
6. 同时写回 `client.auth.set({ path: { id: "openai" } })`。

允许的本地补充仅限于：

- 将官方成功结果映射到本地 store 字段；
- 在必要时从 token 中补 `workspaceName` / `email` 等菜单显示字段。

禁止的本地行为：

- 再次实现 OAuth server；
- 再次实现浏览器打开；
- 再次实现 device polling；
- 再次实现 token exchange；
- 再次实现官方 method 语义分支。

### 4. `plugin.ts` 收缩到入口与菜单编排

`plugin.ts` 仍保留：

- `Manage OpenAI Codex accounts` 入口；
- `runCodexMenu()` 菜单主循环；
- 将 `openai` provider 指向 Codex 菜单。

但不再承担：

- `runCodexOAuth()` 调用；
- 任何自定义 Codex 登录实现。

这意味着 `plugin.ts` 对 Codex auth 的认知只剩“菜单入口”和“把新增账号动作交给 adapter”。

### 5. `src/codex-oauth.ts` 退出主路径

本次目标是删除或彻底停用它。

首选：

- 直接删除文件与对应测试。

如果在迁移过程中需要短暂保留：

- 也必须确保无任何生产调用路径再引用它；
- 最终合入前仍应删除，避免未来误用。

### 6. 多账号与 store 兼容边界保持不变

以下内容继续保留为本地职责：

- Codex store 的多账号结构；
- `authorizeNewAccount()` 成功后的落库；
- 当前 active 账号选择规则；
- 菜单中的账号命名、删除、切换、刷新 snapshot；
- `workspaceName` / `email` 等菜单摘要字段的本地展示。

也就是说：

- `auth` 行为上游化；
- `account management` 行为本地化。

## 影响文件

### 必改

- `scripts/sync-codex-upstream.mjs`
- `src/upstream/codex-plugin.snapshot.ts`
- `src/upstream/codex-loader-adapter.ts`
- `src/providers/codex-menu-adapter.ts`
- `src/plugin.ts`

### 预期删除或停用

- `src/codex-oauth.ts`

### 必改测试

- `test/codex-sync.test.js`
- `test/codex-loader-adapter.test.js`
- `test/codex-menu-adapter.test.js`
- 任何当前直接测试 `runCodexOAuth()` 的测试

### 可能补充的新测试方向

- 官方 auth methods 加载测试
- browser/headless method 选择与回调接线测试
- “菜单新增账号使用官方 method 而非本地 oauth 文件”的回归测试

## 验证策略

### 1. 失败测试先行

先写失败测试证明当前偏差存在：

1. `codex-loader-adapter` 当前无法导出官方 auth methods；
2. `codex-menu-adapter.authorizeNewAccount()` 当前仍依赖 `runCodexOAuth()`；
3. sync fixture 当前无法覆盖完整 auth methods 结构。

### 2. sync / snapshot 验证

必须新增或更新测试，验证：

1. 生成的 snapshot 含有 browser/headless/api 三类 methods；
2. snapshot 文件仍保留可验证的 upstream metadata；
3. `check:codex-sync` 对新的 snapshot 结构仍能稳定判定 drift。

### 3. loader adapter 验证

必须验证：

1. 可以加载官方 auth methods；
2. 官方 methods 的 `authorize()` / `callback()` 能在 bridge 环境下执行；
3. 不影响现有 `loadOfficialCodexConfig()` / `loadOfficialCodexChatHeaders()` 行为。

### 4. menu adapter 验证

必须验证：

1. browser 方法成功时能正确入库并写回 `openai` auth；
2. headless 方法成功时能正确入库并写回 `openai` auth；
3. 取消或失败时不会污染 store；
4. 若菜单仍保留 browser/headless 选择，选择动作只是 method 选择，不是本地 OAuth 实现。

### 5. 全量验证

1. 运行完整 `npm test`；
2. 用真实 `opencode auth login --provider openai` 做一次宿主级验证；
3. 重点确认浏览器打开失败已不再出自本插件私有 `codex-oauth` 逻辑。

## 风险与约束

### 1. 最新 upstream `codex.ts` 可能继续演进

因此不能只手改当前 snapshot 文件，必须把变更沉淀到 `sync-codex-upstream.mjs`。

### 2. 最新 upstream `codex.ts` 依赖比旧 snapshot 更复杂

这要求 shim 设计足够最小但完整。原则是：

- 在 sync 层补运行时桥；
- 不在业务层复制 upstream 行为。

### 3. 本地 store 仍需要菜单级元数据

如果官方成功结果里不直接包含 `workspaceName` / `email`，可以在“成功结果归一化”阶段薄补充，但不能因此重新发明 OAuth 流程。

## 最终结果

改完后，Codex provider 应满足以下状态：

1. `fetch` / `chat.headers` / `auth methods` 都由 upstream snapshot 驱动；
2. `codex-menu-adapter` 只负责多账号菜单与结果入库；
3. `src/codex-oauth.ts` 不再是生产链路的一部分；
4. Codex 登录与 Copilot 一样，回到“官方 provider 行为 + 本地多账号管理”的分层模型。
