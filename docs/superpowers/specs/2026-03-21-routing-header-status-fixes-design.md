# Routing Header / Account Cleanup / Status Footer 修复设计

## 背景

当前分支暴露出三类用户可见问题：

1. 删除账号后，该账号不会立刻从路由组映射里消失。
2. 某些用户消息虽然 toast 显示为“用户回合重选”，但服务端实际并没有把这次请求算进对应路由组账号的配额；compaction 前后却会出现一次配额下降。
3. `/copilot-status` 已经按默认组与路由组展示配额，底部再次列出“活跃组 / 路由组账号列表”变成重复信息。

这三类问题里，前两类都落在“账号状态 / routing / header 语义”边界上，第三类是 status 展示层遗留的冗余摘要。

## 目标

1. 删除账号时，相关 `modelAccountAssignments` 立即同步清理。
2. 路由判定、toast 与真实发送统一基于同一份 finalized request/header，避免“内部判定看到一套，服务端收到另一套”。
3. 修复“toast 显示用户回合重选，但服务端不按对应账号计费”的错位。
4. `/copilot-status` 保留分组配额网格，但移除底部重复的账号列表摘要。

## 非目标

1. 不重构整段 routing 架构。
2. 不修改 compaction 与 stop-tool 的对外语义。
3. 不重新设计 `/copilot-status` 的整体布局，只移除重复尾部。

## 关键发现

### 1. 删除账号后的路由组残留

最相关路径：

- `src/plugin.ts` 中的 `removeAccountFromStore(...)`
- `src/model-account-map.ts` 中的 `rewriteModelAccountAssignments(...)`

当前问题是：删除流程与映射重写的语义组合起来，会让账号名在删除当下仍被保留在 `modelAccountAssignments` 中。

### 2. 用户消息计费错位

当前最可疑的链路不是“header 在 1/2/3 步被写错”，而是：

1. `finalizeRequestForSelection(...)` 先重放出一份 finalized request/init；
2. `classifyRequestReason(...)` 与 toast 用的是这份 finalized header；
3. 但真正 `sendWithAccount(...)` 仍可能沿原始 request/init 发出；
4. 于是出现“内部判定和 toast 看到的是一套 header，服务端收到的却是另一套”的分叉。

在这个前提下，就能解释：

- toast 显示“用户回合重选”；
- 但对应路由组账号配额不下降；
- compaction 前后又能出现单次下降。

### 3. `/copilot-status` 的重复尾部

`src/status-command.ts` 在渲染完 `[default]` 和 `[model-id]` 分组网格后，仍然追加：

- `活跃组: ...`
- `路由组: ...`

这些尾部摘要在旧布局里有意义，但在当前网格展示里已经重复。

## 推荐方案

采用“统一 finalized request 语义 + 定点清理状态 + 收窄 status 尾部”的方案。

### A. 路由判定与真实发送统一

在 `src/plugin-hooks.ts` 中：

1. `finalizeRequestForSelection(...)` 产出的 finalized request/init，不再只用于 account 选择与 classification。
2. 真正的 `sendWithAccount(...)` 也要继续使用同一份 finalized request/init 作为起点。
3. 任何后续 header 改写（例如 `shouldStripAgentInitiator`）也要基于 finalized request，而不是回到原始 request。

这样可以保证：

- route reason
- consumption toast
- 实际发往服务端的 header

三者看到的是同一条语义链，而不是两套不同请求对象。

### B. 删除账号时立即清理映射

删除账号时应满足：

- `accounts[name]` 被删掉的同一轮逻辑里，`modelAccountAssignments` 也同步去掉该账号；
- 不依赖“后续归一化”或“下次读写 store”再收敛。

本次修复只处理“删除后立即消失”的一致性，不扩展到更大范围的映射重构。

### C. status 去重

在 `src/status-command.ts` 中：

- 保留当前 `[default]` / `[model-id]` 分组配额区块；
- 删除底部重复的“活跃组 / 路由组账号列表”尾部；
- 保证现有网格、空态和省略号行为不回退。

## 测试策略

### 1. 删除账号映射清理

补回归测试，确认：

- 删除账号后，`modelAccountAssignments` 立即不再包含该账号；
- 不需要再等下一次 store 归一化。

### 2. finalized request 一致性

补 routing/header 回归测试，锁定：

- account 选择使用 finalized request；
- 真实发送也使用同一份 finalized request；
- toast / route reason / outbound header 三者一致。

### 3. 用户消息计费错位回归

补一条直接对应该现象的测试：

- 用户消息命中路由组；
- toast 仍显示用户回合语义；
- 真实 outbound header 不再和 selection/classification 脱节。

### 4. status 去重

更新 `test/status-command.test.js`，确认：

- 分组配额仍然展示；
- 底部“活跃组 / 路由组”两行被移除；
- 现有 50 宽与分组断言保持成立。

## 风险与缓解

### 风险 1：finalized request 统一后影响现有 compaction / stop-tool 路径

缓解：

- 不改它们的对外语义；
- 只让它们和普通用户回合一样，统一走 finalized request 发送链；
- 用已有测试覆盖 compaction / synthetic 相关 header 行为，防止回退。

### 风险 2：修删除账号映射时误伤重命名语义

缓解：

- 本次只锁“删除即移除”；
- 不顺手扩大到 rename 行为重写。

### 风险 3：status 去重后丢失必要信息

缓解：

- 只删重复尾部；
- 上方分组网格仍完整承载账号与配额信息。

## 预期结果

完成后应达到：

1. 删除账号时，路由组映射立即同步清理。
2. 用户消息的路由判定、toast 与真实发给服务端的 header 重新一致。
3. `/copilot-status` 保留分组配额展示，但不再重复列出同样的组账号摘要。
