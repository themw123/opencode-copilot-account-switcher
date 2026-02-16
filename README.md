# opencode-copilot-account-switcher

[English](#english) | [中文](#中文)

---

<a name="english"></a>

## English

### Introduction
Local plugin to switch between multiple GitHub Copilot OAuth tokens in OpenCode. It allows you to manage multiple Copilot accounts and switch between them seamlessly.

### Features
- **Add account**: Provide a name and token values (OAuth token from device flow).
- **Import from auth.json**: Pulls GitHub Copilot tokens from OpenCode auth storage.
- **Check quotas**: Queries Copilot internal endpoints to show remaining quota per account.
- **Switch account**: Select an account → switch.
- **Remove account**: Remove selected entry.
- **Remove all**: Wipe all saved accounts.

### Installation

#### For Humans
Add the plugin to your OpenCode config. OpenCode will automatically download it from npm at startup.

`~/.config/opencode/opencode.json`
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-copilot-account-switcher"]
}
```

#### For LLM Agents
<details>
<summary>Click to expand agent instructions</summary>

**Goal:** Add the plugin to OpenCode so it auto-installs from npm (no local build, no file path).

**Steps:**
1. Open `~/.config/opencode/opencode.json`.
2. Ensure it includes:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-copilot-account-switcher"]
   }
   ```
3. Restart OpenCode (it will fetch the plugin automatically).

**Verification:**
Run:
```bash
opencode auth login github-copilot
```
and confirm the menu appears.
</details>

### Usage
Run in auth flow:
```bash
opencode auth login github-copilot
```
This opens an interactive TUI menu (arrow keys + enter).

### Storage
Accounts are stored in:
`~/.config/opencode/copilot-accounts.json`

### FAQ
- **Do I need to change model configurations?** No, this plugin works with the default GitHub Copilot provider.
- **Does it require the official github-copilot provider?** Yes, it relies on the official GitHub Copilot provider integration.

---

<a name="中文"></a>

## 中文

### 简介
用于在 OpenCode 中快速切换多个 GitHub Copilot 账号的本地插件。它允许您管理多个 Copilot 账号并无缝切换。

### 特性
- **添加账号**: 提供名称和 Token 值（来自设备流的 OAuth Token）。
- **从 auth.json 导入**: 从 OpenCode 认证存储中提取 GitHub Copilot Token。
- **检查配额**: 查询 Copilot 内部端点以显示每个账号的剩余配额。
- **切换账号**: 选择账号并切换。
- **删除账号**: 删除选定的条目。
- **全部删除**: 清空所有保存的账号。

### 安装

#### 针对人类用户
只需要在配置里加入插件名，OpenCode 会在启动时自动从 npm 下载，无需本地安装或指定路径。

`~/.config/opencode/opencode.json`
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-copilot-account-switcher"]
}
```

#### 针对 LLM 智能体 (LLM Agents)
<details>
<summary>展开智能体指令</summary>

**目标：** 让 OpenCode 自动从 npm 安装插件（无需本地构建/路径）。

**步骤：**
1. 打开 `~/.config/opencode/opencode.json`。
2. 写入/合并以下内容：
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-copilot-account-switcher"]
   }
   ```
3. 重启 OpenCode（会自动拉取插件）。

**验证：**
运行：
```bash
opencode auth login github-copilot
```
确认出现账号管理菜单。
</details>

### 使用
在认证流程中运行:
```bash
opencode auth login github-copilot
```
这将打开一个交互式 TUI 菜单。

### 存储位置
账号存储在:
`~/.config/opencode/copilot-accounts.json`

### 常见问题 (FAQ)
- **我需要修改模型配置吗？** 不需要，此插件使用默认的 Copilot Provider，无需额外配置模型。
- **它依赖官方 github-copilot provider 吗？** 是的，它完全依赖 OpenCode 的官方 GitHub Copilot Provider 实现。
