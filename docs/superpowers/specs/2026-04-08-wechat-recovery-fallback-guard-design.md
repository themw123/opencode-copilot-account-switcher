# WeChat 恢复闭环、人工恢复与通知守卫整包设计

## 背景

当前仓库已经补齐了 broker 生命周期、恢复观测、dead-letter 独立轨迹，以及 question/permission 的结构化交互表达。按原始 `2026-03-23-wechat-broker-bridge-design.md` 继续对照，剩余更大的功能差距主要集中在三块：

1. 通知发送失败后的用户可感知闭环还没有完全固化；
2. dead-letter 已存在，但没有真正消费它的人工恢复入口；
3. 重复通知合并与 non-slash 拒绝仍然没有完全产品化。

这三块本质上属于同一条“恢复与交互边界”主线：当通知失败、请求失效或用户走到微信入口边界时，系统要给出可理解、可恢复、且不刷屏的行为。

## 目标

1. 把通知发送失败闭环做成真实 end-to-end 功能。
2. 基于现有 dead-letter 轨迹提供一个最小可用的人工恢复入口。
3. 把 broker 通知去抖/合并和 slash-only 守卫做成稳定产品语义。
4. 用一个总 spec 统一这 3 条功能线，但实现上仍按阶段独立验证。

## 非目标

1. 不引入微信按钮式交互、wizard 或多步表单状态机。
2. 不支持多操作者模型。
3. 不把人工恢复扩成“无限制 replay 所有历史请求”。
4. 不在这轮里扩展所有可能的 dead-letter reason 和恢复策略。

## 方案选择

### 方案 A：一个总 spec，三阶段顺序落地

做法：

1. 先做通知失败闭环；
2. 再做人工恢复入口；
3. 最后做通知合并与 slash-only 守卫产品化。

优点：

- 符合用户要求的“整包完成”；
- 每个阶段又有清晰交付点，不会变成一个不可验证的大 diff；
- 三阶段共享同一套状态模型，不会分裂成三套实现。

缺点：

- spec 体量会比普通单线功能更大。

### 方案 B：拆成三个完全独立 spec

做法：

- 通知失败闭环、人工恢复、通知合并与守卫各写一份独立 spec。

优点：

- 范围最清楚。

缺点：

- 不符合这次“坚持整包”的明确要求；
- 会把共享状态模型拆散，增加跨文档跳转成本。

### 方案 C：先做底层状态，再统一把入口补出来

做法：

- 先加厚 token / dead-letter / notification queue 状态；
- 之后再把 toast、恢复命令、通知合并和守卫统一接起来。

优点：

- 底层先稳定。

缺点：

- 用户可感知价值被推迟；
- 容易变成“状态很完整，但主链行为还没串起来”的半成品。

### 结论

采用方案 A：一个总 spec，下分 3 个阶段顺序落地。

## 总体架构

这份设计覆盖 3 个连续阶段，但它们共享同一套核心状态，而不是各自实现一套：

1. `token-store` 继续作为上下文 token 真相源，补清晰的 stale reason 和发送失败分类。
2. `dead-letter-store` 继续作为独立排障/恢复轨迹，人工恢复只消费其中明确可恢复的记录。
3. broker 仍是所有微信交互的统一入口：
   - 负责通知发送
   - 负责失败回退
   - 负责恢复入口路由
   - 负责通知去抖/合并与 non-slash 拒绝

也就是说，三阶段共享的是：

- token stale 状态
- dead-letter 记录
- request route / handle route
- notification dedupe window

## 阶段 1：通知失败闭环

### 目标

当 broker 发送微信通知失败时，必须形成完整用户闭环：

1. 将当前 `(wechatAccountId, userId)` 对应 token 标记为 `stale`
2. 记录稳定诊断事件
3. 向对应 bridge 发送 `showFallbackToast`
4. fallback 文案固定提示：

```text
微信会话可能已失效，请在微信发送 /status 重新激活
```

### 设计

1. 不新增第二套 token 系统，只扩展现有 `token-store` 的 stale reason 使用方式。
2. broker 在通知发送失败时只做三件事：
   - `markTokenStale(...)`
   - `appendDiagnostic(...)`
   - 向 bridge 发 `showFallbackToast`
3. toast 只承担本地用户提醒，不承载恢复动作本身。
4. `/status` 已是现有微信主入口，因此重新激活仍然只通过 `/status` 完成，不在这阶段发明新命令。

### 成功判定

测试必须能证明：

1. 一次发送失败后 token 被标 stale；
2. bridge 收到 `showFallbackToast`；
3. toast 文案为固定 `/status` 重新激活提示；
4. 下一次微信入站 `/status` 能刷新 token 并恢复正常通知路径。

## 阶段 2：人工恢复入口

### 目标

基于现有 dead-letter 轨迹提供一个最小可用的人恢复入口，让用户能显式尝试恢复“明确可恢复”的记录，而不是只能依赖排障文件存在。

### 设计

1. 恢复入口仍然保持 slash-only。
2. 恢复只消费 dead-letter 中被标记为可恢复的记录，不对所有历史请求开放。
3. 恢复动作不直接“复活一切原始状态”，而是执行受控 replay：
   - 恢复前先校验 dead-letter 记录仍合法
   - 生成新的恢复 handle 或恢复路由
   - 成功/失败都写回稳定终态
4. 这阶段允许新增最小恢复命令，例如 `/recover <handle>` 或等价 broker 命令，但不扩成菜单 wizard。

### 成功判定

测试必须能证明：

1. 用户能通过明确命令命中一个 dead-letter 记录；
2. 明确不可恢复的记录会返回稳定中文提示；
3. 恢复成功和恢复失败都会写回稳定状态或诊断；
4. 恢复动作不会污染 active request 的正常路由。

## 阶段 3：通知合并与 slash-only 守卫产品化

### 目标

把原始设计里的两条策略做成稳定功能：

1. 短时间重复通知由 broker 去抖/合并，避免刷屏；
2. non-slash 消息被稳定拒绝，并保留 compat host 的 slash-only 边界。

### 设计

1. 通知合并只发生在 broker 发出通知之前，不改变 question/permission/sessionError 的原始语义。
2. 去抖窗口只针对短时间重复事件，合并策略偏保守：
   - 相同实例、相同通知种类、相近时间窗口内可被合并
   - 不跨 question handle / permission handle 合并
3. non-slash 守卫统一导向稳定文案：

```text
PoC 当前仅支持命令型交互，请使用 slash 命令（/status、/reply、/allow）
```

4. 该守卫必须和 compat host smoke 路径保持一致，避免“测试里能拒绝，真实路径却越界进入 AI reply”。

### 成功判定

测试必须能证明：

1. 重复通知不会短时间刷屏；
2. 关键通知仍能被发送，不会被误吞；
3. non-slash 消息会被稳定拒绝；
4. compat host 的 slash-only 边界仍然成立。

## 共享状态与边界规则

为了避免三阶段互相污染，这一轮必须遵守以下边界：

1. `token-store` 只管 token 状态，不直接决定恢复策略。
2. `dead-letter-store` 只管恢复轨迹与保留窗口，不直接接管 active request 真相源。
3. broker 负责路由、通知、恢复命令和守卫，但不在微信侧引入会话状态机。
4. 所有用户入口仍然保持 slash-only。

## 测试策略

这份总 spec 虽然整包，但实现计划必须按阶段验证：

1. 阶段 1：发送失败闭环专项测试 + 相关回归
2. 阶段 2：恢复入口专项测试 + dead-letter 回归
3. 阶段 3：通知合并与 non-slash 守卫专项测试 + smoke/real-host 边界回归
4. 最后再跑全量 `npm test`

## 成功判定

这份整包设计完成后，应满足：

1. 通知失败后，用户可以收到明确的本地 fallback 提示，并知道用 `/status` 重新激活；
2. dead-letter 不再只是排障轨迹，而有一个最小可用的恢复入口；
3. broker 对重复通知和 non-slash 越界路径有稳定、可测试的产品化行为；
4. 这一切仍然保持原始设计要求的 slash-only 交互模型，而没有引入新的微信侧状态机。
