# `/codex-status` 设计

## 背景

当前仓库已经完成了第一轮 Codex provider 结构预留：

- `src/providers/descriptor.ts` / `src/providers/registry.ts` 已经有 `codex` 占位；
- 共享 retry 骨架已经抽出；
- 但真正的 Codex 用户面能力仍然为空，尤其还没有 `codex-status`。

用户已经明确两点：

1. 现在要开始真正落地 `/codex-status`；
2. 实现时需要参考 `CrazyZhang123/myauth` 与 opencode 上游 provider 代码。

进一步确认后，本次 `/codex-status` 的目标不是“只看本地账号池”，而是**拉取远端 Codex/ChatGPT 状态并展示配额/订阅摘要**。

## 参考结论

### `myauth`

`myauth` 的 `status -> showAccountPool({ interactive: false })` 最终展示两层信息：

- 身份层：`index`、`email`、`plan`、`team_space`、当前账号标记；
- 状态层：`5h limit`、`Weekly limit`、剩余百分比、reset 时间、健康状态、错误摘要。

更关键的是，`myauth` 已经验证了 Codex 远端状态的请求方式：

- 请求：`GET https://chatgpt.com/backend-api/codex/usage`
- 鉴权头：
  - `Authorization: Bearer <access_token>`
  - `ChatGPT-Account-Id: <account_id>`
  - `Accept: application/json`
  - `User-Agent: Codex CLI`
- 401 时：用 refresh token 刷新 access token 后重试。

### opencode 上游

opencode 上游 `packages/opencode/src/plugin/codex.ts` 没有现成的 `/codex-status`，但它已经给出了 Codex OAuth 的正式接入方式：

- 使用 `openai` provider 下的 OAuth 凭据；
- 请求 Codex API 时使用 `Authorization` 和 `ChatGPT-Account-Id`；
- 必要时用 refresh token 刷新 access token；
- `accountId` 由 token claim 中提取。

因此，本仓库的 `/codex-status` 应该沿用同一套鉴权方式，而不是发明新的 Codex 登录/状态协议。

## 目标

1. 新增实验性 slash command：`/codex-status`。
2. 通过现有 OpenAI/Codex OAuth 凭据请求 Codex usage/status 远端接口。
3. 把账号身份和最近一次状态快照缓存到 Codex 专用 store，而不是复用 Copilot store。
4. 输出类似 `myauth` 的“身份 + 配额/健康摘要”结果，但适配当前插件的 toast/command 风格。

## 非目标

1. 不在本次实现 Codex 账号切换菜单或多账号交互 UI。
2. 不把 Codex 接到 Copilot 的 `modelAccountAssignments`、`x-initiator`、header rewrite、quota refresh 逻辑。
3. 不重构整个插件成为完整的 provider-status framework。
4. 不承诺固定展示一张和 Copilot 完全相同的 quota 表；远端字段缺失时允许优雅降级。

## 验收约束

本次实现必须满足以下隔离约束：

1. 不读写 `copilot-accounts.json`，只读写 Codex 专用 store。
2. 不读写 `modelAccountAssignments`、`activeAccountNames`、`lastQuotaRefresh` 等 Copilot 字段。
3. `/codex-status` 不进入 Copilot header rewrite、`x-initiator`、routing、network-retry 专属路径。
4. 不复用 Copilot quota fetcher 与 Copilot status command 文案。
5. 测试中必须有显式断言，证明 `/codex-status` 不会触碰上述 Copilot 逻辑。

## 方案总览

采用“**Codex 专用 store + 远端 usage fetcher + 独立 status command**”方案。

### 原则

- 认证来源跟随上游 `openai` OAuth；
- 状态缓存独立于 Copilot；
- 命令行为沿用当前 `/copilot-status` 的 slash command + toast 模式；
- 远端字段不稳定时 fail-open，只降级受影响区块。

## 模块设计

### 1. `codex-auth-source`

职责：

- 从当前 auth 数据中读取 `openai` OAuth 凭据；
- 提取 `access`、`refresh`、`expires`、`accountId`；
- 当 `accountId` 缺失时，按上游 Codex plugin 的逻辑从 JWT claims 里提取；
- access token 过期或被 401 拒绝时，用 refresh token 刷新并持久化回 auth。

约束：

- 不新增第二份 Codex auth 文件；
- 不改变现有 opencode 上游 `openai` provider 的认证来源。

回写策略：

- 仅在以下两种场景回写 auth：
  1. 从 JWT claims 成功补齐了缺失的 `accountId`；
  2. 401 后 refresh 成功，拿到了新的 `access` / `refresh` / `expires`。
- 回写时只更新 `access`、`refresh`、`expires`、`accountId` 这几个字段，不改动其他 provider 配置。
- `codex-auth-source` 只返回“建议回写的字段”，真正持久化由 command 层统一执行，避免 fetcher 和命令并发各自写 auth。

### 2. `codex-status-fetcher`

职责：

- 使用 `GET https://chatgpt.com/backend-api/codex/usage` 请求远端状态；
- 发送 `Authorization` / `ChatGPT-Account-Id` / `Accept` / `User-Agent`；
- 把返回体归一化为本仓库可消费的状态快照结构。

建议归一化字段：

- 身份字段：`email`、`accountId`、`planType`、`teamSpace`（若有）；
- 状态字段：
  - `primaryWindow`（5h）
  - `secondaryWindow`（weekly）
  - `usedPercent`
  - `remainingPercent`
  - `resetAt`
  - `credits`（若存在）
  - `updatedAt`

如果返回体里不存在某个字段，应直接保留 `undefined`，由渲染层显示 `n/a`。

来源优先级：

- `accountId`：auth 显式字段 > JWT claims > `/usage` 返回体；
- `email`：`/usage` 返回体 > auth/claims；
- `planType` / `teamSpace`：`/usage` 返回体 > auth/claims > store 历史快照；
- `updatedAt`：本次远端成功时间 > store 历史时间。

### 3. `codex-store`

新增一份 Codex 专用 store，例如：

- 路径与文件名独立于 Copilot store；
- 内容只包含 Codex 身份与最近一次状态快照。

建议结构：

```ts
type CodexStatusStore = {
  activeProvider?: "openai"
  activeAccountId?: string
  activeEmail?: string
  lastStatusRefresh?: number
  account?: {
    email?: string
    accountId?: string
    plan?: string
    teamSpace?: string
    updatedAt?: number
  }
  status?: {
    source: "remote" | "cached"
    updatedAt?: number
    credits?: unknown
    windows?: {
      primary?: { remainingPercent?: number; resetAt?: number }
      secondary?: { remainingPercent?: number; resetAt?: number }
    }
    rawSummary?: string
    error?: string
  }
}
```

这里不做多账号池管理，只缓存“当前可用 OAuth 身份 + 最近一次远端状态”。后续若用户要做 Codex 切号，再扩展该 store。

### 4. `codex-status-command`

职责：

- 注册 `/codex-status`；
- 读取认证；
- 调 fetcher 拉远端状态；
- 更新 Codex store；
- 通过 toast 输出结果；
- 最后抛出受控中断，保持和 `/copilot-status` 一致的命令终止方式。

输出形态建议保持两段：

```text
[codex]
email@example.com
plan: team
account: org_123

[usage]
5h: 72% left (resets 14:30)
week: 61% left (resets 09:00 on 24 Mar)
credits: n/a
updated: latest remote snapshot
```

如果远端字段不足：

- 仍然显示 `[codex]` 身份块；
- 缺失的 quota 项显示 `n/a`；
- 不伪造完整数字。

缓存语义：

- 只要本次远端请求成功，`status.source = "remote"`；
- 若本次请求失败但使用了旧快照，`status.source = "cached"`；
- 旧快照没有强制过期阈值，但渲染时必须明确标出 `latest known status`，避免用户误以为是实时结果；
- 若既无远端结果又无缓存，则不写入新的伪快照。

## 错误处理

### 无认证

- 如果没有 `openai` OAuth，直接提示 `Codex/OpenAI OAuth 未登录`；
- 不写入伪状态。

### token 刷新失败

- 提示刷新失败；
- 若 store 中已有旧快照，则附带 `latest known status` 一并展示；
- 若无旧快照，则直接错误 toast。

### 远端接口失败

- 若远端失败但 store 有旧快照：展示旧快照并附错误摘要；
- 若没有旧快照：展示错误并中断。

### 常见瞬时失败

- `429`、超时、`5xx`、网络错误：视为远端失败，走“缓存回退或错误 toast”；
- 非 JSON 或半结构化返回：尽量提取可识别字段，否则按远端失败处理；
- Cloudflare/challenge 页面：按远端失败处理，并把错误摘要写入 `status.error`。

### 返回体字段漂移

- 只影响对应字段渲染；
- 其余已知字段照常展示；
- 同时把本次错误/降级原因写到 store 的 `status.error` 中，便于后续诊断。

## 测试策略

### 1. 命令注册测试

- `experimentalSlashCommandsEnabled` 开启时注册 `/codex-status`；
- 关闭时不注册。

### 2. 认证与 fetcher 测试

- 能从 OAuth 数据读取 `access/refresh/accountId`；
- `accountId` 缺失时能从 token claims 提取；
- 401 后刷新 token 并重试；
- `429`、超时、`5xx`、非 JSON 返回能稳定降级；
- 能把 `/usage` 返回体归一化成 status snapshot。

### 3. command 行为测试

- 成功拉远端状态并写 store；
- 远端失败但回退旧快照；
- 无认证时报错；
- 返回字段不完整时输出 `n/a` 而不是崩溃。
- 显式断言不会读写 Copilot store / routing 字段。

## 预期结果

完成后：

1. 插件会有第一个真正可用的 Codex 用户面命令：`/codex-status`；
2. Codex 状态获取路径将明确依赖上游 OpenAI OAuth 和 `chatgpt.com/backend-api/codex/usage`；
3. Codex 将拥有自己的状态缓存边界，而不会被塞进 Copilot store；
4. 后续若要加 Codex 切号、菜单项或更深 provider status 抽象，都可以建立在这条路径上继续演进。
