# WeChat Compat 拆分与 2.0.1 迁移设计

## 背景

当前微信链路已经接通真实绑定、菜单入口、`/status` 运行时与 slash 指令，但 `src/wechat/compat/openclaw-public-helpers.ts` 仍承担过多职责：

- 同时负责插件入口解析、compat host 注册、账号 helper 适配、QR gateway 适配、轮询 helper 适配、发送 helper 适配、sync-buf 适配；
- 内部存在基于 `function.length` 的“猜协议”逻辑；
- 最近真实环境已经暴露出一次签名错配：把上游 channel config helper 当成错误签名调用，导致绑定流程在真实运行中报 `weixin: accountId is required (no default account)`。

同时，仓库依赖仍停留在 `@tencent-weixin/openclaw-weixin@^1.0.3`，而现有目标版本已经明确为 `2.0.1`。这轮需要把“兼容层拆分”与“2.0.1 迁移”合并处理，而不是继续在旧版假设上打补丁。

## 目标

1. 将 `@tencent-weixin/openclaw-weixin` 依赖升级到 `2.0.1`。
2. 将当前大一统 compat 文件拆分为按边界负责的多个 wrapper。
3. 所有 wrapper 以当前上游 `2.0.1` 的真实签名为准，不再保留探测式旧 shape 兼容逻辑。
4. 业务层只消费仓库内部定义的稳定接口，不直接感知上游 2.0.1 shape。
5. 用 wrapper 单测 + 现有业务回归测试，锁定迁移后的行为与契约。

## 非目标

1. 不在这轮重新设计微信菜单信息结构。
2. 不在这轮重写 broker/status 总体架构。
3. 不继续追求同时兼容未知 1.x/2.x/未来版本的动态探测。
4. 不把所有上游原始字段暴露给业务层或 UI 层。

## 上游 2.0.1 真实边界

基于当前已验证的 `2.0.1` 真实实现，这轮按以下协议建模：

### channel gateway

- `loginWithQrStart(params)`：要求对象入参。
- `loginWithQrWait(params)`：要求对象入参。

### channel config

- `listAccountIds(cfg)`
- `resolveAccount(cfg, accountId)`
- `describeAccount(account)`

### 其他 helper

- `getUpdates(params)`
- `sendMessageWeixin(params)`
- `sync-buf` 文件 helper

### account 路线决策

账号读取不再以 channel config surface 作为业务主路径。对于账号列表、账号详情、账号文件字段读取，改为直接基于上游账号源 helper 或等价源实现构建 wrapper。channel config 只保留在“公开入口装配验证”语境下，不再承担业务读取主职责。

这样做的原因：

- 真实 bug 已证明 channel config surface 对调用形状和上下文非常敏感；
- 账号信息本质属于本地账号状态；
- 直接对账号源 helper 建 adapter，比伪造 `OpenClawConfig` 更少隐式依赖；
- 未来上游若继续调整 plugin config surface，业务层受影响面更小。

## 目标结构

### 1. 装配层

保留 `src/wechat/compat/openclaw-public-helpers.ts`，但职责收缩为：

- 解析 `@tencent-weixin/openclaw-weixin` 公开入口；
- 通过最小 compat host 收集 plugin payload；
- 调用各子 wrapper loader；
- 组装并返回仓库内部统一的 `OpenClawWeixinPublicHelpers`；
- 做最小存在性校验与错误包装。

这个文件不再自己做协议判断，也不再承担具体 helper 适配细节。

### 2. account wrapper

新增单独 wrapper，负责：

- 读取账号列表；
- 读取账号详情；
- 统一 `accountId/name/enabled/configured/userId/boundAt/savedAt` 等业务需要的字段；
- 吸收上游账号文件 / helper shape 差异；
- 为 `bind-flow`、菜单展示、状态运行时提供稳定接口。

内部实现以上游账号源 helper 为准，而不是通过 `config.resolveAccount(cfg, accountId)` 间接转发。

### 3. gateway wrapper

新增单独 wrapper，负责：

- 统一 `loginWithQrStart` / `loginWithQrWait` 的对象入参契约；
- 将上游返回值收敛成绑定流程真正需要的稳定结构；
- 在必要时集中处理缺字段、失败消息、超时语义归一化。

### 4. updates/send wrapper

新增单独 wrapper，负责：

- `getUpdates` 的真实参数和返回值适配；
- `sendMessageWeixin` 的发送参数适配；
- 只暴露运行时实际需要的字段，避免把原始上游响应直接向外扩散。

### 5. sync-buf wrapper

新增单独 wrapper，负责：

- `getSyncBufFilePath` / `loadGetUpdatesBuf` / `saveGetUpdatesBuf` 读取与持久化；
- 给 `wechat-status-runtime` 提供稳定的 `persistGetUpdatesBuf` 能力；
- 将文件路径细节限制在 compat 层内部。

## 业务层影响

以下业务文件继续保留当前职责，但改为消费新 wrapper 暴露的稳定接口：

- `src/wechat/bind-flow.ts`
- `src/wechat/openclaw-account-adapter.ts`
- `src/wechat/wechat-status-runtime.ts`
- `src/wechat/compat/openclaw-smoke.ts`
- `src/wechat/compat/openclaw-guided-smoke.ts`

约束如下：

- 业务层不再直接猜测上游 helper 签名；
- 业务层不再需要知道 `cfg/account/object` 这些上游参数差异；
- 业务层只依赖仓库内部显式类型。

## 依赖升级策略

- `package.json` 中将 `@tencent-weixin/openclaw-weixin` 升级并固定到 `2.0.1`；
- `package-lock.json` 同步更新；
- 相关测试、guided smoke、JITI helper 路径全部按 `2.0.1` 实际内容验证；
- 不再保留“为 1.x 继续探测兼容”的分支。

## 测试策略

### wrapper 单测

每个 wrapper 单独覆盖：

1. 输入签名必须符合 2.0.1 真实形状；
2. 返回值必须被收敛成仓库内部稳定接口；
3. 异常与缺字段路径有稳定错误；
4. 不再使用“宽松探测”来让错误测试误绿。

### loader / 装配测试

保留一层集成测试验证：

- compat host 能从真实 plugin payload 中装配出所有 helper；
- 缺失 helper 时给出稳定错误；
- wrapper 组合后的最终对象满足业务层期望。

### 业务回归

至少保留并运行这些回归：

- `test/wechat-bind-flow.test.js`
- `test/wechat-openclaw-public-helpers.test.js`
- `test/wechat-status-flow.test.js`
- `test/ui-menu-wechat.test.js`

必要时补充：

- 绑定成功但无默认账号场景；
- QR gateway 返回值变化场景；
- `getUpdates` / send / sync-buf 的契约测试。

## 风险与控制

### 风险 1：拆分 compat 层后业务层回归

控制：先写 wrapper 测试，再迁移业务使用点；业务回归必须覆盖绑定、状态、菜单。

### 风险 2：2.0.1 的 helper 路径或 shape 与当前假设不符

控制：优先基于真实 `node_modules/@tencent-weixin/openclaw-weixin@2.0.1` 验证后再改实现；所有边界以实际源码为准。

### 风险 3：账号信息来源改走账号源 helper 后，字段集合与旧路径不完全一致

控制：由 account wrapper 负责补齐业务真正需要的字段；若字段不可得，统一在 wrapper 内做缺省处理，不把差异上抛到 UI。

## 验收标准

1. 依赖已升级到 `@tencent-weixin/openclaw-weixin@2.0.1`。
2. `openclaw-public-helpers.ts` 已明显收缩为装配层。
3. account/gateway/updates-send/sync-buf 至少拆成独立 wrapper。
4. 不再存在基于 `function.length` 的探测式兼容逻辑。
5. `bind-flow`、`wechat-status-runtime`、guided smoke 通过稳定接口消费 compat 层。
6. wrapper 单测与业务回归测试全部通过。
7. 真实绑定链路不再因 helper 签名错位触发 `accountId is required (no default account)` 这类错误。
