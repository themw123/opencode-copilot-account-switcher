# wechat stage-a 兼容宿主契约（Task 1）

## 目标

在 slash-only 场景下，以最小宿主面加载并注册 `@tencent-weixin/openclaw-weixin`。Task 1 要求优先使用包公开入口本体，不允许用本地伪造插件对象替代成功路径。

## 必需接口

- `api.runtime`：插件 `register(api)` 入口的前置条件。
- `api.runtime.gateway.startAccount`：作为网关上下文存在性校验项，缺失即失败。
- `api.runtime.channelRuntime`：必须为非空对象；缺失、空值、空对象或非对象值都立即失败。
- `api.registerChannel()`：插件注册通道所需，缺失即失败。

## 可 stub 接口

- `api.registerCli()`：可提供空实现，满足插件入口调用路径即可。
- `runtime` 下与 slash-only 启动无关的其他字段：可不实现或维持最小占位对象。

## 禁止接口与范围外能力

- 不实现 broker / bridge / token / request 代理能力。
- 不实现完整 OpenClaw routing / session / reply 语义。
- 不实现任何微信业务逻辑（登录、消息收发、轮询监控等）。
- 不允许用“本地构造兼容插件对象”冒充真实公开入口加载成功。

## 阶段 A 最终结论（Task 1）

在 Node v24.2.0 + `@tencent-weixin/openclaw-weixin@1.0.2` 下，直接包根导入会命中 `index.js` 解析失败，无法直接执行公开入口。

Task 1 采用以下最小兼容策略并已通过测试：

- 严格从 `package.json -> openclaw.extensions[0]` 读取公开入口（当前为 `./index.ts`）；
- 以该公开入口为根，将入口及其本地依赖 TS 文件编译到工作区临时目录后再 `import`；
- 依赖真实 `openclaw` 包提供 `openclaw/plugin-sdk` 解析能力；
- 继续执行最小宿主契约校验（`runtime`、`registerChannel`、`gateway.startAccount`、`channelRuntime`），并验证 `register(api)` 已真实调用。

约束满足情况：

- 未通过私有 `src/channel.ts` 等入口直接加载插件；
- 未使用本地伪插件对象冒充成功；
- 未引入 broker / bridge / slash guard / smoke harness 等 Task 2/3 范围能力。

已知风险与边界：

- 当前实现依赖 Node v24+ 的 `stripTypeScriptTypes`（实验特性，会有 ExperimentalWarning）；
- 首次加载会有明显编译开销（当前测试环境约 65s）。
- 当前仓库已将 `engines.node` 收紧到 `>=24.0.0`，以匹配 Task 1 的实际运行时前提。
- 兼容编译产物不会写回 `node_modules/@tencent-weixin/openclaw-weixin`，避免污染依赖包目录。
