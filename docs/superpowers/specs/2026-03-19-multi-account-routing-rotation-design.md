# 多账号轮询与路由设计

## 背景

当前插件只支持两种账号选择方式：

- `store.active` 表示单一默认账号。
- `modelAccountAssignments` 表示“单模型 -> 单账号”的静态映射。

这套模型已经不足以支撑用户的实际使用方式：

- 默认场景下，用户希望把一组学生优惠账号作为 `active/default` 账号组，覆盖普通模型。
- 某些高级模型则希望单独路由到另一组组织账号。
- 一个 OpenCode 会话在开始使用某个模型时，需要先从候选账号组里选出一个最合适的账号；后续同会话应尽量复用该账号，避免频繁抖动。
- 当某个账号在短时间内连续触发 rate-limit 时，插件需要尽量在候选账号组内切走，降低失败率和滥用判定风险。

因此，本次需要把“单账号映射”升级成“账号组 + 会话级选择 + rate-limit 后切换”的插件内路由机制。

## 目标

1. 允许默认账号配置为多个账号。
2. 允许单模型路由配置为多个账号。
3. 支持按会话在候选账号组中做一次选择，并在会话内复用。
4. 支持按近 30 分钟会话占用情况做相对公平的账号选择。
5. 支持在插件内识别真实 Copilot rate-limit，并在满足条件时切换账号。
6. 只修改插件，不修改 OpenCode core/upstream。
7. 在多 OpenCode 实例同时运行时，尽量避免持久化状态互相覆盖。

## 非目标

1. 不把当前会话绑定到哪个账号持久化到硬盘。
2. 不做跨重启的“会话继续复用原账号”语义。
3. 不改变已有账号认证、模型同步、quota 刷新等基础能力。
4. 不引入数据库；持久化仍使用插件自己的文件结构。
5. 不保证所有 rate-limit 后都一定能切换成功；没有更优候选账号时允许保持现状。

## 用户已确认规则

### 1. 账号组语义

- `active/default` 不是“所有账号”，而是用户手工选出的默认账号组。
- 某些高级模型会单独路由到另一组账号。
- 若某模型存在显式路由组，则优先使用该组；否则回落到 `active/default` 账号组。

### 2. 会话键语义

- 会话键直接使用 OpenCode 的 `sessionID`。
- 主代理和子代理天然是不同会话键。
- 不需要额外把主子代理归并成同一个逻辑会话。

### 3. 选择与复用语义

- 若某个 `sessionID` 在当前插件进程内还没有绑定账号，则它的第一次真实 Copilot 请求就是选号触发点。
- 这保证主代理和子代理都不会漏掉首次选号。
- 一旦某个会话在当前进程里已经绑定账号，后续请求默认复用该账号。
- 只有当主会话进入下一轮新的用户消息发送时，才允许重新进入负载比较逻辑。
- 新用户轮次识别继续沿用现有“按请求头标准判断”的方式。

### 4. 负载比较规则

- 候选账号中，统计每个账号近 30 分钟内被多少个不同 `sessionID` 使用。
- 若当前会话已有绑定账号，并且该账号仍可用：
  - 当“当前绑定账号的会话数 - 最小会话数 < 3”时，继续复用当前账号。
  - 否则切到会话数最少的账号。
- 若当前会话还没有绑定账号，则直接选会话数最少的账号。
- 并列时使用稳定顺序打破平局，避免抖动。

### 5. 持久化边界

- 需要持久化到硬盘的信息只有：
  - 每个账号近 30 分钟内被哪些会话使用过，以及这些会话的最近使用时间。
  - 每个账号最近一次被正式标记为 rate-limited 的时间。
- 每次发起请求更新一次使用痕迹，但要做 1 分钟写入节流。
- 5 分钟滑动窗口内累计 3 次 rate-limit 的计数只在当前 OpenCode 实例内存里做，不持久化。

### 6. rate-limit 口径

- rate-limit 证据以真实网络结果为准。
- 当前已确认的有效证据包括：
  - HTTP `429`
  - JSON `{"type":"error","error":{"type":"too_many_requests"}}`
  - `error.code` 含 `rate_limit`
- 若响应提供 `retry-after` 或 `retry-after-ms`，应优先读取并保留该信息。

### 7. rate-limit 后切换规则

- 某账号在当前实例内最近 5 分钟滑动窗口内累计 3 次 rate-limit 时，才将它正式记为 rate-limited。
- 一旦正式命中：
  - 将 `lastRateLimitedAt` 持久化。
  - 在当前模型候选账号组内查找更优替代账号。
  - 替代账号必须满足：
    - `lastRateLimitedAt` 不存在，或距离现在已超过 10 分钟。
    - 近 30 分钟会话数小于当前账号。
- 若找到替代账号，则切换会话绑定，并发出 toast。
- 切换账号时，需要额外触发一次计费/用量相关请求走通的补偿动作。

### 8. 长 ID 清理语义

- 当发生账号切换时，优先尝试一次性清理当前请求与可回写会话中的全部超长 ID。
- 若这条快速路径无法执行，再退回现有逐步修复逻辑。

## 推荐方案

采用“配置层账号组 + 进程内会话绑定 + 独立 routing-state 目录”的方案。

核心思路：

- `copilot-accounts.json` 只负责长期配置。
- 当前会话绑定和 5 分钟滑动窗口内累计 3 次 rate-limit 计数放在内存里。
- 跨实例需要共享的短窗口状态放进独立的 routing-state 目录。
- routing-state 使用 `snapshot + active.log + sealed-*.log` 的分段日志模型，而不是每次整文件覆盖。

这样可以同时满足：

- 菜单配置仍然简单明确。
- 多实例下普通写入主要是 append，不容易互相覆盖。
- 30 分钟窗口统计和 rate-limit 冷却判断都能共享。
- 会话绑定仍保持“当前实例内复用，重启后可重选”的产品语义。

## 架构设计

### 1. 配置层结构调整

当前 `StoreFile` 需要从“单账号默认路由”升级为“默认账号组 + 单一当前生效账号”：

- 保留 `active?: string`
- 新增 `activeAccountNames?: string[]`
- `modelAccountAssignments?: Record<string, string>` 迁移为 `modelAccountAssignments?: Record<string, string[]>`

语义约束：

- `active` 继续表示当前生效账号，用于兼容现有鉴权、quota、status、菜单切换等基础能力。
- `activeAccountNames` 表示默认候选账号组。
- `modelAccountAssignments[modelID]` 表示该模型显式绑定的候选账号组。
- 若某模型存在显式组，则完全以该组为准；否则回落到 `activeAccountNames`。
- 所有数组都需要在 parse 阶段完成：去重、去空、过滤不存在账号、稳定排序。

兼容迁移：

- 若旧 store 中只有 `active` 且没有 `activeAccountNames`，则迁移成单元素 `activeAccountNames`，同时保留 `active` 原值。
- 若旧 `modelAccountAssignments[modelID]` 仍是字符串，则迁移成单元素数组。
- 迁移后的新写入对默认组使用 `activeAccountNames`，但不移除 `active`。
- 路由逻辑依赖账号组；现有“当前生效账号”语义继续由 `active` 承担。

### 2. 会话内绑定状态

在 `buildPluginHooks()` 闭包中新增进程内状态：

- `sessionBindings: Map<string, { accountName: string; modelID?: string; lastUserTurnAt?: number }>`
- `rateLimitQueues: Map<string, number[]>`
- `lastTouchWrites: Map<string, number>`，key 形如 `${accountName}:${sessionID}`，用于 1 分钟节流

语义：

- `sessionBindings` 只存在当前 OpenCode 进程内。
- 同一个 `sessionID` 一旦选中过账号，后续请求默认复用。
- 仅当进入新的用户轮次时，主会话才允许重新比较并重选。
- 子代理如果第一次真实请求才开始出现，也会自然触发首次选号。

### 3. routing-state 目录结构

新增独立目录，例如：

- `~/.local/share/opencode/copilot-routing-state/`

目录内包含：

- `snapshot.json`
- `active.log`
- `sealed-<timestamp>-<pid>.log`
- `rotate.lock`

职责：

- `snapshot.json` 保存已经折叠完成的稳定状态。
- `active.log` 接收当前追加事件。
- `sealed-*.log` 保存已经轮转、尚未被压进快照的历史段。
- `rotate.lock` 只用于短暂轮转，不参与普通读取。

一致性补充：

- `snapshot.json` 需要包含 `appliedSegments` 元数据，用来记录已经折叠进快照的 `sealed-*.log` 文件名。
- 只有未出现在 `appliedSegments` 中的 sealed 段，才会在读取时继续参与折叠。
- 这样即使 compaction 在“写完新快照、但还没删除旧 sealed 段”时崩溃，后续读取也不会重复折叠同一批事件。
- 当 sealed 段已经被成功删除后，后续 compaction 需要同步裁剪 `appliedSegments`，避免该元数据无限增长。
- 如果实现上更适合用 watermark 或 generation 编号替代长列表，也可以采用等价机制，但必须保留“不重复折叠”的一致性语义。

### 4. routing-state 的可见状态模型

持久化对外暴露的逻辑状态只有两类：

1. 近 30 分钟账号使用痕迹
   - 结构可折叠为 `accounts[accountName].sessions[sessionID] = lastUsedAt`
   - 仅保留 30 分钟窗口内仍有效的数据
2. 账号最近一次正式 rate-limited 的时间
   - 结构可折叠为 `accounts[accountName].lastRateLimitedAt`

读取 routing-state 时，逻辑上始终合并：

- `snapshot.json`
- 当前 `active.log`
- 所有未被 `snapshot.appliedSegments` 标记为已折叠的 `sealed-*.log`

因此压缩期间不会读少，只可能多读一段尚未折叠的 sealed 日志。

### 5. 事件模型

推荐使用 JSONL 事件，每行一个对象。

至少需要两类事件：

- `session-touch`
  - 字段：`type`, `accountName`, `sessionID`, `at`
  - 用于更新某账号被某会话最近使用的时间
- `rate-limit-flagged`
  - 字段：`type`, `accountName`, `at`, `retryAfterMs?`
  - 用于记录该账号被正式标记为 rate-limited 的时间

不持久化：

- 单次 rate-limit hit
- 当前会话绑定结果
- 5 分钟滑动窗口累计计数队列

折叠幂等规则：

- `session-touch` 在折叠时按 `(accountName, sessionID)` 聚合，并取 `lastUsedAt = max(at)`。
- `rate-limit-flagged` 在折叠时按 `accountName` 聚合，并取 `lastRateLimitedAt = max(at)`。
- 因此即使 append 重试或多实例竞争导致同一事件重复写入，也不会把会话数重复累计或把冷却时间倒退。

### 6. 选择流程

每次真实 Copilot 请求进入账号选择层时，按以下顺序处理：

1. 解析当前请求的 `modelID`
2. 根据 `modelID` 决定候选账号组：
   - 显式模型组优先
   - 否则回落到 `activeAccountNames`
3. 过滤出真正可参与当前模型选择、且账号条目仍然存在的账号
4. 若过滤后为空：
   - 输出清晰提示
   - 按 fail-open 策略决定是回退到当前现有行为，还是返回明确错误
5. 读取 routing-state，统计每个候选账号近 30 分钟内的不同会话数
6. 检查当前 `sessionID` 是否已有绑定账号：
   - 若没有，则把这次首次真实请求视为选号触发点，直接选会话数最少账号
   - 若有，则默认复用；只有检测到新的主会话用户轮次时，才允许重新比较
7. 对“允许重选”的情况执行差值规则：
   - 若当前账号会话数与最小值差距 `< 3`，继续复用
   - 否则切到最小值账号
8. 若发生账号切换，发送 toast
9. 若本次需要落盘使用痕迹，追加 `session-touch`

候选过滤细则：

- 若账号 `models.available` 明确包含当前模型，则可选。
- 若账号 `models.disabled` 明确包含当前模型，则不可选。
- 若账号尚未完成模型同步，或模型信息缺失 / 过期，则按“未知可用”处理，不因为信息缺失直接排除。
- 这样可以避免模型元数据暂时缺失时把已配置账号组误判成空集。

平局策略：

- 使用稳定排序，例如账号名升序。
- 这样不同实例在同一份 routing-state 上更容易得出一致选择。

### 7. 用户轮次识别

用户已确认两层触发条件：

1. 未绑定会话的第一次真实请求一定会触发选号。
2. 已绑定会话只有在新的用户消息发送时才允许重选。

因此实现上需要同时支持：

- `isFirstBoundRequest(sessionID)`
- `isNewUserTurn(requestHeaders)`

其中第二项继续沿用当前插件已有的请求头标准识别。

### 8. 1 分钟写入节流

`session-touch` 的持久化需要节流：

- 相同 `accountName + sessionID` 在 1 分钟内最多追加一条事件。
- 这样既能满足“每次发起请求更新一次”的近似语义，又能显著减少刷盘量。
- 真实内存视图可以每次请求都更新；只是在写盘时做节流。

### 9. rate-limit 捕获与正式标记

rate-limit 识别放在 Copilot 真实网络层，优先复用已有 `copilot-network-retry` 包装点附近的错误归一化能力。

判定证据包括：

- HTTP `429`
- JSON `error.type === "too_many_requests"`
- JSON `error.code` 包含 `rate_limit`

可附加读取：

- `retry-after`
- `retry-after-ms`

正式标记规则：

1. 每个账号在当前进程内维护一个 5 分钟窗口时间队列。
2. 每次命中 rate-limit，就把当前时间压入队列并清理过期项。
3. 当窗口内累计到 3 次时：
   - 认定该账号正式 rate-limited
   - 追加 `rate-limit-flagged`
   - 更新内存态冷却信息

这里采用的是“5 分钟滑动窗口累计 3 次”语义，而不是“成功一次就清零”的严格连续语义。

### 10. rate-limit 后切换

当某账号被正式 rate-limited，且当前请求仍有可用候选账号组时：

1. 读取当前账号近 30 分钟会话数
2. 在同组中寻找替代账号，要求同时满足：
   - 不是当前账号
   - `lastRateLimitedAt` 不存在，或距现在超过 10 分钟
   - 近 30 分钟会话数小于当前账号
3. 若找到：
   - 更新 `sessionBindings`
   - 发送账号切换 toast
   - 触发一次计费/用量相关请求走通的补偿动作
   - 再用新账号继续本次请求
4. 若找不到：
   - 保持当前账号
   - 不吞掉原始失败，让上层照常处理

这里的“更少会话数”是明确门槛，不做“相等也切换”。

### 11. 长 ID 清理与账号切换的联动

现有网络重试层已经具备逐步修复超长 ID 的逻辑，但账号切换属于更激进的重发节点。

推荐新增一条快速路径：

1. 当某次请求因为 rate-limit 触发账号切换时，优先尝试扫描当前请求负载中的全部超长 ID。
2. 若能定位到会话中的可回写部分，则一并做批量清理和回写。
3. 用清理后的请求负载和新账号重新发起请求。
4. 若快速路径缺乏足够上下文或回写失败，再回退到现有逐步修复逻辑。

这样做的原因：

- 避免切换账号后仍因旧会话中的无效长 ID 反复失败。
- 利用“已经进入补偿重发”这个时机，一次性把明显坏数据清掉。

### 12. 日志轮转与 compaction

为了避免 `active.log` 无限增长，需要后台压缩，但不能让普通追加长时间阻塞。

推荐流程：

1. 普通追加只写 `active.log`。
2. 当 `active.log` 达到阈值时，触发轮转：
   - 短暂拿 `rotate.lock`
   - 把 `active.log` rename 成 `sealed-*.log`
   - 立刻创建新的 `active.log`
   - 释放锁
3. 后台慢慢读取：
   - `snapshot.json`
   - 一个或多个 `sealed-*.log`
4. 折叠出最新状态后，按原子流程重写 `snapshot.json`：
   - 先写 `snapshot.tmp`
   - flush / fsync
   - rename 覆盖 `snapshot.json`
5. 在新 `snapshot.json` 中写入最新的 `appliedSegments`。
6. 删除已经成功折叠的 sealed 段。

清理原则：

- `session-touch` 只保留 30 分钟窗口内仍有效的 `sessionID -> lastUsedAt`
- `lastRateLimitedAt` 长期保留最新值
- 30 分钟前无效的会话触点在 compaction 后会真正丢弃

损坏恢复：

- 若 `snapshot.json` 缺失或损坏，读取时退化为“空快照 + 重放 active/sealed 日志”。
- 若存在 `snapshot.tmp` 残留，不参与读取，由后续 compaction 清理。

### 13. 多进程并发协议

为了降低多实例之间互相覆盖或丢事件的概率，定义如下协议：

1. 普通事件写入必须使用 append 语义，不做整文件读改写。
2. 每个事件必须单行写入，单次写入保持小而完整，避免人为拆成多段。
3. 若 writer 恰好在轮转瞬间仍持有旧 `active.log` 句柄，写入旧文件是可接受的；因为该文件已经变成 sealed 段，读取时仍会被纳入。
4. 若 append 因文件不存在、rename 冲突或 Windows 句柄竞争失败，writer 应重新打开当前 `active.log` 并进行有限次重试。
5. `rotate.lock` 只保护“rename active -> sealed + 创建新 active”这个极短步骤，不覆盖完整 compaction。
6. 若 Windows 上 rename 因句柄占用失败，允许跳过本次轮转并稍后重试，不阻塞正常请求路径。

### 14. fail-open 与错误提示

以下场景需要明确策略：

1. 候选账号组为空
2. 候选组过滤后没有支持当前模型的账号
3. routing-state 目录损坏或读取失败
4. 轮转或 compaction 失败

推荐原则：

- 账号路由本身优先 fail-open，尽量保住原始请求链路
- 但对“用户明确配置了模型专属组且组内无可用账号”这种明显配置错误，应给出清晰提示
- routing-state 读失败时可临时退化为只看当前进程内信息，不阻断请求

## 备选方案

### 方案 2：所有运行态都写回 `copilot-accounts.json`

优点：

- 文件更少

缺点：

- 配置和运行态写入互相干扰
- 多实例最容易互相覆盖
- 难以做短窗口日志清理

因此不推荐。

### 方案 3：只做内存轮询，不做跨实例共享

优点：

- 实现简单

缺点：

- 多实例下公平性和冷却信息会失真
- 不符合用户对硬盘持久化统计的要求

因此不推荐。

## 涉及文件

- `src/store.ts`
  - 配置结构迁移为账号组
- `src/model-account-map.ts`
  - 从“单账号解析”升级成“候选账号组解析 + 选择辅助”
- `src/plugin-hooks.ts`
  - 增加会话绑定、选号、rate-limit 捕获与切换逻辑
- `src/plugin.ts`
  - 菜单交互改成默认组多选、模型路由多选
- `src/ui/menu.ts`
  - 菜单文案与提示更新
- `src/plugin-actions.ts`
  - 配置写入逻辑适配账号组
- `src/copilot-network-retry.ts`
  - 复用或扩展 rate-limit 检测与切换后快速清理逻辑
- `src/routing-state.ts`（新文件）
  - routing-state 目录读写、append、轮转、compaction
- `test/model-account-map.test.js`
- `test/store.test.js`
- `test/plugin.test.js`
- `test/copilot-network-retry.test.js`
- `test/routing-state.test.js`（新文件）

## 测试设计

至少覆盖以下场景：

1. `StoreFile` 从单账号迁移到账号组。
2. 模型显式账号组优先，默认组回退正确。
3. 未绑定会话的第一次真实请求会触发选号，包含子代理场景。
4. 已绑定会话在非用户消息阶段持续复用。
5. 新用户轮次时按 `< 3` 差值规则决定复用或切换。
6. 近 30 分钟会话数统计只按不同 `sessionID` 计数。
7. `session-touch` 的 1 分钟写盘节流正确。
8. rate-limit 证据识别覆盖 `429`、`too_many_requests`、`rate_limit`。
9. 5 分钟滑动窗口内累计 3 次命中才会正式写入 `lastRateLimitedAt`。
10. 10 分钟冷却与“会话数更少”条件共同决定是否切换。
11. 切换成功时会 toast，并触发补偿动作。
12. 切换失败或无更优候选时保持原始失败行为。
13. routing-state 的 `snapshot + active + sealed` 并集读取正确。
14. 轮转期间读取不会漏数据。
15. 已折叠进 `snapshot.appliedSegments` 的 sealed 段不会被重复折叠。
16. `snapshot.json` 损坏或 `snapshot.tmp` 残留时仍可恢复读取。
17. compaction 会清掉超过 30 分钟的旧会话触点。
18. append、rotate、read 并发发生时不会明显丢数据或双计数。
19. Windows 下 rename / 打开失败分支具备回归覆盖。
20. “新的用户轮次”识别具备正例、反例和边界用例。
21. 切换账号时“一次性清理全部超长 ID”的快速路径与回退路径都可工作。

## 风险与注意事项

1. 多实例并发追加在不同平台上的原子性仍要做保守处理，尤其是 Windows 下的 rename 与文件句柄行为。
2. 如果菜单多选交互做得不清晰，用户可能难以理解“默认组”和“模型组”的区别。
3. rate-limit 补偿动作如果设计过重，可能额外放大请求量。
4. 一次性清理全部超长 ID 的快速路径需要非常谨慎，避免误删合法数据。
5. routing-state 若长期不 compaction，会导致读取成本上升；需要定义明确的轮转阈值和后台压缩触发时机。
6. `snapshot.appliedSegments` 与 sealed 文件删除顺序若实现不严谨，仍可能带来重复折叠或漏折叠；实现时必须把它视为一致性核心。

## 验收标准

1. 用户可以为默认组选择多个账号。
2. 用户可以为单模型选择多个账号。
3. 主代理与子代理都能在首次真实请求时正常选号。
4. 已绑定会话在非用户轮次不抖动。
5. 近 30 分钟使用更少的账号会优先被选中，但当前账号与最小值差距小于 3 时允许继续复用。
6. 某账号在单实例内 5 分钟滑动窗口累计 3 次 rate-limit 后，会被正式标记并参与 10 分钟冷却判断。
7. 若候选组中存在更优账号，会话可自动切换并通知用户。
8. 多实例共享 routing-state 时，不会因整文件覆盖而明显丢失近 30 分钟会话统计或 `lastRateLimitedAt`。
