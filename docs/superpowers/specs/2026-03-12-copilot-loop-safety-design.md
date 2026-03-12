# Copilot Guided Loop Safety 设计

## 目标

在现有 `opencode-copilot-account-switcher` 插件中，把用户可开关的 `Loop Safety` 能力升级为更易理解的 `Guided Loop Safety`：

- 仅对 `github-copilot` 与 `github-copilot-enterprise` 会话生效
- 通过 `experimental.chat.system.transform` 注入固定 system policy
- 在 `question` 工具可用且未被拒绝时，强制所有用户可见汇报必须走 `question`
- 通过更细的提示词规则，减少不必要的对话中断与不必要的 `task` / 子代理调用
- 在需要时引导模型把长报告拆成分页或分批的 `question` 汇报，而不是一次塞满
- 在现有 Copilot 账号菜单中提供更易懂的开关名称与说明文案

## 非目标

- 不修改 OpenCode core。
- 不修改 `superpowers` 插件。
- 不通过 `agent.prompt` 覆盖 provider prompt。
- 不影响非 Copilot provider。
- 不新增第二个持久化开关字段；已有 `loopSafetyEnabled` 保持兼容即可。
- 不改变当前插件的账号管理、配额查询、模型检查等原有能力。

## 约束与证据

- OpenCode 会通过 `experimental.chat.system.transform` 在 provider prompt 与 instructions 之后追加插件提供的 system 文本；因此它是本功能的正确接入点。
- 当前发布版 `@opencode-ai/plugin` 类型未声明 `experimental.chat.system.transform`，实现必须继续使用本地扩展 hook 类型。
- 现有插件已经拥有 Copilot 登录菜单与持久化 store `~/.config/opencode/copilot-accounts.json`，因此应该直接复用，不新增额外控制面板。
- OpenCode CLI 的正确 smoke test 命令是 `opencode auth login --provider github-copilot`；`opencode auth login github-copilot` 会把参数当作 URL 处理，不适合作为本功能验证命令。

## 推荐方案

保持单一运行时插件导出，并在现有结构内做最小修改：

1. 更新 `src/loop-safety-plugin.ts` 中的固定 policy 文本与 Copilot-only prompt 注入语义
2. 更新 `src/ui/menu.ts` 中的 `Guided Loop Safety` 菜单文案与说明
3. 更新 `README.md` 与测试，使新命名和严格规则保持一致

这样做的原因：

- 用户可见命名和运行时行为可以同时变得更清晰
- 内部持久化字段不需要迁移，兼容已有 store
- 变更仍然集中在少数既有文件内，不需要重构主 auth 流程

## 用户可见行为

### 菜单命名与说明

现有 `GitHub Copilot accounts` 菜单中的开关改为：

- `Enable guided loop safety`
- `Disable guided loop safety`

该菜单项仍然位于 `Actions` 分组中、`Set refresh interval` 之后、分隔线之前。

菜单 hint 应从当前过于模糊的短文本，改成更可理解的效果说明。推荐固定文案：

```text
Prompt-guided: fewer report interruptions, fewer unnecessary subagents
```

这条 hint 需要明确告诉用户：

- 这是提示词引导，而不是硬规则引擎
- 目标是减少汇报时的打断感
- 目标是减少不必要的子代理调用

### 精确注入的 Policy

注入的 system block 应保持固定字符串，便于测试、审阅与后续行为对齐。

```text
Guided Loop Safety Policy
- Continue working on any remaining non-blocked task before stopping to report or wait for more instructions.
- If you are not fully blocked, do not stop just because you feel ready to pause; finish the work that can still be done safely.
- When the question tool is available and permitted in the current session, all user-facing reports must be delivered through the question tool.
- The question tool is considered available and permitted when it appears in the active tool list and the current session has not denied its use.
- Direct assistant text is allowed only when the question tool is unavailable, denied, or absent from the current session.
- When reporting multiple related items, prefer a single question tool call with multiple well-grouped questions instead of multiple separate interruptions.
- Group related items into clear question batches such as current progress, key findings, and next-step choices.
- For long or complex reports, split the report into paginated or sequential question batches instead of overloading one large message.
- Present the highest-priority information first and defer secondary details to later question batches when needed.
- Even when no explicit decision is required, prefer brief question-tool status updates over direct assistant text whenever the tool is available.
- Avoid unnecessary question frequency; combine small related updates when a single question call can cover them clearly.
- When no further action can be taken safely and no non-blocked work remains, use the question tool to ask for the next task or clarification instead of ending with direct assistant text.
- Dispatching task or subagent work is expensive and should be avoided unless it materially improves the result.
- Materially improves the result means clearly beneficial cases such as parallel analysis of independent areas; it does not include routine local searches, small file reads, or straightforward edits.
- If task or subagent delegation is used, keep the number minimal and explain the reason briefly through the question tool when available.
```

实现约束：

- 必须完整、原样注入，不做动态改写
- 在一次 transform 中最多追加一次
- 如果 `system` 任意位置已经包含这段完整文本，则不得重复追加

### 会话行为

当 `Guided Loop Safety` 开启，且 provider 为 `github-copilot` 或 `github-copilot-enterprise` 时：

- 追加上面的完整 policy
- 模型在所有用户可见汇报中都必须优先使用 `question`
- 只要还有非阻塞工作可做，模型就必须继续执行，不能因为“想暂停”而提前停下
- 当有多个相关汇报事项时，必须优先合并到一次 `question` 调用中
- 当报告很长时，必须拆成分页或分批的 question，而不是单次倾倒全部内容
- 当当前确实没有任何可安全执行的动作时，模型必须通过 `question` 主动询问下一项任务或所需澄清，而不是直接文本收尾
- 对简单本地任务应避免先发 `task` / 子代理，而优先使用直接本地工具

当功能关闭，或 provider 不是 Copilot 时：

- 不注入任何额外 system 文本

## 架构

### `src/loop-safety-plugin.ts`

继续作为 Guided Loop Safety 的核心模块，职责更新为：

- 定义新的固定 policy 文本
- 暴露 `isCopilotProvider(providerID)`
- 暴露纯函数 `applyLoopSafetyPolicy()`，判断是否追加 policy
- 暴露 `createLoopSafetySystemTransform()`，每次调用时重新读取 store 状态
- 继续定义本地 `experimental.chat.system.transform` hook 类型

规则约束：

- provider 非 Copilot 或开关关闭时，必须原样返回已有 `system`
- provider 为 Copilot 且开关开启时，只能在尾部追加一个新字符串
- 不得清空、替换、重排已有 system entries
- 必须保持幂等

### `src/store.ts`

内部持久化字段继续保留：

```ts
loopSafetyEnabled?: boolean
```

即使用户可见名称升级为 `Guided Loop Safety`，也不额外引入 `guidedLoopSafetyEnabled` 之类的新字段，避免迁移与兼容成本。

兼容规则保持不变：

- 缺失字段等价于 `false`
- 老 store 文件无需迁移
- 读写路径继续共享同一套规范化逻辑

### `src/ui/menu.ts`

菜单动作类型保持：

```ts
{ type: "toggle-loop-safety" }
```

但用户可见文案更新为 `Guided Loop Safety`：

- label 精确为 `Enable guided loop safety` / `Disable guided loop safety`
- hint 精确为上文推荐的说明文本
- 原有 placement 约束不变

若现有 `buildMenuItems()` 已存在，则继续保留并仅做最小文案修改，因为这次重命名与 hint 细化仍然最适合通过确定性测试验证。

### `src/plugin.ts`

`CopilotAccountSwitcher` 继续作为唯一插件导出。

需要保持的行为：

- 菜单读取并显示当前 `loopSafetyEnabled`
- 切换开关时翻转 `store.loopSafetyEnabled`
- 通过 `writeStore()` 持久化
- 返回值继续同时包含 `auth` 与 `experimental.chat.system.transform`

本次不应改动现有 OAuth 登录、导入、配额查询、模型检查等分支逻辑。

### `src/index.ts`

如果测试仍然依赖 `applyMenuAction` / `buildPluginHooks` re-export，则继续保留这些测试出口。

## Hook 类型策略

由于 upstream typings 仍未声明 `experimental.chat.system.transform`，本地扩展类型继续保持类似：

```ts
type ExperimentalChatSystemTransformHook = (
  input: { sessionID: string; model: { providerID: string } },
  output: { system: string[] },
) => Promise<void>

type CopilotPluginHooks = Hooks & {
  "experimental.chat.system.transform"?: ExperimentalChatSystemTransformHook
}
```

这次变更只更新 policy 文本与相关语义，不改变 hook 的运行时 contract。

## 数据流

### 开关流程

1. 用户运行 `opencode auth login --provider github-copilot`
2. 插件读取 `copilot-accounts.json`
3. 菜单显示当前 `Guided Loop Safety` 状态
4. 用户切换开关
5. 插件翻转 `store.loopSafetyEnabled`
6. 插件持久化 store
7. 菜单重新渲染，显示新的文案状态

### Prompt 注入流程

1. OpenCode 组装 provider + instructions system prompts
2. 插件收到 `experimental.chat.system.transform`
3. 插件检查 `model.providerID`
4. 插件即时读取 store 中的 `loopSafetyEnabled`
5. 如果 provider 是 Copilot 且功能开启，则追加新的 `Guided Loop Safety Policy`
6. 否则不做任何修改

## 错误处理

- store 文件不存在时，默认视为 `{ accounts: {} }` 且开关关闭
- prompt 注入读取 store 失败时继续 fail-open，跳过 policy 注入而不是中断请求
- 菜单路径读取或写入 store 失败时，继续向用户暴露错误，不静默吞掉
- policy 文本本身不再允许“只要 question 可用仍可直接文本 fallback”的宽松规则
- direct text fallback 只在 `question` 不可用、被拒绝、或当前会话根本没有该工具时才允许

## 测试计划

### 自动化测试

需要更新并保留以下测试覆盖：

1. policy 常量必须精确匹配新的 `Guided Loop Safety Policy` 文本
2. Copilot provider + 开启状态时只追加一次
3. 非 Copilot provider 或关闭状态时完全不追加
4. 菜单项文案改为 `Enable guided loop safety` / `Disable guided loop safety`
5. 菜单 hint 改为新的解释型文案
6. 位置约束仍然成立：在 `Set refresh interval` 之后、Actions 分隔线之前
7. `applyMenuAction()` 仍能正确翻转并持久化 `loopSafetyEnabled`
8. `buildPluginHooks()` 仍暴露 `auth` 与 `experimental.chat.system.transform`

### 手工 Smoke Test

使用正确命令：

```bash
opencode auth login --provider github-copilot
```

验证点：

1. 菜单里出现 `Enable guided loop safety`
2. hint 文案能明显表达“提示词引导、减少打断、减少子代理”
3. 开启后再次进入菜单，文案变成 `Disable guided loop safety`
4. `~/.config/opencode/copilot-accounts.json` 中的 `loopSafetyEnabled` 与菜单状态一致

### 置信度验证

该功能本质上是 prompt 注入，不是运行时硬约束；但只要 `question` 工具存在且可用，规格要求注入文本必须明确表达为严格 `question-first`，不能再写成宽松的“偏向”规则。

可用的观察点：

- 对多项状态汇报，模型更倾向在一次 `question` 调用里合并多个相关问题
- 对长报告，模型更倾向拆分成分页或分批 question
- 对简单任务，模型更少无必要地调用 `task` / 子代理

## 已确认结论

- 用户可见命名采用 `Guided Loop Safety`
- policy 采用严格 `question-first`
- 只要 `question` 可用且被允许，就不允许退回直接文本
- 菜单说明需要更直白地解释“提示词引导、减少中断、减少子代理”
- 文档与测试都应同步新的命名与语义

## 实现备注

- 尽量只改命名、policy 文本、README 和相关测试，不做额外结构性重构。
- 若测试里已经依赖旧文案，应先按 TDD 改红，再最小改绿。
- README 中所有示例命令应同步修正为 `opencode auth login --provider github-copilot`，避免继续误导用户。
