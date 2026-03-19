# Copilot 路由观测与轮换修正设计

## 背景

`v0.10.0` 已经把 Copilot 多账号路由、按组选择、rate-limit 后切换等能力发布出去，但真实使用中出现了几类和预期不一致的现象：

- 用户本机的 `~/.local/share/opencode/copilot-routing-state/active.log` 明显混入了测试会话数据，说明测试隔离不完整。
- 同一份真实日志里已经出现了真实账号的 `rate-limit-flagged` 事件，但几乎看不到这些真实账号对应的 `session-touch`，说明真实运行时的状态写入链路并不完整。
- 用户当前存在两组共 4 个账号：
  - 默认活跃组 `activeAccountNames = ["gacea-trasy", "Sylvanysc"]`
  - 模型路由组 `modelAccountAssignments["gpt-5.4"] = ["2321Robin", "DavidMccluretp"]`
  但真实日志里每组都只看到了数组中的第一个账号被使用。
- 现有选择逻辑在 `load` 相同的情况下会稳定落到数组第一个账号；现有 rate-limit 后替换逻辑又要求 `replacementLoad < currentLoad`，这会让 `load` 相同场景下无法切换。
- 现有 `/copilot-status` 仍然只围绕 `store.active` 展示单账号视图，已经不能表达“活跃组 + 路由组”的配置事实。
- 现有用户可见 toast 只有部分切号提示，没有“这次实际请求到底消耗了哪个账号、为什么用它”的统一反馈。

本轮设计不再假设只有一个根因，而是把问题拆成三类分别处理：

1. 停止测试继续污染真实 routing-state。
2. 为真实运行时补足足够轻量但常驻的决策证据。
3. 修正账号选择与 rate-limit 切换规则，让组内账号真正轮换起来。

## 目标

1. 停止测试把 `session-touch` / `rate-limit-flagged` 写进用户真实 routing-state 目录。
2. 新增常驻轻量运行时决策日志，能解释“为什么选了这个账号 / 为什么没切换 / 为什么没有写 session-touch”。
3. 保持 `active.log` 只承载参与路由状态折叠的事件，不把调试信息混进去。
4. 将 `load` 的语义从“近 30 分钟唯一会话数”改成“近 30 分钟 `session-touch` 次数”。
5. 在候选账号 `load` 相同的情况下随机选择一个，避免稳定偏向数组中的第一个账号。
6. 在 rate-limit 恢复阶段，把替换条件从严格 `<` 放宽到 `<=`，让 `load` 相同场景也允许切换。
7. 每次账号发生实际消耗时都显示 toast，并带上当前决策路径能可靠判断的原因。
8. 将 `/copilot-status` 改成明确的配置视图，展示活跃组和路由组，而不是继续伪装成单账号视图。

## 非目标

- 不自动清理用户当前已经被污染的 `active.log`。
- 不在本轮声称已经确认“真实 `session-touch` 缺失”的唯一根因；本轮先补充可证伪证据。
- 不把 `decisions.log` 作为路由算法输入；它只用于观测，不参与决策。
- 不修改 OpenCode core / upstream。
- 不把 `/copilot-status` 扩展成“最近真实使用轨迹”视图。
- 不引入“首次计费 / 首次 billing compensation”这类当前无法可靠证明的用户语义。
- 不在本轮为 `decisions.log` 引入复杂的 rotation / retention 体系。

## 已确认事实

### 1. 测试污染是真实存在的

- `test/plugin.test.js` 中存在大量诸如 `session-123`、`child-routing-loads`、`child-rate-*`、`child-*` 的测试会话 ID。
- 用户真实 `active.log` 中同样出现了这些测试 ID。
- 这说明测试 harness 至少在部分场景下默认落到了真实 `routingStatePath()`。

### 2. 真实运行时已经在写真实 routing-state，但写入不完整

- 用户真实 `active.log` 末尾已经出现真实账号的 `rate-limit-flagged`：例如 `2321Robin`、`gacea-trasy`。
- 同一份日志中却看不到这些真实账号对应的 `session-touch`。
- 因此“测试污染”不是唯一问题；真实运行链路里还存在“限流状态能写入，但会话触点没有稳定写入”的缺口。

### 3. 当前选择和切换规则会天然偏向组内第一个账号

- 当前 `chooseCandidateAccount()` 只按 `load` 升序排序；`load` 相同场景没有随机化，会稳定取排序后的第一个候选。
- 当前 rate-limit 后的替换逻辑要求 `replacementLoad < currentLoad`，因此当两边 `load` 同为 `0` 时，明明有冷却完成的替换账号，也不会发生切换。
- 结合用户当前真实配置与真实日志，可以把“同组第二个账号长期不被选中”视为已证实行为，而不是仅仅猜测。

## 用户已确认的规则

### 1. 日志与观测

- `active.log` 只继续承载状态事件。
- 新增常驻轻量 `decisions.log`，专门记录实际决策与未切换原因。
- 本轮只防止未来继续污染，不自动处理用户当前已有日志。

### 2. `load` 语义

- `load` 不再表示近窗口内唯一 `sessionID` 数量。
- `load` 直接表示近窗口内 `session-touch` 事件数量。

### 3. 平局策略

- 候选账号 `load` 相同时，随机选择一个。
- 不再使用稳定顺序把平局固定打在数组第一个账号上。

### 4. rate-limit 替换规则

- 冷却条件仍然保留。
- 比较条件从严格 `<` 改成 `<=`。
- 也就是说，只要替换账号已经过冷却，且它的 `load` 不高于当前账号，就允许切换。

### 5. 用户可见反馈

- 每次账号被实际消耗时都要 toast。
- toast 需要带上原因。
- 原因只使用当前决策链可以可靠判断的几类：`常规请求`、`子代理请求`、`用户回合重选`、`限流后切换`。

### 6. `/copilot-status`

- `/copilot-status` 应展示活跃组和路由组。
- 该命令应被明确定位为配置视图，而不宣称反映真实运行时轨迹。

## 方案概览

推荐采用“状态日志与决策日志分层 + `touch-count` 负载 + 平局随机 + `<=` 替换门槛 + 配置型状态展示”的修正版方案：

1. `active.log` 继续只写 `session-touch` / `rate-limit-flagged`，供 routing-state 折叠与切换逻辑读取。
2. 新增 `decisions.log`，每次真实请求都记录一条轻量决策事件，专门回答“选了谁 / 为什么 / 为什么没切换 / 有没有拿到 sessionID / touch 写入结果如何”。
3. routing-state 的折叠状态从“每账号最近会话集合”调整为“每账号分钟桶计数”，让 `load` 真正表达近 30 分钟 `session-touch` 次数。
4. 正常选号时按新 `load` 升序，平局用随机打散。
5. rate-limit 替换时保留冷却和 `load` 比较，但把比较门槛放宽到 `<=`。
6. 每次账号真实出网前都显示一次消费 toast；如果该次请求是因为限流切换而改用新账号，则该次 warning toast 同时承担“切换提示 + 实际消耗提示”。
7. `/copilot-status` 继续刷新 `store.active` 的 quota，但展示结果扩展为：当前 active quota + 活跃组 + 路由组。
8. 测试 harness 默认使用临时 routing-state 目录，阻止未来继续污染用户真实目录。

## 架构设计

### 1. routing-state 目录分层

目录仍然使用：

- `~/.local/share/opencode/copilot-routing-state/`

本轮将目录内文件职责明确分成两层：

#### 状态层

- `snapshot.json`
- `active.log`
- `sealed-*.log`

它们继续只承载会被路由逻辑读取、折叠和比较的状态事件。

#### 观测层

- `decisions.log`

它只承载调试与人工排障证据：

- 不参与路由选择
- 不参与 compaction
- 用户手动删除后可自动重建
- 写入失败时应 fail-open，不能影响真实请求

### 2. `decisions.log` 事件模型

推荐每条记录一行 JSON，事件类型统一为 `route-decision`。字段应覆盖当前最关心的观测点：

- `type: "route-decision"`
- `at`
- `modelID?`
- `sessionID?`
- `sessionIDPresent: boolean`
- `groupSource: "active" | "model"`
- `candidateNames: string[]`
- `loads: Record<string, number>`
- `chosenAccount`
- `reason: "regular" | "subagent" | "user-reselect" | "rate-limit-switch"`
- `switched: boolean`
- `switchFrom?`
- `switchBlockedBy?`
- `touchWriteOutcome: "written" | "throttled" | "skipped-missing-session" | "failed"`
- `touchWriteError?`
- `rateLimitMatched?: boolean`
- `retryAfterMs?`

其中：

- `switchBlockedBy` 用来解释“为什么 rate-limit 后没切换”，例如：
  - `no-cooled-down-candidate`
  - `replacement-load-higher`
  - `routing-state-read-failed`
  - `no-replacement-candidate`
- `touchWriteOutcome` 用来解释“为什么真实 `session-touch` 没写进去”。

这样，即使还没有完全确认真实根因，也能通过 `decisions.log` 直接证伪：

- 请求有没有拿到 `sessionID`
- 候选账号组是谁
- 当时的 `load` 是多少
- 是否进入 rate-limit 替换分支
- 为什么没有切换
- 为什么没有落下 `session-touch`

### 3. routing-state 状态模型从 `sessions` 改成 `touchBuckets`

当前 `RoutingSnapshot` 里真正参与负载统计的是：

- `accounts[accountName].sessions[sessionID] = lastUsedAt`

这天然只能表达“近窗口内不同会话数”，无法表达“近窗口内 `session-touch` 次数”。

本轮需要把可折叠状态改成分钟桶计数，例如：

- `accounts[accountName].touchBuckets[bucketStart] = count`

其中：

- `bucketStart = floor(at / 60_000) * 60_000`
- `count` 表示该账号在这一分钟内累计写入了多少次 `session-touch`

设计理由：

- 用户明确要求 `load` 直接表示 `session-touch` 次数。
- 写入端本来就已经按“每账号 + 每会话 1 分钟节流”，所以分钟桶计数与当前写入语义自然对齐。
- 相比保留整条 `sessionID -> at` 映射，分钟桶计数更直接服务于“近 30 分钟触点次数”统计。
- 相比持久化每一条 touch 时间数组，分钟桶计数更紧凑。

新的折叠规则：

- `session-touch`
  - 折叠到 `touchBuckets[bucketStart] += 1`
- `rate-limit-flagged`
  - 继续折叠到 `lastRateLimitedAt = max(at)`

新的 compaction 规则：

- 删除早于 30 分钟窗口的 `touchBuckets`
- 保留 `lastRateLimitedAt`

### 4. 旧快照兼容

用户当前磁盘上的 `snapshot.json` 可能仍然是旧结构：

- `accounts[accountName].sessions[sessionID] = lastUsedAt`

本轮不要求做一次性迁移脚本，而是在读取时做兼容：

1. 如果读到旧 `sessions` 字段，则把每个 `lastUsedAt` 视为“一次历史 touch”，映射到对应分钟桶。
2. 这种兼容只用于让旧数据在未来 30 分钟窗口内仍然可参与近似比较。
3. 一旦下一次 compaction 写出新 `snapshot.json`，只写新结构，不再回写 `sessions`。

这样可以保证：

- 旧数据不会把新逻辑直接读崩。
- 旧数据产生的近似误差会在 30 分钟窗口后自然消失。

### 5. `buildCandidateAccountLoads()` 的新定义

`buildCandidateAccountLoads()` 改为：

- 读取每个候选账号在 30 分钟窗口内的所有 `touchBuckets`
- 求和得到该账号的 `load`

因此，本轮之后的 `load` 语义明确变成：

- “该账号近 30 分钟内累计记录了多少次 `session-touch`”

不再表示：

- “该账号近 30 分钟内被多少个唯一 `sessionID` 使用过”

### 6. 正常选号规则

正常选号阶段继续分两类：

#### 没有会话绑定

- 直接从当前候选组中选择 `load` 最小的账号。
- 如果最小 `load` 有多个并列候选，则在这些并列候选中随机选择一个。

#### 已有会话绑定

- 非用户轮次：继续复用当前绑定账号。
- 用户轮次：继续沿用差值规则，即当“当前绑定账号 `load` - 最小 `load` >= 3”时才触发重选。
- 一旦进入重选，最小 `load` 有多个并列候选时，同样在并列最小集内随机选择一个。

为了让测试稳定，本轮需要给 `buildPluginHooks()` 增加可注入随机源，例如：

- `random?: () => number`

默认实现可以使用 `Math.random()`；测试里则注入固定返回值，避免随机选择导致测试抖动。

### 7. rate-limit 恢复阶段

当前替换逻辑的问题不是只有一个：

- 当两边 `load` 同为 `0` 时，严格 `<` 会直接阻断切换。
- 当存在冷却完成的替换候选，但 `load` 恰好相等时，用户仍然会被卡在已经被标记限流的账号上。

本轮保持原有总体结构，但调整替换条件：

1. 当前账号达到阈值后，仍然先写入 `rate-limit-flagged`
2. 仍然只在当前模型候选组内查找替换账号
3. 替换账号仍需满足：
   - 不是当前账号
   - 已过 rate-limit 冷却，或从未被标记 rate-limit
4. `load` 比较条件从：
   - `replacementLoad < currentLoad`
   改成：
   - `replacementLoad <= currentLoad`
5. 若有多个满足条件且 `load` 最低的替换账号，则在这些并列候选中随机选择一个

这表示：

- `load` 约束仍然保留
- 但不再因为完全相等而阻断恢复性切换

未切换时需要把原因写入 `decisions.log`，而不是只在内存里静默失败。

### 8. `session-touch` 写入链路的证据补足

当前用户最关心但尚未完全证实的问题是：

- 为什么真实 `rate-limit-flagged` 已经写进去了，但真实 `session-touch` 却没有稳定写进去

本轮先不在 spec 里假定唯一根因，而是把这件事变成一个可直接观察的问题。实现需要在做出路由决策时，把以下事实写到 `decisions.log`：

- 本次请求看到的 `sessionID` 是什么
- `sessionIDPresent` 是否为 `true`
- 是否尝试写 `session-touch`
- 写入结果是 `written`、`throttled`、`skipped-missing-session` 还是 `failed`

这样，后续真实运行一轮之后，用户就能直接从两份日志交叉确认：

- `decisions.log` 里请求是否真的缺失 `sessionID`
- 如果 `sessionID` 存在但 `active.log` 没写进去，问题到底是节流、异常、还是别的路径漏掉了写入

### 9. 用户可见 toast 规则

本轮 toast 的产品语义不再围绕“首次计费”展开，而是围绕“这次实际请求用了哪个账号”展开。

规则如下：

#### 普通消耗

- 每次真实出网前，显示一条消费 toast。
- 文案模式：
  - `已使用 <账号名>（常规请求）`
  - `已使用 <账号名>（子代理请求）`
  - `已使用 <账号名>（用户回合重选）`

#### 限流后切换

- 如果该次请求因为 rate-limit 切到了新账号，不再额外发一条普通消费 toast。
- 直接发一条 warning toast，同时承担“切换提示 + 本次实际消耗提示”：
  - `已切换到 <新账号>（<旧账号> 限流后切换）`

这样可以满足用户“每次实际消耗都 toast”的要求，同时避免切换场景一条请求弹两次。

### 10. `/copilot-status` 设计

`/copilot-status` 继续保留“刷新当前 active account quota”这一主动作，但展示内容改成明确的配置视图。

成功结果至少包含三部分：

1. 当前 `store.active` 的 quota 摘要
2. 活跃组 `activeAccountNames`
3. 路由组 `modelAccountAssignments`

推荐展示顺序：

1. `当前 active: <name> | premium ... | updated at ...`
2. `活跃组: gacea-trasy, Sylvanysc`
3. `路由组: gpt-5.4 -> 2321Robin, DavidMccluretp`

约束：

- 不读取 `routing-state`
- 不宣称这是“最近真实使用情况”
- 仍然允许在没有显式路由组时显示 `路由组: none`

### 11. 测试隔离

`test/plugin.test.js` 中的 `createSessionBindingHarness()` 需要默认注入临时 routing-state 目录，而不是继续回落到真实 `routingStatePath()`。

同时：

- `decisions.log` 也应落在该临时目录下
- 默认测试不应该再写用户真实 `~/.local/share/opencode/copilot-routing-state`
- 只有显式需要验证真实默认路径的测试，才可以专门传入覆盖值

## 备选方案与拒绝理由

### 方案 A：只修测试污染，不补运行时证据

不推荐原因：

- 这只能解释“为什么日志脏了”，解释不了“为什么真实 `session-touch` 缺失”。
- 用户当前更关心的是运行时为什么没轮换，而不是只关心测试污染。

### 方案 B：完全去掉 rate-limit 阶段的 `load` 比较

不推荐原因：

- 用户已经明确要求保留 `load` 比较，只把 `<` 改成 `<=`。
- 完全移除比较门槛会让 rate-limit 恢复阶段失去负载约束。

### 方案 C：继续把 `load` 定义为唯一 `sessionID` 数

不推荐原因：

- 用户已明确要求改成 `session-touch` 次数。
- “唯一会话数”会把长会话、高频请求、重试与短会话压成同一个量级，无法表达真实消耗频率。

## 风险与缓解

### 1. 每次消耗都 toast 可能偏吵

这是用户明确选择的产品语义，本轮按该要求实现。

缓解：

- 切换场景只发一条 warning toast，不额外叠加普通消费 toast。

### 2. 随机 tie-break 会降低现场复现的“稳定性”

缓解：

- 每次决策写 `decisions.log`
- 测试里通过注入 `random()` 保证可重复

### 3. `decisions.log` 会持续增长

本轮接受该成本，因为这是常驻轻量日志，且不参与路由状态折叠。

缓解：

- 文件结构为 JSONL，用户可以安全手动删除
- 后续如果确认体积成为问题，再单独设计 retention / rotation

### 4. 旧 `sessions` 快照到 `touchBuckets` 的兼容只是一种近似映射

缓解：

- 旧数据只影响未来 30 分钟窗口
- 30 分钟后会自然失效
- 新快照写出后就只保留新结构

## 验证策略

### 自动化测试

至少补齐以下覆盖：

1. `buildCandidateAccountLoads()` 按 `touchBuckets` 求和，而不是按唯一 `sessionID` 计数。
2. 平局场景下会使用注入随机源从最小 `load` 候选中选一个。
3. rate-limit 替换条件从 `<` 改成 `<=` 后，`load` 相同场景会发生切换。
4. `decisions.log` 会记录：
   - `sessionIDPresent`
   - `touchWriteOutcome`
   - `switchBlockedBy`
5. `/copilot-status` 会展示活跃组和路由组。
6. `createSessionBindingHarness()` 默认使用临时 routing-state 目录。

### 手工验证

通过真实运行环境对照以下两份文件：

- `~/.local/share/opencode/copilot-routing-state/active.log`
- `~/.local/share/opencode/copilot-routing-state/decisions.log`

重点观察：

1. 当真实请求发出时，`decisions.log` 是否记录了 `sessionIDPresent` 和 `touchWriteOutcome`
2. 当 `touchWriteOutcome = written` 时，`active.log` 是否出现对应的 `session-touch`
3. 同组账号 `load` 相同场景下，是否不再长期只用数组第一个账号
4. 两边 `load` 相同且替换账号已过冷却时，rate-limit 后是否能切走

## 实施边界

本轮修改只发生在插件仓库内：

- `src/routing-state.ts`
- `src/plugin-hooks.ts`
- `src/status-command.ts`
- `test/plugin.test.js`
- `test/routing-state.test.js`
- `test/status-command.test.js`

不修改 OpenCode core，不修改 upstream Copilot 插件快照。
