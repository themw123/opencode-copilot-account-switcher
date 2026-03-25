# WeChat Stage A 证据目录说明

## 手测步骤
1. 执行 `npm run wechat:smoke:real-account -- --dry-run`，确认只输出准备信息与路径。
2. 在具备真实账号与环境变量时，人工执行真实手测并记录命令、时间、结果。
3. 收集日志、截图或文本证据后，先脱敏再归档。

## 产物路径
- `docs/superpowers/wechat-stage-a/evidence/README.md`
- `docs/superpowers/wechat-stage-a/api-samples-sanitized.md`
- `docs/superpowers/wechat-stage-a/go-no-go.md`

## 证据命名规则
- `001-bind-success.md`
- `002-nonslash-warning.png`
- `003-sendmessage-response.md`

## 每条证据最小元数据
- 时间
- 环境
- 输入
- 输出摘要

## 在 go-no-go.md 中的引用方式
- 使用证据 ID（如 `001-bind-success`）或相对路径引用
- 在 `go-no-go.md` 的“证据引用”章节逐条关联输入、观察结果与证据

## dry-run/blocked/known-unknown 记录
- 当前默认状态：`dry-run`
- 若缺少真实账号或环境变量：记录为 `blocked`，注明缺失项
- 若存在待确认风险：记录为 `known-unknown`，注明影响与后续验证计划
