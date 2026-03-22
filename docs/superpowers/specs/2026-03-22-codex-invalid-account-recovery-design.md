# Codex 无效账号移除与状态展示收敛设计

## 背景

当前 Codex 多账号菜单与 `/codex-status` 已能完成以下能力：

- 维护独立的 Codex 账号池；
- 刷新每个账号的 `5h` / `week` snapshot；
- 在 `openai` provider 下切换当前激活的 Codex 账号；
- 通过 `/codex-status` 拉取当前 OpenAI OAuth 对应账号的状态并写回本地 store。

但目前仍有两个直接影响可用性的缺口：

1. 当 OpenAI token refresh 返回 `400` 时，系统只把它当成普通失败；无效账号不会被自动移除，也不会切到下一个还能用的账号。
2. `/codex-status` 当前输出仍偏向调试视角，字段过多。用户真正关心的是账号名、workspace 名、`5h` 配额、`week` 配额，而不是完整 identity / credits / accountId 明细。

用户要求本次把错误覆盖做宽一些，但只有明确的 `400` refresh 失败才触发移除和自动切号；其他错误要保守处理，只提示、不切换。

## 目标

1. 对 Codex 的状态刷新与菜单 snapshot 刷新建立统一错误分层。
2. 当出现 `Error: Token refresh failed: 400` 时，自动移除当前无效账号，并提示用户该账号对应的 workspace。
3. 在移除无效账号后，自动切到下一个最可用的账号，并同步切换 `openai` auth。
4. 给 Codex store 增加稳定的 `workspaceName` 字段，优先用于用户可见提示与状态展示。
5. 把 `/codex-status` 收敛成和 `copilot-status` 一样偏摘要化的紧凑输出，只保留用户真正关心的信息。

## 非目标

1. 不把 401 / 429 / timeout / network error 视为无效账号。
2. 不因为所有错误都触发自动删号或切号。
3. 不扩展到 Copilot provider 的错误恢复逻辑。
4. 不新增 workspace 手工编辑 UI。
5. 不改变现有 Codex OAuth 主流程，只补充 workspace 元信息提取与无效账号恢复。

## 方案选择

采用“共享 Codex 错误恢复 helper + 只有 refresh-400 触发账号移除/切换”的方案。

原因：

- `/codex-status` 与 Codex 菜单刷新本质上都在消费同一类 Codex status fetch 结果，账号失效逻辑不应分叉；
- 把自动移除/切换严格限定在 refresh-400 上，能避免把暂时性错误误判成账号失效；
- 统一 workspace 标识后，toast 和状态展示可以对齐，不再混用 accountId / email / name。

## 设计细节

### 1. Codex 错误分层

`fetchCodexStatus()` 当前会返回 `rate_limited`、`timeout`、`server_error`、`invalid_response`、`unauthorized`、`network_error`。本次在此基础上补一个明确的 refresh-400 失效类型，例如：

```ts
type CodexStatusError =
  | { kind: "invalid_account"; status: 400; message: string }
  | { kind: "rate_limited"; status: 429; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "server_error"; status: number; message: string }
  | { kind: "invalid_response"; message: string }
  | { kind: "unauthorized"; status: 401; message: string }
  | { kind: "network_error"; message: string }
```

判定标准：

- 只在 refresh token 流程抛出明确的 `Token refresh failed: 400` 时产出 `invalid_account`；
- 普通 400 响应、401、429、fetch throw、非 JSON 响应等仍维持原有 error kind；
- 上层逻辑只能根据结构化 `kind` 做行为分流，不再依赖字符串包含判断。

### 2. workspaceName 元信息

给 `CodexAccountEntry` 增加：

```ts
type CodexAccountEntry = {
  ...
  workspaceName?: string
}
```

来源优先级：

1. OAuth token claims 中的 organization / workspace 标识；
2. store 里已存在的 `workspaceName`；
3. 账号名 `name`；
4. `email`；
5. `accountId`。

使用原则：

- 用户可见 toast 优先展示 `workspaceName`；
- `/codex-status` 的 `Workspace:` 行优先展示 `workspaceName`；
- 如果后续 status 响应里出现更可信的 workspace identity，也允许刷新覆盖已有值。

### 3. 共享的无效账号恢复 helper

新增一个共享 helper，专门负责 Codex 账号移除与候选切换决策。`/codex-status` 与 `codex-menu-adapter.refreshSnapshots()` 都调用它。

输入：

- 当前 Codex store；
- 当前失效账号名或 accountId；
- 是否需要同步切换 `openai` auth；
- 当前时间（用于测试稳定）；
- toast 回调；
- `client.auth.set()` 或等价 auth persistence 能力。

输出：

- 被移除的账号信息；
- 是否切换到新账号；
- 新 active 是谁；
- 是否只能切到 `week` 待恢复账号；
- 是否已经没有任何候选可用账号。

helper 的职责：

1. 删除当前无效账号；
2. 根据剩余 snapshot 选择候选；
3. 如有候选，则更新 `store.active` 并同步 `openai` auth；
4. 如无候选，则清空 `store.active`；
5. 返回适合上层拼接 toast 的结构化结果。

### 4. 候选切换排序规则

用户明确要求候选选择遵循以下顺序：

1. 优先考虑 `week > 0` 的账号；
2. 在这些账号里，如果存在 `5h > 0`，选择 `5h resetAt` 最早恢复的账号；
3. 如果这些账号都没有 `5h > 0`，则选择 `week resetAt` 最早恢复的账号；
4. 如果所有账号 `week == 0`，仍切到 `week resetAt` 最早恢复的账号，并额外提示用户检查账号状态。

补充约束：

- `resetAt` 缺失时，排序优先级低于有明确恢复时间的账号；
- 只有“移除当前无效账号后已没有剩余账号”时，才判定为无候选；
- 若发生完全并列，按现有 store 中的稳定顺序选第一个，避免非确定性切换。

### 5. toast 文案

用户提示必须围绕 workspace 来写。固定主句模板为：

```text
无效账号 {displayName} 已移除，请及时检查核对。
```

其中 `displayName = workspaceName || name || email || accountId`。

在此基础上，上层可按 helper 结果拼接以下场景：

1. **移除并切到正常候选**

```text
无效账号 <workspace> 已移除，请及时检查核对。
已切换到 <next-workspace>。
```

2. **移除并切到仅 week 待恢复候选**

```text
无效账号 <workspace> 已移除，请及时检查核对。
已切换到 <next-workspace>。
当前仅切换到周配额待恢复账号，请检查账号状态。
```

3. **移除后没有任何可用账号**

```text
无效账号 <workspace> 已移除，请及时检查核对。
当前没有可用的 Codex 账号，请重新登录并检查账号状态。
```

### 6. `/codex-status` 输出收敛

当前 `/codex-status` 成功态和缓存态都包含过多 identity / credits / section header。调整后统一收敛为只包含四行字段的紧凑摘要格式：

```text
账号: <account-name>
Workspace: <workspace-name>
5h: <remaining>
week: <remaining>
```

约束：

- `账号` 优先显示 store 中当前账号名；
- `Workspace` 优先显示 `workspaceName`；
- `5h` 和 `week` 继续复用现有百分比 / `remaining/entitlement` 展示逻辑；
- 不再输出 `accountId`、`email`、`credits`、`[identity]`、`[usage]`，也不附加 `Codex status updated.`、cached 前缀等额外正文；
- 如果需要说明这是缓存回退或刷新失败，放到独立 toast 提示里，不放进命令正文。

### 7. `/codex-status` 与菜单刷新如何协同

两条路径的统一原则：

- 如果 `fetchCodexStatus()` 返回 `invalid_account`：
  - 调共享 helper 删除并切号；
  - toast 提示用户无效账号已移除；
  - `/codex-status` 终止本次处理，不再把旧账号写回 store；
  - 菜单刷新对当前坏账号不再保留旧 snapshot。
- 如果返回非 `invalid_account` 的错误：
  - 保留账号；
  - `/codex-status` 仍走当前“有缓存则展示缓存、无缓存则报错”的策略；
  - 菜单刷新只在对应 entry 上写 `snapshot.error`。

这样能保证“错误覆盖更广，但只有 400 切号”的边界清晰不漂移。

## 影响文件

- `src/codex-status-fetcher.ts`
  - 新增 refresh-400 结构化错误；
  - 在可用处补 workspace identity 提取。
- `src/codex-store.ts`
  - 为 `CodexAccountEntry` 增加 `workspaceName`；
  - 保持新旧 store 兼容读写。
- `src/codex-oauth.ts`
  - 从 token claims 提取 workspace / organization 标识。
- `src/providers/codex-menu-adapter.ts`
  - 菜单 snapshot 刷新接入共享失效账号恢复 helper；
  - 刷新后同步维护 `workspaceName`。
- `src/codex-status-command.ts`
  - `/codex-status` 接入共享 helper；
  - 重写成功态、缓存态、失效账号提示文案。
- `src/codex-invalid-account.ts`（建议新增）
  - 放共享 helper 与候选排序逻辑。

## 测试策略

1. `test/codex-status-fetcher.test.js`
   - refresh token 返回 400 时产出 `invalid_account`；
   - 非 400 refresh 错误不产出 `invalid_account`；
   - workspace 标识提取按优先级工作。

2. `test/codex-invalid-account.test.js`（建议新增）
   - 删除无效账号后切到 `week > 0 && 5h > 0` 且 `5h resetAt` 最早的账号；
   - 若没有 `5h > 0`，切到 `week resetAt` 最早的账号；
   - 若所有 `week == 0`，仍切到 `week resetAt` 最早的账号并标记需要额外提示；
   - 无候选时清空 active；
   - 成功切号时同步写 `openai` auth。

3. `test/codex-menu-adapter.test.js`
   - `refreshSnapshots()` 遇到 `invalid_account` 时删除对应账号；
   - 删除后会切到正确 fallback；
   - 非 400 错误仍只写 `snapshot.error`，不会删号。

4. `test/codex-status-command.test.js`
   - 成功态 / cached 态只输出 `账号 / Workspace / 5h / week`；
   - refresh-400 时显示“无效账号已移除”并在需要时追加切号提示；
   - 非 400 错误保持缓存回退，不切号。

## 风险与控制

1. **风险：误判失效账号**
   - 控制：只有 refresh-400 才会触发删号；其余错误全部保守处理。

2. **风险：候选排序不稳定导致切号不可预测**
   - 控制：把排序规则抽成纯函数并单测覆盖，完全并列时保持 store 顺序稳定。

3. **风险：菜单和 `/codex-status` 行为再次分叉**
   - 控制：共享 helper 只实现一份，两个入口都必须复用。

4. **风险：workspace 来源不稳定**
   - 控制：workspace 仅作为用户提示友好名称，不参与 auth 主键；主键仍保持账号名 / accountId 体系。

## 验收标准

1. 当 refresh token 返回 `400` 时，当前 Codex 账号会被自动移除。
2. 用户能在 toast 中看到以 workspace 为主的“无效账号已移除，请及时检查核对”提示。
3. 系统会按约定规则自动切到下一个账号，并同步更新 `openai` auth。
4. 如果只能切到 `week` 待恢复账号，会额外提示用户检查账号状态。
5. `/codex-status` 成功态与缓存态都只展示账号、workspace、5h、week 四类核心信息。
6. 非 400 错误不会触发删号和切号。
