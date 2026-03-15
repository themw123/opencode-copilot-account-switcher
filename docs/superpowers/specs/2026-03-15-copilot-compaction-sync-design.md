# Copilot Compaction Sync Design

## 背景

`v0.3.4` 的运行日志显示，Copilot `/responses` 请求在压缩场景下仍然会产生两次计费。进一步静态分析确认，这不是 `networkRetryEnabled` 包装再次破坏了请求头，而是当前 vendored snapshot 的 `chat.headers` 语义与我们声称同步的 upstream 提交并不一致。

我们本地 `src/upstream/copilot-plugin.snapshot.ts` 的头部元数据写着上游 commit `88226f30610d6038a431796a8ae5917199d49c74`，但实际导出的 `createOfficialCopilotChatHeaders()` 只有：

- Anthropic `anthropic-beta` 头补充
- 子会话 `session.data.parentID` => `x-initiator=agent`

它缺少 upstream `88226f` 引入的 compaction 分支：读取 `incoming.message.sessionID + incoming.message.id` 对应 message 的 parts，只要发现 `part.type === "compaction"` 就把该请求标记为 `agent initiated`。这说明当前 snapshot 生成链路并不可靠：它在“看起来像同步了指定上游提交”的同时，实际上丢掉了 upstream 原文件中的一部分行为。

用户还提出两个额外要求：

1. 全量测试应自动拉取并比对 upstream 最新 `copilot.ts`，及时发现 snapshot 漂移。
2. 调试日志应记录更多原始证据，尤其是能帮助后续分析“压缩后自动继续任务”的那次请求的候选信号，但当前版本先不要在插件内提前固化判定规则。

## 目标

本次设计要解决三个问题：

1. 让 official Copilot 行为真正直接来自 upstream 原文件，而不是来自我们重组后的语义副本。
2. 把 snapshot 漂移检测收紧为“重新生成结果与仓库内 snapshot 逐字节一致”。
3. 在 debug 模式下补充足够的原始证据，便于下一次仅凭日志分析 compaction、subagent、普通请求，以及未来可能的“压缩后自动继续任务”请求。

## 非目标

- 本次不直接修复 upstream 尚未修复的“压缩后自动继续任务也应免计费”行为。
- 本次不把日志中的候选信号组合成新的正式行为判断。
- 本次不重构 retry、store、menu、loop safety 等无关模块。

## 方案概述

### 1. 让 snapshot 成为纯机械产物

`src/upstream/copilot-plugin.snapshot.ts` 必须继续是脚本生成文件，但其语义必须直接保留 upstream 原文件，不允许再通过“抽取 loader/chat.headers body 后重组一份新的工厂函数”来复制行为。

设计要求：

- `scripts/sync-copilot-upstream.mjs` 只允许做机械级变换：
  - 去掉 upstream import 块
  - 注入本地 shim（类型、`Installation.VERSION`、`Bun.sleep` 兼容等）
  - 在必要位置做最小的 export 级别暴露
- 脚本不再抽取 `auth.loader` / `chat.headers` body，也不再生成 `createOfficialCopilotLoader()` / `createOfficialCopilotChatHeaders()` 这类语义副本。
- `src/upstream/copilot-loader-adapter.ts` 改为直接消费 snapshot 中导出的 `CopilotAuthPlugin`，再从 runtime 返回的 hooks 上读取 `auth.loader` 与 `chat.headers`；adapter 只做极薄包装，不复制任何 official 分支条件。

为了让“纯机械产物”不仅是约定，还能被测试约束，本次设计要求增加两层保护：

1. **体内结构约束**：生成后的 snapshot 中必须保留一段与 upstream 原文件逐字节一致的核心主体（除 import 移除、shim 插入和最小 export 暴露外）。
2. **行为接线约束**：本地 adapter 不再消费任何“重新组装后的 helper factory”，而是直接调用 official plugin 本体。

这样 compaction 分支、subagent 分支、未来 upstream 新增的头逻辑，都会随着原文件同步自然进入，而不是依赖我们继续复制每一个条件分支。

### 2. 同步源收敛到 canonical upstream，并写入真实上游版本

当前 sync script 的默认源存在两个问题：

- 默认 URL 仍指向 `sst/opencode`
- 优先尝试本地兄弟仓库路径，容易误吃旧副本

设计要求：

- 默认远端源改为 `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/plugin/copilot.ts`
- 不再优先使用本地兄弟仓库文件作为“默认源”
- 本地文件源只在显式 `--source <path>` 时使用
- 当使用默认 upstream `dev` 源时，脚本应先通过 GitHub API 或等价的 git ref 查询解析当前 `dev` 的真实 commit SHA，再使用该 SHA 对应的原始文件生成 snapshot，并把这个真实 SHA 写入 snapshot 头部 metadata
- 当使用显式 `--source` 时，若输出目标是仓库内 snapshot，则仍要求显式提供 `--upstream-commit`

这样“默认同步”始终以 canonical upstream 为准，避免本地环境里多个 opencode clone 的状态污染结果；同时也避免继续出现“头部 metadata 写着某个 commit，但内容其实不是那个 commit 的直接产物”的问题。

### 3. 漂移检测改为逐字节一致，并补上机械变换约束校验

`check:copilot-sync` 与全量测试都需要使用相同的判定标准：

- 拉取 upstream `dev` 的 `packages/opencode/src/plugin/copilot.ts`
- 用当前 sync script 重新生成一个临时 snapshot
- 将生成结果与仓库内 `src/upstream/copilot-plugin.snapshot.ts` 做逐字节比较
- 不一致即失败

除此之外，还要增加一条“机械变换约束”测试，并把允许差异的区块形式化：

- 从 fetched upstream 原文件中移除 import 块
- 从生成后的 snapshot 中仅允许剥离以下固定锚点区块：
  - 文件头 metadata 注释块（从文件起始到 `/* LOCAL_SHIMS_START */` 前）
  - `/* LOCAL_SHIMS_START */ ... /* LOCAL_SHIMS_END */`
  - 若需要额外导出暴露，则只能通过预定义的固定模板区块插入，并且该区块必须有稳定 marker，例如 `/* GENERATED_EXPORT_BRIDGE_START */ ... /* GENERATED_EXPORT_BRIDGE_END */`
- 除上述白名单区块外，snapshot 剩余主体必须与 upstream 原文件（去 import 后）逐字节一致

也就是说，这条测试不是“移除某些允许包装后大致一致”，而是“只有白名单 marker 包围的固定模板允许不同，其余任何字符差异都视为失败”。这样可以防止未来把新的语义改动偷偷藏进所谓“允许包装区块”里。

为了提高诊断效率，需要区分两类失败：

- 网络或拉取失败：说明本次无法完成漂移检测
- 生成结果漂移：说明当前仓库内 snapshot 已落后或脚本逻辑与仓库内文件不一致

门禁语义明确如下：

- 该检查进入常规全量测试路径，默认 **hard fail**
- 网络拉取失败也视为测试失败，但错误信息必须明确标为“upstream fetch failed”，不能与“snapshot drift detected”混淆
- 本次设计不提供静默跳过；如果后续确有离线开发痛点，再单独设计显式 opt-out

### 4. debug 日志改为记录原始证据，而非判定结论

用户不希望当前就把“压缩后自动继续任务”固化成插件内行为判定，因此日志层面应记录足够丰富的原始证据，支持后验分析。

日志增强分两层，并明确区分 `evidence` 与 `candidates`：

- `evidence`：原始事实，不含组合判断
- `candidates`：简单候选信号，只用于后验分析，不直接驱动行为

#### 4.1 chat.headers 侧证据

在 debug 模式下，记录：

- `evidence.session_id`
- `evidence.message_id`
- `evidence.message_session_id`
- `evidence.model_provider_id`
- `evidence.model_api_npm`
- `evidence.current_message_part_types`
- `evidence.current_message_text_parts`：
  - `synthetic` 原值
  - 文本前缀预览（固定 80 个字符，归一化空白，不记录全文）
- `evidence.session_parent_id_present`
- `evidence.direct_parent_assistant`：`id`、`summary`、`finish`
- `evidence.recent_messages`：固定记录“当前 message + 前 3 条 message”的 `(id, role, parentID, summary, finish, parts.type[])`
- `evidence.headers_before_official`
- `evidence.headers_after_official`

同时允许记录以下 `candidates`，但必须与 `evidence` 分开存放：

- `candidates.synthetic_text_count`
- `candidates.matches_continue_template`
- `candidates.parent_assistant_is_summary`
- `candidates.latest_assistant_is_summary`

出于日志降噪与避免额外暴露 session 关系细节的考虑，本次只记录 `session_parent_id_present`，不记录 `parentID` 原值；如果后续真实排障证明“仅 presence 不足以定位问题”，再单独扩展。

这些信息只作为日志证据，不参与本次行为控制。

#### 4.2 retry wrapper / 实际发网侧证据

在 debug 模式下，记录：

- 包装入口收到的请求头形态（plain object / `Headers` / tuple）
- 包装前 headers 摘要
- 包装后 headers 摘要
- 被移除的内部 headers（如 `x-opencode-session-id`）
- 是首发请求还是 retry 请求
- 真正传给 official fetch 前的 headers 摘要

为了把 `chat.headers` 侧证据与 retry wrapper 侧证据串起来，而不污染真实网络请求，本次设计采用 debug-only 的内部关联键：

- `chat.headers` 在 debug 模式下生成一个临时 `debug_link_id`
- 这份 key 只用于进程内 `Map` 关联日志证据
- 同时通过 debug-only 内部 header 传给 retry wrapper
- retry wrapper 读取后立即在正式发网前移除该 header
- 关联缓存以 `debug_link_id` 为键，在请求完成或抛错后于 `finally` 中清理

这样可以解决并发下 `sessionID + messageID` 串线的问题，同时保证真实网络请求不会携带任何新增调试头。

## 为什么不用“现在就下结论”

当前已知的 compaction 请求可以通过 upstream `88226f` 的规则识别；但用户明确提到，未来可能还要分析“压缩后自动继续任务”的那次请求，这个请求在 upstream 里尚未修复，也未形成官方规则。此时如果我们现在就在插件里固化一套新的行为判断，很容易把猜测变成实现。

因此本次设计选择：

- 行为层只修复已经存在的 official upstream 逻辑
- 日志层为未来分析记录候选信号
- 等拿到新版本的真实日志证据后，再判断哪些信号组合才足够可靠

## 风险与约束

### 风险 1：直接消费完整 official 插件实现时，本地 shim 需要更稳

如果 snapshot 不再拆出独立工厂副本，而是直接复用 official plugin/hook，本地 shim 层必须足够完整，保证生成后的 snapshot 在当前仓库可编译、可测试。

缓解方式：

- 保留并收紧 shim 的职责边界
- 用“核心主体逐字节一致”测试 + adapter 行为测试覆盖新结构

### 风险 2：网络测试在 CI/本地环境中不稳定

拉取 upstream `dev` 会受网络影响。

缓解方式：

- 测试输出要明确区分“网络失败”与“snapshot 漂移”
- 保持错误信息足够清晰，便于一眼判断是环境问题还是代码问题
- 默认 hard fail，避免 silent skip 掩盖漂移

### 风险 3：日志量增加

记录最近消息摘要和 headers 证据会让 debug 日志更长。

缓解方式：

- 严格限制在 `OPENCODE_COPILOT_RETRY_DEBUG=1` 时启用
- 文本内容只记录前缀预览，不整段打印
- 前缀预览固定 80 字符并归一化空白

## 测试策略

本次变更至少需要新增或调整以下测试：

1. snapshot 生成测试：验证新的 sync script 仍能从 upstream 原文件生成可用 snapshot，且不再生成语义副本 helper factory。
2. 核心主体一致性测试：验证 snapshot 去掉 shim/允许包装后，其核心主体与 upstream 原文件逐字节一致。
3. 漂移检测测试：拉取 upstream `dev` 原文件，重新生成 snapshot，并与仓库内 snapshot 逐字节一致；网络失败与漂移失败信息要可区分。
4. adapter / plugin 行为测试：验证 compaction message 场景会得到 official `x-initiator=agent`。
5. debug 日志测试：验证新增日志包含 `evidence` / `candidates` 区块、包装前后 headers 证据，以及内部调试关联键会在发网前被移除。

所有行为修复都要走 TDD：先加失败测试，再改实现。

## 预期结果

完成后应达到以下状态：

- 官方 compaction `x-initiator=agent` 行为真正随 upstream 原文件进入插件
- 仓库无法再在“snapshot 头部元数据声称同步某个 commit、实际内容却丢行为”的状态下通过测试
- 下个 debug 版本发布后，日志会携带足够的原始证据，支持后续分析“压缩后自动继续任务”请求的可靠信号组合
