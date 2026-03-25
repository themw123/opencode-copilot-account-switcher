# WeChat Stage A API 脱敏样本

## 脱敏规则
- `context_token` -> `[REDACTED_CONTEXT_TOKEN]`
- `bot_token` -> `[REDACTED_BOT_TOKEN]`
- `Authorization: Bearer ...` -> `[REDACTED_AUTHORIZATION]`
- `userId` -> `[REDACTED_USER_ID]`
- `botId` -> `[REDACTED_BOT_ID]`
- `qrCode` -> `[REDACTED_QR_CODE]`
- `deviceId` -> `[REDACTED_DEVICE_ID]`
- `messageId` -> `[REDACTED_MESSAGE_ID]`
- `requestId` -> `[REDACTED_REQUEST_ID]`

## 登录相关真实响应结构
- 当前状态：`known-unknown`（尚未执行真实账号手测）
- 稳定字段：`bot_token`、`userId`、`botId`
- 可变字段：二维码内容、设备标识、登录时间
- 脱敏方式：统一替换为占位符，真实值不入库

## getupdates 真实响应结构
- 当前状态：`known-unknown`
- 稳定字段：`msgs`、`get_updates_buf`、`context_token`
- 可变字段：消息数量、消息时间戳、轮询批次号
- 脱敏方式：`context_token` 与用户标识统一替换

## 命令消息入站结构
- 当前状态：`dry-run only`
- 稳定字段：slash 命令名、命令参数、用户标识占位字段
- 可变字段：消息文本原文、时间、会话上下文
- 脱敏方式：消息原文按需要保留命令词，其余敏感值替换

## 非 slash 告警回发成功响应
- 当前状态：`dry-run only`
- 稳定字段：固定告警文案、发送成功标识
- 可变字段：messageId、送达时间、微信上下文标识
- 脱敏方式：发送链路中的 token、messageId、用户标识替换后归档

## 失败响应结构（若可稳定复现）
- 当前状态：`known-unknown`
- 稳定字段：错误码、错误消息类别
- 可变字段：请求 ID、时间、上下文标识
- 脱敏方式：错误响应中的 token、用户标识、设备信息替换后记录

## 示例（脱敏后）
```text
context_token=[REDACTED_CONTEXT_TOKEN]
bot_token=[REDACTED_BOT_TOKEN]
Authorization: Bearer [REDACTED_AUTHORIZATION]
userId=[REDACTED_USER_ID]
botId=[REDACTED_BOT_ID]
qrCode=[REDACTED_QR_CODE]
deviceId=[REDACTED_DEVICE_ID]
```

## 当前状态
- 状态：dry-run 已就绪。
- 真实账号手测：待执行；缺少真实样本时统一记录为 `blocked` 或 `known-unknown`。

## 最近一次 real-account non-dry-run 运行
- 最近运行路径：`real-account-blocked`
- 最近运行状态：`blocked`

## slash 采样更新（run-qr-wait-timeout-default）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-fSvp47/run-qr-wait-timeout-default`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-slash-sanitize-outbound）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-6abPBz/run-slash-sanitize-outbound`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-nonslash-throw-final-evidence）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-BqOXoF/run-nonslash-throw-final-evidence`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-nonslash-not-implemented）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-lljlED/run-nonslash-not-implemented`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-nonslash-count-fail）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-LNSEkI/run-nonslash-count-fail`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-qr-wait-timeout-default）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-AaLTJh/run-qr-wait-timeout-default`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-slash-evidence-files）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-T1XNLK/run-slash-evidence-files`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-slash-sanitize-outbound）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-X7ZvaA/run-slash-sanitize-outbound`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-nonslash-throw-final-evidence）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-xMy8bP/run-nonslash-throw-final-evidence`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-nonslash-not-implemented）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-fUVH2J/run-nonslash-not-implemented`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（run-nonslash-count-fail）
- 证据目录：`../../../../../../../../../AppData/Local/Temp/guided-smoke-test-VqIAYk/run-nonslash-count-fail`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（2026-03-23T20-25-56-458Z）
- 证据目录：`evidence/2026-03-23T20-25-56-458Z`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（2026-03-24T06-11-50-906Z）
- 证据目录：`evidence/2026-03-24T06-11-50-906Z`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）

## slash 采样更新（2026-03-24T06-17-11-386Z）
- 证据目录：`evidence/2026-03-24T06-17-11-386Z`
- 命令样本：`/status`、`/reply smoke`、`/allow once`
- 引用文件：`004-status-command.json`、`005-reply-command.json`、`006-allow-command.json`
- outbound：`none`（无真实出站）
