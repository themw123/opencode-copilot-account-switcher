# Synthetic Agent Initiator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个默认关闭的可选开关，在用户显式启用时，为 synthetic message 发送 `x-initiator=agent`，并完整披露其与 upstream 当前行为不一致的风险。

**Architecture:** 保持 official upstream `chat.headers` 为主路径，只在本地开关开启后追加一层最小化 synthetic part 检测逻辑。配置通过现有 store/menu 持久化，README 和菜单文案明确说明该功能是基于 upstream 开发中 synthetic 语义的提前启用方案，可能失效，也可能产生意外计费或更高滥用风险。

**Tech Stack:** TypeScript, Node.js, `node:test`, OpenCode plugin hooks, existing store/menu plumbing

---

## File Map

- Modify: `src/store.ts`
  - 为 store 增加 `syntheticAgentInitiatorEnabled` 配置位
  - 设置默认值与 debug snapshot 输出
- Modify: `src/ui/menu.ts`
  - 增加新的 toggle action 与中英文风险文案
  - 将该开关放入现有 Actions 区域，与其他 Copilot 行为类开关相邻
- Modify: `src/plugin-actions.ts`
  - 持久化菜单切换动作
- Modify: `src/plugin.ts`
  - 把新开关状态传给菜单显示
- Modify: `src/plugin-hooks.ts`
  - 在 official `chat.headers` 之后、仅在开关开启时检测 current message parts 中的 `text + synthetic: true`
  - lookup 失败时严格退回 official 行为
- Modify: `README.md`
  - 增加功能说明、风险披露和 upstream 讨论链接
- Test: `test/store.test.js`
  - 默认值与 debug snapshot 覆盖
- Test: `test/menu.test.js`
  - 菜单文案、排序与风险 hint 覆盖
- Test: `test/plugin.test.js`
  - 开关默认关闭、开启后 synthetic text 生效、非 synthetic / 非 text / lookup 失败不生效

---

## Chunk 1: Store 与菜单配置开关

### Task 1: 为 store 增加默认关闭的 synthetic initiator 开关

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.js`

- [ ] **Step 1: 写一个失败测试，断言 `parseStore()` 默认把新开关设为 `false`**

在 `test/store.test.js` 添加一个最小测试，读取 `parseStore('{"accounts":{}}')` 并断言 `syntheticAgentInitiatorEnabled === false`。

- [ ] **Step 2: 写一个失败测试，断言非 `true` 的异常值也会被归一为 `false`**

在 `test/store.test.js` 添加最小测试，例如传入：

```json
{"accounts":{},"syntheticAgentInitiatorEnabled":"yes"}
```

断言解析结果仍为 `false`。

- [ ] **Step 3: 运行定向测试确认 RED**

Run: `npm run build && node --test test/store.test.js --test-name-pattern "syntheticAgentInitiatorEnabled"`
Expected: FAIL，提示字段缺失或不是 `false`

- [ ] **Step 4: 最小修改 store 类型与默认值逻辑**

在 `src/store.ts` 中：
- 给 `StoreFile` 增加 `syntheticAgentInitiatorEnabled?: boolean`
- 在 `parseStore()` 中把缺省值与所有非 `true` 异常值统一归一为 `false`

- [ ] **Step 5: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/store.test.js --test-name-pattern "syntheticAgentInitiatorEnabled"`
Expected: PASS

- [ ] **Step 6: 写一个失败测试，断言 enabled store debug snapshot 会记录新开关状态**

在 `test/store.test.js` 复用现有 debug log 测试模式，断言日志中的 `before` / `after` snapshot 包含 `syntheticAgentInitiatorEnabled`。

- [ ] **Step 7: 运行定向测试确认 RED**

Run: `npm run build && node --test test/store.test.js --test-name-pattern "debug snapshot.*synthetic"`
Expected: FAIL，日志快照中还没有该字段

- [ ] **Step 8: 最小修改 store debug snapshot**

在 `buildStoreSnapshot()` 中加入 `syntheticAgentInitiatorEnabled`。

- [ ] **Step 9: 重新运行两个定向测试确认 GREEN**

Run: `npm run build && node --test test/store.test.js --test-name-pattern "syntheticAgentInitiatorEnabled|debug snapshot.*synthetic"`
Expected: PASS

- [ ] **Step 10: 提交本任务**

```bash
git add src/store.ts test/store.test.js
git commit -m "feat(store): 增加 synthetic initiator 开关配置"
```

### Task 2: 在菜单与菜单动作中接入 synthetic initiator toggle

**Files:**
- Modify: `src/ui/menu.ts`
- Modify: `src/plugin-actions.ts`
- Modify: `src/plugin.ts`
- Test: `test/menu.test.js`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写一个失败测试，断言菜单在 disabled 时显示开启文案与风险 hint**

在 `test/menu.test.js` 添加英文断言，检查存在 `Enable agent initiator for synthetic messages`，且 hint 包含类似 `differs from upstream`、`abuse`、`unexpected billing`。

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/menu.test.js --test-name-pattern "synthetic messages"`
Expected: FAIL

- [ ] **Step 3: 写一个失败测试，断言菜单在 enabled 时显示关闭文案**

在 `test/menu.test.js` 新增测试，传入 `syntheticAgentInitiatorEnabled: true`，断言存在 `Disable agent initiator for synthetic messages`。

- [ ] **Step 4: 运行定向测试确认 RED**

Run: `npm run build && node --test test/menu.test.js --test-name-pattern "Disable agent initiator for synthetic messages"`
Expected: FAIL

- [ ] **Step 5: 写一个失败测试，断言菜单顺序位于 network retry 之后、separator 之前**

在 `test/menu.test.js` 检查新 toggle 紧跟 `Enable Copilot network retry` / `Disable Copilot network retry` 之后，并保持在 Actions 区。

- [ ] **Step 6: 运行定向测试确认 RED**

Run: `npm run build && node --test test/menu.test.js --test-name-pattern "synthetic initiator toggle"`
Expected: FAIL

- [ ] **Step 7: 最小修改菜单类型、文案与展示参数**

在 `src/ui/menu.ts` 中：
- 增加 `MenuAction` 分支 `toggle-synthetic-agent-initiator`
- 增加中英文 label/hint
- 给 `buildMenuItems()` / `showMenu()` 增加 `syntheticAgentInitiatorEnabled` 参数

在 `src/plugin.ts` 中把 store 当前值传给 `showMenu()`。

- [ ] **Step 8: 写一个失败测试，断言菜单动作能持久化新字段**

在 `test/plugin.test.js` 参照现有 `toggle-network-retry` 测试，断言 `applyMenuAction()` 处理 `toggle-synthetic-agent-initiator` 后会把 store 字段切到 `true` 并写出。

- [ ] **Step 9: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "synthetic initiator"`
Expected: FAIL

- [ ] **Step 10: 最小修改菜单动作持久化逻辑**

在 `src/plugin-actions.ts` 中添加：
- toggle store 字段
- 写出 `reason` / `source` / `actionType`

- [ ] **Step 11: 重新运行相关定向测试确认 GREEN**

Run: `npm run build && node --test test/menu.test.js --test-name-pattern "synthetic" && node --test test/plugin.test.js --test-name-pattern "synthetic initiator"`
Expected: PASS

- [ ] **Step 12: 提交本任务**

```bash
git add src/ui/menu.ts src/plugin-actions.ts src/plugin.ts test/menu.test.js test/plugin.test.js
git commit -m "feat(menu): 增加 synthetic initiator 可选开关"
```

## Chunk 2: chat.headers synthetic 判定逻辑

### Task 3: 默认关闭时保持 official 行为不变

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写一个失败测试，断言默认关闭时 synthetic text 不会额外改写 initiator**

在 `test/plugin.test.js` 新增测试：
- store 返回 `syntheticAgentInitiatorEnabled: false`
- current message parts 返回 `[{ type: "text", text: "internal", synthetic: true }]`
- official `chat.headers` mock 不写 `x-initiator`
- 最终断言输出里没有被本插件强制加入 `x-initiator=agent`

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "default-off synthetic"`
Expected: FAIL

- [ ] **Step 3: 最小修改 plugin-hooks，接入开关读取但默认不生效**

在 `src/plugin-hooks.ts` 中：
- 扩展 `RetryStoreContext` 或等价 store context，包含 `syntheticAgentInitiatorEnabled`
- 在 `chat.headers` 中读取 store
- 开关未开启时直接退出本地 synthetic 逻辑

- [ ] **Step 4: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "default-off synthetic"`
Expected: PASS

- [ ] **Step 5: 提交本任务**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "refactor(headers): 为 synthetic initiator 预留开关接线"
```

### Task 4: 开启后仅对 `text + synthetic: true` 发送 agent initiator

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写一个失败测试，断言开启后 synthetic text 会设置 `x-initiator=agent`**

在 `test/plugin.test.js` 添加测试：
- store 返回 `syntheticAgentInitiatorEnabled: true`
- `client.session.message()` 返回 `parts: [{ type: "text", text: "auto continue", synthetic: true }]`
- official `chat.headers` mock 只写 `anthropic-beta`
- 断言结果含 `x-initiator=agent`

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "synthetic text.*agent"`
Expected: FAIL

- [ ] **Step 3: 最小实现 synthetic text 检测**

在 `src/plugin-hooks.ts` 中：
- 在 official `chat.headers` 之后调用现有 `client.session.message()` 路径读取当前 message
- 仅当存在 `part.type === "text" && part.synthetic === true` 时写入 `x-initiator=agent`

- [ ] **Step 4: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "synthetic text.*agent"`
Expected: PASS

- [ ] **Step 5: 写一个失败测试，断言开启后普通非 synthetic user message 不受影响**

在 `test/plugin.test.js` 添加测试，current message parts 为普通 `text` 且没有 `synthetic`，断言不会额外写入 `x-initiator=agent`。

- [ ] **Step 6: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "non-synthetic.*unaffected"`
Expected: FAIL

- [ ] **Step 7: 最小修正仅匹配 synthetic text**

如实现已经满足，该步只需保持最小代码；不要扩展额外行为。

- [ ] **Step 8: 写一个失败测试，断言即使文本长得像已知 continue 模板，只要 `synthetic !== true` 也绝不触发**

在 `test/plugin.test.js` 添加测试：
- current message parts 为 `[{ type: "text", text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." }]`
- 明确不带 `synthetic: true`
- 开关开启
- 最终不得设置 `x-initiator=agent`

这条测试用于强制实现不能退化成文本匹配。

- [ ] **Step 9: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "continue template.*without synthetic"`
Expected: FAIL

- [ ] **Step 10: 最小修正，确保绝不使用文本模板判定**

如果上一步测试已经通过，则只保留当前最小实现；不要引入任何文本模式分支。

- [ ] **Step 11: 写一个失败测试，断言 `synthetic: true` 但不是 `text` part 时不触发**

在 `test/plugin.test.js` 添加测试，例如 `parts: [{ type: "file", synthetic: true }]` 或 `parts: [{ type: "tool", synthetic: true }]`，最终不得设置 `x-initiator=agent`。

- [ ] **Step 12: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "synthetic non-text"`
Expected: FAIL

- [ ] **Step 13: 最小修正类型过滤**

确保只有 `text + synthetic: true` 才触发。

- [ ] **Step 14: 写一个失败测试，断言非 Copilot provider 不受影响**

在 `test/plugin.test.js` 添加测试，providerID 为 `google` 或其他 provider，即使 message 为 synthetic text 也不改写 initiator。

- [ ] **Step 15: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "non-Copilot provider"`
Expected: FAIL 或暴露已有回归

- [ ] **Step 16: 最小修正 provider 边界**

保持 synthetic 逻辑仅在 Copilot provider 生效。

- [ ] **Step 17: 重新运行相关定向测试确认 GREEN**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "synthetic text.*agent|non-synthetic.*unaffected|continue template.*without synthetic|synthetic non-text|non-Copilot provider"`
Expected: PASS

- [ ] **Step 18: 提交本任务**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "feat(headers): 支持 synthetic message agent 标识预测"
```

### Task 5: lookup 失败时严格退回 official 行为

**Files:**
- Modify: `src/plugin-hooks.ts`
- Test: `test/plugin.test.js`

- [ ] **Step 1: 写一个失败测试，断言 message lookup 失败时不越权改写 `x-initiator`**

在 `test/plugin.test.js` 添加测试：
- store 返回 `syntheticAgentInitiatorEnabled: true`
- `client.session.message()` 抛错
- official `chat.headers` mock 只返回 `anthropic-beta`
- 最终输出必须保持 official 结果，不新增 `x-initiator`

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "lookup failure"`
Expected: FAIL

- [ ] **Step 3: 最小实现 fail-open to official behavior**

在 `src/plugin-hooks.ts` 中：
- message lookup / parts 读取失败时吞掉 synthetic 预测分支错误
- 不改写 official 已写出的 headers

- [ ] **Step 4: 重新运行定向测试确认 GREEN**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "lookup failure"`
Expected: PASS

- [ ] **Step 5: 写一个失败测试，断言 official 已写出 `x-initiator` 时，lookup 失败也必须原样保留**

在 `test/plugin.test.js` 添加测试：
- store 返回 `syntheticAgentInitiatorEnabled: true`
- official `chat.headers` mock 写入 `x-initiator=agent`
- `client.session.message()` 抛错
- 最终结果必须保留 `x-initiator=agent`，不能删除、覆盖或清空

- [ ] **Step 6: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "lookup failure.*preserves official initiator"`
Expected: FAIL

- [ ] **Step 7: 最小修正，保留 official 已写出的 initiator**

如果当前实现已经满足，则只保持最小代码；不要新增无关分支。

- [ ] **Step 8: 写一个失败测试，断言 `message.id` 缺失时严格回退 official 行为**

在 `test/plugin.test.js` 添加测试：
- 开关开启
- `hookInput.message.id` 缺失
- official `chat.headers` mock 不写 initiator
- 最终不得额外新增 `x-initiator`

- [ ] **Step 9: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "missing message id"`
Expected: FAIL

- [ ] **Step 10: 最小修正缺失 message id 的回退逻辑**

保持在无法定位 current message 时直接退出 synthetic 预测逻辑。

- [ ] **Step 11: 写一个失败测试，断言 parts 缺失或为空时严格回退 official 行为**

在 `test/plugin.test.js` 添加测试：
- `client.session.message()` 返回 `{ data: {} }` 或 `{ data: { parts: [] } }`
- 开关开启
- official `chat.headers` mock 不写 initiator
- 最终不得额外新增 `x-initiator`

- [ ] **Step 12: 运行定向测试确认 RED**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "missing parts|empty parts"`
Expected: FAIL

- [ ] **Step 13: 最小修正 parts 缺失/为空的回退逻辑**

确保只有在明确拿到可用 parts 且命中 `text + synthetic: true` 时才改写 initiator。

- [ ] **Step 14: 重新运行相关定向测试确认 GREEN**

Run: `npm run build && node --test test/plugin.test.js --test-name-pattern "lookup failure|preserves official initiator|missing message id|missing parts|empty parts"`
Expected: PASS

- [ ] **Step 15: 提交本任务**

```bash
git add src/plugin-hooks.ts test/plugin.test.js
git commit -m "fix(headers): synthetic lookup 失败时回退官方行为"
```

## Chunk 3: README 风险披露与上游参考

### Task 6: 更新 README，完整披露 synthetic initiator 功能边界

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 写 README 修改清单并对照 spec 逐项核对**

在开始修改前先根据 spec 列出必须覆盖的信息：
- 默认关闭
- 行为与 upstream 当前稳定代码不一致
- 可能更容易被判定为滥用
- 可能失效或产生意外计费
- 作用是发送/覆盖 `x-initiator=agent`，实际计费由平台决定
- 给出 `#8700`、`#8721`、`#8766`、`88226f...` 链接

- [ ] **Step 2: 最小修改 README 中文部分**

新增独立小节，说明该功能的作用、风险和上游参考。

- [ ] **Step 3: 最小修改 README 英文部分**

保持与中文同等信息密度，避免只更新一侧。

- [ ] **Step 4: 人工核对 README 文字边界**

确认没有写成“官方已经支持”或“启用后一定免计费”，而是写成“发送/覆盖 initiator header，实际计费由平台决定”。

- [ ] **Step 5: 运行一次文本核对命令，确认 README 含必要风险关键字与上游链接**

Run: `node --test test/menu.test.js --test-name-pattern "synthetic"`
Expected: PASS（菜单文案相关测试仍通过）

然后人工核对 `README.md` 中以下内容全部存在：
- `8700`
- `8721`
- `8766`
- `88226f30610d6038a431796a8ae5917199d49c74`
- `upstream`
- `abuse` 或中文“滥用”
- `unexpected billing` 或中文“意外计费`

- [ ] **Step 6: 提交本任务**

```bash
git add README.md
git commit -m "docs(readme): 补充 synthetic initiator 开关风险说明"
```

## Chunk 4: 全量验证

### Task 7: 跑全量验证并修复剩余问题

**Files:**
- Modify: 任何前述任务涉及文件（仅用于修复验证暴露的问题）

- [ ] **Step 1: 运行类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: 运行全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: 运行 upstream snapshot 校验**

Run: `npm run check:copilot-sync`
Expected: PASS

- [ ] **Step 4: 若失败，只做最小修复并回到对应定向测试**

不要捆绑无关优化；每次只修一个失败点。

- [ ] **Step 5: 重新运行全量验证确认全部通过**

Run: `npm run typecheck && npm test && npm run check:copilot-sync`
Expected: PASS

- [ ] **Step 6: 提交验证修复（如果该任务产生改动）**

```bash
git add <relevant-files>
git commit -m "test: 修正 synthetic initiator 全量验证问题"
```
