# WeChat Question 与 Permission 交互表达设计

## 背景

当前仓库已经具备 WeChat 侧最小回复闭环：

- `/reply <qid> <text>` 可以命中 open question
- `/allow <pid> once|always|reject` 可以命中 open permission
- broker 能通过 `handle -> routeKey -> requestID` 做唯一反查

但这还不是原始设计意义上的“完整问题交互”。现在的主要不足是：

1. question 通知文案几乎只有 handle，没有题面、选项和回复格式说明。
2. `/reply` 只支持自由文本直传，不能表达单选/多选题的结构化答案。
3. permission 通知虽然可处理，但文案也不够清楚，用户看不出 `once|always|reject` 分别对应什么。

## 目标

1. 把 question 通知升级成“题面 + 题型 + 选项 + 回复格式”的结构化文案。
2. 把 permission 通知升级成“标题/类型 + 可选动作说明”的结构化文案。
3. 扩展 `/reply`，支持自由文本、单选、多选三类回答输入。
4. 在 broker 侧做题型感知的答案解析与校验，失败时给出稳定中文提示。
5. 保持 slash-only 主交互，不引入微信按钮、多步状态机或临时会话状态。

## 非目标

1. 不在这一轮实现 `/recover`、dead-letter 恢复或 replay。
2. 不在这一轮实现通知失败 fallback / toast 重新激活闭环。
3. 不引入微信按钮、菜单 wizard 或图形化表单交互。
4. 不修改 permission 的命令语法，仍保留 `once|always|reject`。

## 方案选择

### 方案 A：结构化 slash 协议

做法：

- 通知文案升级成结构化文本；
- `/reply` 扩展为题型感知的文本协议；
- broker 负责把 slash 文本转成 `question.reply()` 需要的结构化 `answers`。

优点：

- 最贴近原始设计的命令型交互。
- 不需要新增微信侧状态机。
- 实现复杂度明显低于按钮式或多步式交互。

缺点：

- 文本协议需要设计得足够清楚，否则用户仍会输错。

### 方案 B：多步对话式交互

做法：

- 用户先 `/reply q1` 拉题面；
- broker 记住“当前微信用户正在回答哪个问题”；
- 后续消息逐步完成选项选择和提交。

优点：

- 对用户更友好。

缺点：

- 需要引入新的微信侧会话状态机。
- 与原始设计的 slash-only 收缩方向相冲突。

### 方案 C：最小增强文案，维持自由文本回复

做法：

- 只增强 question/permission 通知文案；
- `/reply` 仍然只收一段自由文本。

优点：

- 改动最小。

缺点：

- 仍然无法真正支持单选/多选题。
- 只能把结构化问题继续伪装成自由文本。

### 结论

采用方案 A。question/permission 交互需要更完整，但必须继续保持 slash-only 边界。

## 设计细节

### 1. question 通知文案

question 通知不再只显示 handle，而至少包含：

1. handle
2. 问题正文 / 标题
3. 题型
4. 选项（若有）
5. 回复格式说明

示例：

```text
收到新的问题请求（q8）
问题：请选择发布环境
类型：单选
选项：
1. staging
2. production
回复：/reply q8 1
```

多选示例：

```text
收到新的问题请求（q9）
问题：请选择需要执行的检查项
类型：多选
选项：
1. lint
2. test
3. build
回复：/reply q9 1,2,3
```

自由文本示例：

```text
收到新的问题请求（q10）
问题：请输入发布说明
类型：文本
回复：/reply q10 这里填写说明
```

### 2. permission 通知文案

permission 通知也从“只有 handle”升级成带上下文的结构化文案，至少包含：

1. handle
2. 标题
3. 类型
4. 允许的回复动作说明

示例：

```text
收到新的权限请求（p3）
标题：允许执行 shell 命令
类型：command
回复：
/allow p3 once
/allow p3 always
/allow p3 reject 原因
```

### 3. `/reply` 语法扩展

保留当前最小自由文本语法，并增加题型感知解析：

1. 文本题

```text
/reply q1 这里是自由文本答案
```

2. 单选题

```text
/reply q1 2
```

3. 多选题

```text
/reply q1 1,3,4
```

约束：

1. 单选题只能给一个编号。
2. 多选题可以给多个编号，用英文逗号分隔。
3. 编号必须落在选项范围内。
4. 多选题重复编号会被去重，或直接视为非法输入；本轮建议直接拒绝并提示用户重发，避免静默修正带来歧义。
5. 文本题仍然把整段余下文本视为答案内容。

### 4. broker 侧答案转译

broker 不直接信任 slash 文本，而是根据 question 元数据决定如何转译：

1. 文本题
   - 继续转成 `answers: [[text]]`
2. 单选题
   - 根据编号定位选项
   - 转成该选项对应的 answer 结构
3. 多选题
   - 根据编号列表定位多个选项
   - 按题目声明顺序转成 answer 列表

这样微信用户看到的是简单命令，bridge 收到的是结构化答案。

### 5. 非法回复提示

非法输入不能继续下传给 bridge，而应直接回微信明确错误：

1. handle 不存在
   - `未找到待回复问题：q1`
2. 单选题给多个编号
   - `问题 q1 只能选择一个选项，请按提示重新回复。`
3. 多选题编号越界
   - `问题 q1 的选项编号无效，请按题面中的编号重新回复。`
4. 文本题给空值
   - `问题 q1 需要填写回复内容，请在 handle 后输入文本。`

错误提示目标是“告诉用户该怎么重新发”，而不是只说格式错误。

## 数据边界

为了做到上面的交互，bridge -> broker 的 question 数据不能只保留 `requestID/handle`，还需要保留最小题面元数据，例如：

```ts
type QuestionPromptSummary = {
  title?: string
  body?: string
  mode: "text" | "single" | "multiple"
  options?: Array<{
    index: number
    label: string
    value: string
  }>
}
```

这一层不要求完整复制 SDK 原始对象，但必须足够支持：

1. 格式化通知文案
2. 校验编号输入
3. 还原结构化 `answers`

### 6. 范围控制

这轮只做 question/permission 的交互表达，不顺手扩大到其他功能线：

1. 不做人工恢复
2. 不做 fallback toast
3. 不做 dead-letter 额外 reason 扩展
4. 不做微信按钮式交互

## 测试策略

至少覆盖：

1. question 通知文案包含题面、题型、选项和回复格式
2. permission 通知文案包含标题/类型和 `once|always|reject` 说明
3. `/reply` 文本题仍保持兼容
4. `/reply` 单选题可把编号转成结构化答案
5. `/reply` 多选题可把编号列表转成结构化答案
6. 单选给多个编号、多选越界、空答案等非法输入返回稳定中文提示
7. handle 仍然是并发问题的唯一歧义消解手段

## 成功判定

完成后应满足：

1. 微信用户能看懂 question/permission 到底在问什么、要怎么回。
2. question 不再只是“自由文本最小闭环”，而是支持文本/单选/多选三类交互表达。
3. permission 通知比当前更清楚，但命令语法仍保持简单稳定。
4. 整个交互仍保持 slash-only，不引入新的微信侧状态机。
