# WeChat 菜单 / 绑定 / 多账号扩展 Follow-up 设计

## 背景

`v0.14.0` 已经完成两件基础能力：

1. 基于 JITI + public helper 路线接通真实微信 `/status` 入口；
2. 增加了最小“微信通知”菜单面与配置项。

但当前实现仍有 4 个明显缺口：

1. “微信通知”还只是顶层一段，不是挂在通用菜单中的真正子项；
2. `wechat-bind` 目前只有 action，没有真实绑定流程；
3. 绑定成功后没有展示当前已绑定微信账号的信息；
4. 当前设置结构还是平铺布尔值，没有为未来多微信账号绑定 / 多账号推送留出好结构。

另外，还存在一个版本演进要求：

- 当前仓库依赖的 `@tencent-weixin/openclaw-weixin` 还是 `^1.0.3`；
- 上游已经发布 `2.0.1`；
- 下一轮设计必须把升级兼容性纳入范围，而不是默认继续绑定旧版本的结构假设。

## 已确认事实

在当前代码和上游插件里，已经确认这些能力可被利用：

1. 上游 `weixinPlugin.config` 提供：
   - `listAccountIds()`
   - `resolveAccount()`
   - `describeAccount()`
2. 稳定可展示的账号字段至少包括：
   - `accountId`
   - `name`
   - `enabled`
   - `configured`
3. 账号存储里还能稳定读到：
   - `userId`
   - `savedAt`
4. 当前 JITI 路线还可以读到：
   - `getUpdatesBuf`
   - `baseUrl`

但其中并不是所有字段都适合直接展示给用户。

## 展示原则

### 应展示

绑定成功状态下，菜单里可以展示这类对用户有意义的字段：

- 当前绑定的微信 accountId
- 当前绑定账号的 name（如果上游可提供）
- 当前绑定账号是否 enabled
- 当前绑定账号是否 configured
- 当前绑定用户标识（userId，必要时可做脱敏）
- 本地绑定时间（boundAt / savedAt）

### 不应展示

以下字段即使技术上可读，也不应该作为用户菜单主展示项：

- `baseUrl`
- `getUpdatesBuf`
- 其它 transport / polling 内部状态

原因：

- 这些字段对用户几乎没有操作意义；
- 它们不是“账号身份”信息；
- 容易把用户菜单污染成内部调试面板。

## 目标

这份 follow-up spec 的目标是：

1. 把“微信”能力从当前零散入口收口成通用菜单里的一个真正子菜单；
2. 让 `wechat-bind` 变成真实可用的绑定流程；
3. 在绑定成功后展示当前已绑定微信账号的核心信息；
4. 把设置结构从平铺布尔值升级成可面向多账号扩展的结构；
5. 在设计上提前兼容 `@tencent-weixin/openclaw-weixin@2.0.1`。

## 非目标

本 spec 不做这些事情：

1. 不实现完整通知系统。
2. 不一次性做多账号推送策略本身。
3. 不把 transport 内部调试字段全部展示给用户。
4. 不在这份 spec 里重新设计 `/status` 内核链路。

## 方案收口

### 菜单层级

选定方案：

- “微信”放在**通用菜单**下，作为一个独立子项；
- 用户先进入“微信”子菜单，再看到绑定状态、绑定入口和通知设置；
- 不再把微信配置与 provider-specific 开关混排在顶层列表里。

### 绑定流程

选定方案：

- `wechat-bind` 不再是“无副作用 action”；
- 它必须进入真实绑定流程；
- 绑定流程至少要做到：
  - 发起绑定 / 重绑
  - 成功后写入本地绑定状态
  - 失败时返回明确错误

### 已绑定信息展示

选定方案：

- 微信子菜单顶部显示“当前绑定状态卡片”；
- 展示用户可理解的账号信息；
- 不展示 `baseUrl` 这类内部字段。

### 多账号扩展

选定方案：

- 当前设置结构不再继续走多个顶层布尔值；
- 要改为一个可扩展的微信配置对象；
- 对单账号场景先落一个 `primary` 绑定，但结构上允许未来扩成多账号列表。

### 版本跟进

选定方案：

- 这轮 follow-up 必须显式考虑 `@tencent-weixin/openclaw-weixin@2.0.1`；
- 实现时要优先确认 `2.0.1` 下这些能力是否仍可用：
  - `listAccountIds()`
  - `resolveAccount()`
  - `describeAccount()`
  - JITI helper 路径
  - QR 登录 helper
- 如果 `2.0.1` 的 shape 已变化，优先在适配层吸收差异，而不是把版本细节散落到菜单层。

## 建议结构

### `src/common-settings-store.ts`

当前平铺结构：

- `wechatNotificationsEnabled`
- `wechatQuestionNotifyEnabled`
- `wechatPermissionNotifyEnabled`
- `wechatSessionErrorNotifyEnabled`

建议收口为嵌套结构，例如：

```ts
type WechatMenuSettings = {
  primaryBinding?: {
    accountId: string
    userId?: string
    name?: string
    enabled?: boolean
    configured?: boolean
    boundAt?: number
  }
  notifications: {
    enabled: boolean
    question: boolean
    permission: boolean
    sessionError: boolean
  }
  future?: {
    accounts?: Array<{
      accountId: string
      userId?: string
      name?: string
      enabled?: boolean
      configured?: boolean
      boundAt?: number
    }>
  }
}
```

这里的重点不是一次性把 `future.accounts` 用起来，而是先把结构留出来，避免下一轮再打破用户配置格式。

### `src/common-settings-actions.ts`

- toggle action 继续保留；
- 但应改为操作微信配置对象里的 `notifications.*`；
- 新增明确的 `wechat-bind` / `wechat-rebind` / `wechat-unbind` action 语义。

### `src/ui/menu.ts`

- 顶层只出现一个“微信”入口；
- 进入子菜单后分三段：
  1. 当前绑定信息
  2. 绑定动作
  3. 通知开关

### `src/menu-runtime.ts`

- 需要支持真正的子菜单跳转，而不是只把微信项当 provider action 回传；
- `wechat-bind` 不应再直接退出。

### `src/providers/*menu-adapter.ts`

- 从“处理微信 toggle”转向“把微信子菜单挂到通用菜单体系”；
- provider adapter 不应承担微信绑定流程本身，只负责调度和持久化入口。

### `src/wechat/*`

- 新增或扩展一个“绑定信息适配层”，负责：
  - 从官方插件读取账号列表与账号详情
  - 产出菜单可展示字段
  - 吸收 `1.0.3` -> `2.0.1` 差异

## 绑定信息来源

菜单展示应优先来自这几层：

1. 本地 operator / token 绑定状态
2. 上游官方插件 `describeAccount()` / `resolveAccount()`
3. QR 登录结果中的账号元信息

展示合并规则：

- 优先展示“用户能理解”的字段；
- 同一字段若多个来源冲突，优先当前官方插件视角；
- 内部 transport 字段不进入菜单。

## 测试策略

至少需要新增或调整这些测试：

1. **微信子菜单层级测试**
   - 微信入口在通用菜单下，而不是顶层散列项。
2. **绑定流程测试**
   - 选择 `wechat-bind` 不再直接退出；
   - 成功后会写入绑定状态；
   - 失败时有明确错误。
3. **已绑定信息展示测试**
   - 成功绑定后能展示 `accountId/name/enabled/configured/userId/boundAt` 的合理子集；
   - 不展示 `baseUrl`。
4. **多账号结构测试**
   - 当前即使只绑定一个账号，也能落入新结构；
   - 未来 `accounts[]` 扩展不会破坏旧配置。
5. **2.0.1 兼容测试**
   - 至少锁定适配层不会把 `1.0.3` 假设写死在 UI 层。

## 完成判定

只有同时满足以下条件，这份 follow-up 设计对应的工作才算完成：

1. 微信能力出现在通用菜单下的真正子菜单里。
2. `wechat-bind` 进入真实绑定流程，而不是直接返回。
3. 绑定成功后可展示当前已绑定微信账号的核心信息。
4. 菜单不展示 `baseUrl` 这类内部字段。
5. 配置结构已为未来多微信账号绑定 / 推送留出空间。
6. 设计和实现都显式考虑 `@tencent-weixin/openclaw-weixin@2.0.1` 的跟进。
