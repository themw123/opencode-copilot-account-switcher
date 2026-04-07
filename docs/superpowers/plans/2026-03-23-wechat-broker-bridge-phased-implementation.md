# OpenCode-WeChat Broker Bridge 分阶段实施计划 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不自研微信私有协议的前提下，分阶段落地单例 broker 方案，让 OpenCode 支持微信 `/status`、事件通知以及 `question` / permission 回复。

**Architecture:** 采用“每个 OpenCode 实例内一个轻量 bridge + 用户级单例 broker”的结构。broker 独占 `@tencent-weixin/openclaw-weixin` transport 与共享状态，bridge 只负责本实例 OpenCode 官方 API 和事件摘要；每个阶段都要求能独立验收，不一次把整份 spec 全量压进同一个提交窗口。

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin hooks, `@opencode-ai/sdk` v2, local IPC, `@tencent-weixin/openclaw-weixin`

---

## 文件结构预分解

实施前先固定文件职责，避免把 broker、bridge、微信宿主、状态文件逻辑堆进 `src/plugin-hooks.ts`：

- `src/store-paths.ts`
  - 扩展 `wechat` 状态目录路径 helper
- `src/wechat/state-paths.ts`
  - `wechat/` 子目录、broker 元数据、请求目录、token 目录的绝对路径 helper
- `src/wechat/protocol.ts`
  - broker/bridge IPC 消息类型、事件名、序列化边界
- `src/wechat/handle.ts`
  - `routeKey` / `handle` 生成与校验
- `src/wechat/operator-store.ts`
  - `operator.json` 读写与单操作者绑定规则
- `src/wechat/ipc-auth.ts`
  - broker/bridge 注册后的会话凭证、关键指令鉴权与幂等保护
- `src/wechat/token-store.ts`
  - `context_token` 持久化、stale 标记、选择最新 token 规则
- `src/wechat/request-store.ts`
  - `question` / permission 映射、TTL、expired/dead-letter 清理
- `src/wechat/session-digest.ts`
  - `session digest` reducer 与“最新动作摘要”优先级
- `src/wechat/status-format.ts`
  - `/status` 聚合结果格式化
- `src/wechat/command-parser.ts`
  - `/status`、`/reply`、`/allow` 等微信 slash 命令解析
- `src/wechat/broker-client.ts`
  - bridge 侧 IPC 客户端
- `src/wechat/broker-server.ts`
  - broker 侧 IPC server、实例注册、广播与请求路由
- `src/wechat/broker-launcher.ts`
  - connect-or-spawn、锁、idle 管理、broker 拉起入口
- `src/wechat/broker-entry.ts`
  - detached broker 进程主入口
- `src/wechat/bridge.ts`
  - OpenCode 事件订阅、摘要更新、broker 回调执行
- `src/wechat/compat/openclaw-host.ts`
  - 最小 compat host，用包公开的插件入口加载 `openclaw-weixin`
- `src/wechat/compat/openclaw-smoke.ts`
  - 真实 `openclaw-weixin` 链路的最小冒烟入口
- `src/wechat/compat/slash-guard.ts`
  - 仅允许 slash-only PoC 交互，拦截非命令型微信消息
- `src/plugin-hooks.ts`
  - 负责把 bridge 生命周期挂到现有 plugin hooks 上
- `package.json`
  - 固定 `@tencent-weixin/openclaw-weixin` 依赖版本

测试文件建议对应拆开，避免一个 test 文件验证多个子系统：

- `test/wechat-openclaw-host.test.js`
- `test/wechat-openclaw-smoke.test.js`
- `test/wechat-state-paths.test.js`
- `test/wechat-operator-store.test.js`
- `test/wechat-token-store.test.js`
- `test/wechat-request-store.test.js`
- `test/wechat-broker-lifecycle.test.js`
- `test/wechat-session-digest.test.js`
- `test/wechat-status-flow.test.js`
- `test/wechat-notify-flow.test.js`
- `test/wechat-question-permission-flow.test.js`
- `test/wechat-recovery.test.js`

下面每个 Task 都是一个可独立验收的阶段；只有当前阶段收口后，才进入下一阶段。

### Task 1: 收敛 `openclaw-weixin` 最小 compat host 风险

**阶段目标：** 证明我们可以通过包的插件入口加载 `openclaw-weixin`，并把微信入口限制在 slash-only 路径，而不是先实现完整 OpenClaw 宿主。

**Files:**
- Create: `src/wechat/compat/openclaw-host.ts`
- Create: `src/wechat/compat/slash-guard.ts`
- Modify: `package.json`
- Test: `test/wechat-openclaw-host.test.js`

- [ ] **Step 1: 写失败测试，锁定 compat host 的最小契约**

在 `test/wechat-openclaw-host.test.js` 增加这些断言：
- 能通过插件默认导出入口调用 `register(api)`；
- 最小 `runtime` / `registerChannel()` / gateway `startAccount` 上下文缺失时立即失败；
- 非 slash 消息进入 guard 时会被明确拒绝，而不是继续尝试 OpenClaw AI reply 流；
- slash-only 路径下不会要求完整 OpenClaw routing/session/reply 实现。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-openclaw-host.test.js`
Expected: FAIL，因为 compat host 文件和相关约束尚未实现。

- [ ] **Step 3: 固定依赖版本并做最小实现**

实现边界：
- `package.json` 固定 `@tencent-weixin/openclaw-weixin` 的精确版本或极窄 semver；
- `src/wechat/compat/openclaw-host.ts` 只实现 PoC 必需的宿主面；
- `src/wechat/compat/slash-guard.ts` 明确拒绝非 slash 交互，并返回“PoC 当前仅支持命令型交互”；
- 不引入任何 OpenClaw AI reply 逻辑。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-openclaw-host.test.js`
Expected: PASS，说明最小 compat host 假设成立，且非 slash 已被 guard。

- [ ] **Step 5: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- package.json src/wechat/compat/openclaw-host.ts src/wechat/compat/slash-guard.ts test/wechat-openclaw-host.test.js`
Expected: 只包含 compat host 风险收敛相关改动。

### Task 1.5: 跑通 `openclaw-weixin` 真实链路冒烟

**阶段目标：** 不只验证契约和 mock，还要用真实包完成一次“最小宿主 + slash-only + 假网络”的冒烟，避免后续阶段建立在过度乐观的假设上。

**Files:**
- Create: `src/wechat/compat/openclaw-smoke.ts`
- Test: `test/wechat-openclaw-smoke.test.js`
- Modify: `src/wechat/compat/openclaw-host.ts`

- [ ] **Step 1: 写失败测试，先锁定真实包冒烟边界**

在 `test/wechat-openclaw-smoke.test.js` 增加这些断言：
- pinned 版本的真实 `openclaw-weixin` 能被最小 compat host 启动；
- 能进入 `startAccount` 并完成 slash-only 入口初始化；
- 遇到 `/status`、`/reply`、`/allow` 时不会越界进入 OpenClaw AI reply 路径；
- token stale 后再次 `/status` 激活的入口能被保留。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-openclaw-smoke.test.js`
Expected: FAIL，因为真实链路冒烟入口还不存在。

- [ ] **Step 3: 实现最小冒烟入口**

实现边界：
- `src/wechat/compat/openclaw-smoke.ts` 只做最小自检，不承载业务逻辑；
- 用假网络/假账号上下文验证真实包能完成启动与 slash-only 路径收口；
- 一旦检测到自由聊天越界，立即 fail fast。

- [ ] **Step 4: 跑冒烟集合确认转绿**

Run: `npm run build && node --test test/wechat-openclaw-host.test.js test/wechat-openclaw-smoke.test.js`
Expected: PASS，说明最小宿主不仅契约成立，而且真实包能被安全拉起。

- [ ] **Step 5: 手动自检一次真实冒烟入口**

Run: `npm run build && node dist/wechat/compat/openclaw-smoke.js --self-test`
Expected: 输出 slash-only 自检通过，不发起真实 AI reply。

- [ ] **Step 6: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/wechat/compat/openclaw-host.ts src/wechat/compat/openclaw-smoke.ts test/wechat-openclaw-smoke.test.js`
Expected: 只包含真实链路冒烟相关改动。

### Task 2: 建立 broker 单例骨架与共享状态文件

**阶段目标：** 在没有微信业务逻辑之前，先打通单例 broker、共享状态路径、请求与 token 持久化骨架。这一阶段验收只看“多实例不会拉起多个 broker，状态文件能稳定读写”。

**Files:**
- Create: `src/wechat/state-paths.ts`
- Create: `src/wechat/protocol.ts`
- Create: `src/wechat/handle.ts`
- Create: `src/wechat/operator-store.ts`
- Create: `src/wechat/ipc-auth.ts`
- Create: `src/wechat/token-store.ts`
- Create: `src/wechat/request-store.ts`
- Create: `src/wechat/broker-client.ts`
- Create: `src/wechat/broker-server.ts`
- Create: `src/wechat/broker-launcher.ts`
- Create: `src/wechat/broker-entry.ts`
- Modify: `src/store-paths.ts`
- Test: `test/wechat-state-paths.test.js`
- Test: `test/wechat-operator-store.test.js`
- Test: `test/wechat-token-store.test.js`
- Test: `test/wechat-request-store.test.js`
- Test: `test/wechat-broker-lifecycle.test.js`

- [ ] **Step 1: 写失败测试，固定路径、单操作者、token 语义、IPC 握手和单例语义**

增加这些断言：
- `wechat` 状态目录落在 `~/.config/opencode/account-switcher/wechat/`；
- `handle` 全局唯一、大小写不敏感、不能直接接受原始 `requestID`；
- `operator-store` 首次绑定成功后，第二个微信用户会被拒绝，直到显式重置；
- token 是否可用只由“最近入站刷新 + stale 标记/发送结果”决定，不能因为固定时长自动失效；
- request store 支持 `open -> answered|rejected|expired -> cleaned`；
- dead-letter 默认保留 7 天；
- `registerInstance()` 成功后会返回会话凭证；
- 未携带会话凭证的关键 IPC 指令会被拒绝；
- 两个 launcher 同时启动时，只会有一个 broker 被真正拉起。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js`
Expected: FAIL，因为 wechat 路径 helper、单操作者约束、token store、IPC 握手和 broker 单例骨架尚未实现。

- [ ] **Step 3: 实现最小状态与生命周期骨架**

实现边界：
- `src/store-paths.ts` 增加 `wechat` 根目录 helper；
- `src/wechat/state-paths.ts` 封装 broker、requests、tokens、instances 路径；
- `src/wechat/handle.ts` 负责 `routeKey` 与 `handle` 生成；
- `src/wechat/operator-store.ts`、`src/wechat/token-store.ts`、`src/wechat/request-store.ts` 负责文件读写与 TTL；
- `src/wechat/ipc-auth.ts` 负责 register 后的会话凭证与关键消息校验；
- `src/wechat/broker-launcher.ts` 实现 connect-or-spawn + lock；
- `src/wechat/broker-entry.ts` 与 `src/wechat/broker-server.ts` 先只做到“能启动、能注册、能存活、能拒绝未鉴权关键调用”。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js`
Expected: PASS，说明 broker 单例骨架、单操作者、token 语义和最小 IPC 安全边界已经稳定。

- [ ] **Step 5: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/store-paths.ts src/wechat/state-paths.ts src/wechat/protocol.ts src/wechat/handle.ts src/wechat/operator-store.ts src/wechat/ipc-auth.ts src/wechat/token-store.ts src/wechat/request-store.ts src/wechat/broker-client.ts src/wechat/broker-server.ts src/wechat/broker-launcher.ts src/wechat/broker-entry.ts test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js`
Expected: 只包含 broker 与共享状态骨架改动。

### Task 3: 打通 `/status` 的纵向切片

**阶段目标：** 先把最核心、最可验收的用户入口 `/status` 做通。验收标准不是“全部微信能力都有”，而是“微信 `/status` 能看到多个 OpenCode 实例的摘要”。

**Files:**
- Create: `src/wechat/session-digest.ts`
- Create: `src/wechat/status-format.ts`
- Create: `src/wechat/command-parser.ts`
- Create: `src/wechat/bridge.ts`
- Modify: `src/plugin-hooks.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/broker-client.ts`
- Test: `test/wechat-session-digest.test.js`
- Test: `test/wechat-status-flow.test.js`

- [ ] **Step 1: 写失败测试，先固定 digest 与 `/status` 汇总规则**

在 `test/wechat-session-digest.test.js` 和 `test/wechat-status-flow.test.js` 中覆盖：
- `latestAction` 优先级：`question > permission > running tool > completed tool > command > todo > idle`；
- broker 广播 `collectStatus()` 后能收到多个 bridge 的摘要；
- `/status` 聚合窗口内未响应实例被标记为 `timeout/unreachable`；
- 返回内容最多带 3 个最近活跃 session。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-session-digest.test.js test/wechat-status-flow.test.js`
Expected: FAIL，因为 bridge 摘要和 status 聚合尚未实现。

- [ ] **Step 3: 实现 `/status` 纵向切片**

实现边界：
- `src/wechat/session-digest.ts` 负责摘要 reducer；
- `src/wechat/status-format.ts` 负责多实例状态文案；
- `src/wechat/command-parser.ts` 先支持 `/status`；
- `src/wechat/bridge.ts` 订阅本实例 OpenCode 事件并维护摘要；
- `src/plugin-hooks.ts` 负责启动 bridge 并注册 broker；
- `src/wechat/broker-server.ts` 广播 `collectStatus()` 并聚合返回值。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-session-digest.test.js test/wechat-status-flow.test.js`
Expected: PASS，broker 能收集多个 bridge 的状态并格式化返回。

- [ ] **Step 5: 做一次阶段验收（本地纵向切片）**

Run: `npm run build && node --test test/wechat-openclaw-host.test.js test/wechat-openclaw-smoke.test.js test/wechat-broker-lifecycle.test.js test/wechat-session-digest.test.js test/wechat-status-flow.test.js`
Expected: PASS，说明 compat host、真实冒烟、broker 骨架和 `/status` 切片已经连通。

- [ ] **Step 6: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/wechat/session-digest.ts src/wechat/status-format.ts src/wechat/command-parser.ts src/wechat/bridge.ts src/plugin-hooks.ts src/wechat/broker-server.ts src/wechat/broker-client.ts test/wechat-session-digest.test.js test/wechat-status-flow.test.js`
Expected: 只包含 `/status` 纵向切片相关变更。

### Task 4: 加入事件通知与 token stale fallback

**阶段目标：** 在 `/status` 能工作的基础上，再加入事件推送到微信，以及 token 失效后的本地 toast 回退。

**Files:**
- Modify: `src/wechat/token-store.ts`
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/command-parser.ts`
- Test: `test/wechat-notify-flow.test.js`

- [ ] **Step 1: 写失败测试，固定 token 选择和 fallback 行为**

覆盖这些断言：
- broker 总是取最近一次成功入站消息写入的 token；
- 发送失败会把 token 标记为 `stale`；
- `stale` 后不会继续尝试推送，直到下一次微信入站刷新；
- 发送失败时 broker 会向目标 bridge 发 `showFallbackToast()`；
- fallback 文案固定为“微信会话可能已失效，请在微信发送 `/status` 重新激活”。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-notify-flow.test.js`
Expected: FAIL，因为事件推送和 fallback 流还不存在。

- [ ] **Step 3: 实现最小事件通知能力**

实现边界：
- bridge 只转发 spec 已确认的可推送事件；
- broker 根据 `operator.json` 和 `token-store` 选择目标；
- token stale 时不删除记录，只打标并触发 fallback；
- `/status` 仍然是重新激活 token 的唯一官方入口。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-notify-flow.test.js`
Expected: PASS，事件推送和 fallback 行为与 spec 一致。

- [ ] **Step 5: 做阶段验收（用户可见能力）**

Run: `npm run build && node --test test/wechat-status-flow.test.js test/wechat-notify-flow.test.js`
Expected: PASS，说明 `/status` 和事件通知都已可验收。

- [ ] **Step 6: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/wechat/token-store.ts src/wechat/bridge.ts src/wechat/broker-server.ts src/wechat/command-parser.ts test/wechat-notify-flow.test.js`
Expected: 只包含事件推送与 stale fallback 相关变更。

### Task 5: 打通 `question` / permission 回复闭环

**阶段目标：** 在不开放微信自由聊天的前提下，把等待态交互真正闭环：WeChat slash 命令 -> broker 路由 -> bridge 调 OpenCode 官方 API。

**Files:**
- Modify: `src/wechat/request-store.ts`
- Modify: `src/wechat/command-parser.ts`
- Modify: `src/wechat/bridge.ts`
- Modify: `src/wechat/broker-server.ts`
- Test: `test/wechat-question-permission-flow.test.js`

- [ ] **Step 1: 写失败测试，先固定 handle 语义和错误路径**

覆盖这些断言：
- `question.asked` 和 `permission.asked` 会生成全局唯一 `handle`；
- 微信侧只能使用 `handle`，误传原始 `requestID` 必须被明确拒绝；
- `/reply <qid> ...` 能路由到正确实例与正确 session；
- `/allow <pid> once|always|reject` 能路由到正确实例；
- 实例离线、请求过期、映射不存在时会返回统一错误提示。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-question-permission-flow.test.js`
Expected: FAIL，因为 question/permission 路由闭环尚未实现。

- [ ] **Step 3: 实现最小闭环**

实现边界：
- `src/wechat/request-store.ts` 负责 question/permission 的持久化与 TTL；
- `src/wechat/command-parser.ts` 增加 `/reply` 与 `/allow`；
- `src/wechat/broker-server.ts` 只负责解析、反查 `handle -> routeKey -> requestID`、再路由到 bridge；
- `src/wechat/bridge.ts` 只通过 OpenCode 官方 `question.reply()` / `question.reject()` / `permission.reply()` 修改会话状态。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-question-permission-flow.test.js`
Expected: PASS，`question` / permission 闭环成立，误用原始 `requestID` 也会被拒绝。

- [ ] **Step 5: 做阶段验收（交互闭环）**

Run: `npm run build && node --test test/wechat-status-flow.test.js test/wechat-notify-flow.test.js test/wechat-question-permission-flow.test.js`
Expected: PASS，PoC 的 3 个用户主路径已经全部可验收。

- [ ] **Step 6: 记录 checkpoint（仅在用户明确要求时提交）**

Run: `git diff -- src/wechat/request-store.ts src/wechat/command-parser.ts src/wechat/bridge.ts src/wechat/broker-server.ts test/wechat-question-permission-flow.test.js`
Expected: 只包含等待态交互闭环相关变更。

### Task 6: 恢复与最终回归

**阶段目标：** 在主路径都工作后，再补 crash recovery、TTL 清理与最终回归，避免前面阶段为了“先可用”留下隐患。

**Files:**
- Modify: `src/wechat/broker-server.ts`
- Modify: `src/wechat/broker-client.ts`
- Modify: `src/wechat/broker-launcher.ts`
- Modify: `src/wechat/request-store.ts`
- Modify: `src/wechat/token-store.ts`
- Modify: `src/wechat/bridge.ts`
- Test: `test/wechat-recovery.test.js`
- Test: `test/wechat-broker-lifecycle.test.js`
- Test: `test/wechat-question-permission-flow.test.js`

- [ ] **Step 1: 写失败测试，先固定恢复和安全边界**

覆盖这些断言：
- broker 崩溃后 bridge 会重连并 full sync；
- 已离线实例持有的请求会在 TTL 后转为 dead-letter；
- dead-letter 超过 7 天会被清理；
- broker idle 退出不会被已过期请求永久阻塞。

- [ ] **Step 2: 跑定向测试确认先失败**

Run: `npm run build && node --test test/wechat-recovery.test.js test/wechat-broker-lifecycle.test.js test/wechat-question-permission-flow.test.js`
Expected: FAIL，因为重连、TTL 清理和 dead-letter 回收还未完整落地。

- [ ] **Step 3: 实现恢复与安全加固**

实现边界：
- `src/wechat/broker-launcher.ts` 明确 idle 退出、旧 pid 接管、并发拉起冲突处理；
- `src/wechat/request-store.ts` 增加 expired/dead-letter 清理；
- `src/wechat/bridge.ts` 在 broker 重连后执行 `session.status()`、`question.list()`、`permission.list()` 全量同步。

- [ ] **Step 4: 跑定向测试确认转绿**

Run: `npm run build && node --test test/wechat-recovery.test.js test/wechat-broker-lifecycle.test.js test/wechat-question-permission-flow.test.js`
Expected: PASS，恢复和访问控制行为收口。

- [ ] **Step 5: 跑本功能全量测试集合**

Run: `npm run build && node --test test/wechat-openclaw-host.test.js test/wechat-openclaw-smoke.test.js test/wechat-state-paths.test.js test/wechat-operator-store.test.js test/wechat-token-store.test.js test/wechat-request-store.test.js test/wechat-broker-lifecycle.test.js test/wechat-session-digest.test.js test/wechat-status-flow.test.js test/wechat-notify-flow.test.js test/wechat-question-permission-flow.test.js test/wechat-recovery.test.js`
Expected: PASS，所有 broker/bridge 相关测试通过。

- [ ] **Step 6: 跑仓库全量测试**

Run: `npm test`
Expected: PASS，现有 Copilot/Codex 功能没有被回归破坏。

- [ ] **Step 7: 检查最终改动范围（仅在用户明确要求时提交）**

Run: `git diff -- docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md docs/superpowers/plans/2026-03-23-wechat-broker-bridge-phased-implementation.md src package.json test`
Expected: 只包含本次微信 broker bridge 相关改动。

- [ ] **Step 8: 记录 checkpoint（仅在用户明确要求时提交）**

建议提交信息：
- `feat(wechat): 建立 slash-only 单例 broker 骨架`
- `feat(wechat): 打通状态聚合与通知回退`
- `feat(wechat): 接入 question 与 permission 回复链路`
- `refactor(wechat): 收敛恢复与 IPC 访问控制`

## 执行顺序约束

1. 先做 Task 1 和 Task 1.5，再决定是否继续；如果最小 compat host 假设或真实冒烟失败，必须回到 spec 调整。
2. Task 2 完成前，不允许写任何“真正的微信业务逻辑”。
3. Task 2 已经必须带上最小 IPC 安全握手与单操作者约束，不能把这两个基础约束拖到尾声。
4. Task 3 是第一个用户可感知的可验收阶段；只有 `/status` 跑通，才允许继续做事件推送。
5. Task 4 完成前，不允许把 `question` / permission 路由做成半成品。
6. Task 5 完成后才算 PoC 主路径闭环；Task 6 负责把它变成可维护的实现，而不是“能跑一次”的 demo。

## 与 Spec 的对应关系

- Spec: `docs/superpowers/specs/2026-03-23-wechat-broker-bridge-design.md`
- 本计划特意把 spec 拆成多个独立验收阶段，避免“所有能力同时落地”导致风险集中。
