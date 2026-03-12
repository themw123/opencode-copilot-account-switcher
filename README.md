# OpenCode GitHub Copilot Account Switcher

[![npm version](https://img.shields.io/npm/v/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![npm downloads](https://img.shields.io/npm/dw/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)

[English](#english) | [中文](#中文)

---

<a name="english"></a>

## English

Manage and switch between multiple **GitHub Copilot** accounts in **OpenCode**. This plugin adds account switching, quota checks, and an optional **Guided Loop Safety** mode — it **uses the official `github-copilot` provider** and does **not** require model reconfiguration.

## What You Get

- **Multi-account support** — add multiple Copilot accounts and switch anytime
- **Quota check** — view remaining quota per account
- **Auth import** — import Copilot tokens from OpenCode auth storage
- **Guided Loop Safety** — inject a stricter question-first Copilot policy with fewer report interruptions and fewer unnecessary subagent calls
- **Zero model config** — no model changes required (official provider only)

---

## Installation

<details open>
<summary><b>For Humans</b></summary>

**Option A: Let an LLM do it**

Paste this into any LLM agent (OpenCode, Claude Code, Cursor, etc.):

```
Install the opencode-copilot-account-switcher plugin by following: https://raw.githubusercontent.com/jiwangyihao/opencode-copilot-account-switcher/master/README.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-copilot-account-switcher"]
   }
   ```

2. **Restart OpenCode** (it will auto-download the plugin from npm).

3. **Login** to GitHub Copilot:

   ```bash
   opencode auth login --provider github-copilot
   ```

</details>

<details>
<summary><b>For LLM Agents</b></summary>

### Step-by-Step Instructions

1. Edit the OpenCode configuration file at `~/.config/opencode/opencode.json`

   > **Note**: This path works on all platforms. On Windows, `~` resolves to your user home directory (e.g., `C:\Users\YourName`).

2. Add the plugin to the `plugin` array:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-copilot-account-switcher"]
   }
   ```

3. Restart OpenCode so it fetches the plugin automatically from npm.

### Verification

```bash
opencode auth login --provider github-copilot
```

</details>

---

## Usage

Run inside the GitHub Copilot auth flow:

```bash
opencode auth login --provider github-copilot
```

You will see an interactive menu (arrow keys + enter) with actions:

- **Add account**
- **Import from auth.json**
- **Check quotas**
- **Guided Loop Safety** — prompt-guided question-first reporting that requires `question` for user-facing reports when available, reduces report interruptions, and avoids unnecessary subagent calls
- **Switch account**
- **Remove account**
- **Remove all**

If you want stricter question-first reporting and fewer unnecessary subagent calls in GitHub Copilot sessions, enable Guided Loop Safety from the account menu.

---

## Storage

Accounts are stored in:

```
~/.config/opencode/copilot-accounts.json
```

---

## FAQ

**Do I need to change model configurations?**
No. This plugin only manages accounts and works with the official `github-copilot` provider.

**Does it replace the official provider?**
No. It uses the official provider and only adds account switching + quota checks.

---

<a name="中文"></a>

## 中文

在 **OpenCode** 中管理并切换多个 **GitHub Copilot** 账号。本插件提供**账号切换、配额查询**以及可选的 **Guided Loop Safety** 模式，**完全依赖官方 `github-copilot` provider**，无需修改模型配置。

## 功能一览

- **多账号管理** — 添加多个 Copilot 账号，随时切换
- **配额查询** — 查看每个账号的剩余额度
- **导入认证** — 可从 OpenCode 认证存储导入
- **Guided Loop Safety** — 为 Copilot 注入更严格的 question-first 提示词规则，减少汇报打断，并避免不必要的子代理调用
- **无需模型配置** — 使用官方 provider，无需改模型

---

## 安装

<details open>
<summary><b>面向人类用户</b></summary>

**选项 A：让 LLM 帮你安装**

把下面这段话丢给任意 LLM（OpenCode / Claude Code / Cursor 等）：

```
请按以下说明安装 opencode-copilot-account-switcher 插件：https://raw.githubusercontent.com/jiwangyihao/opencode-copilot-account-switcher/master/README.md
```

**选项 B：手动安装**

1. **在配置文件中添加插件** `~/.config/opencode/opencode.json`：

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-copilot-account-switcher"]
   }
   ```

2. **重启 OpenCode**（会自动从 npm 下载插件）。

3. **登录 GitHub Copilot**：

   ```bash
   opencode auth login --provider github-copilot
   ```

</details>

<details>
<summary><b>面向 LLM 智能体</b></summary>

### 步骤指引

1. 打开 OpenCode 配置文件 `~/.config/opencode/opencode.json`

   > **说明**：该路径在所有平台通用；Windows 上 `~` 会解析为用户目录（例如 `C:\Users\YourName`）。

2. 在 `plugin` 数组中添加插件：

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-copilot-account-switcher"]
   }
   ```

3. 重启 OpenCode，使其自动拉取 npm 包。

### 验证

```bash
opencode auth login --provider github-copilot
```

</details>

---

## 使用方式

在 Copilot 认证流程中运行：

```bash
opencode auth login --provider github-copilot
```

会出现交互式菜单（方向键 + 回车）：

- **添加账号**
- **从 auth.json 导入**
- **检查配额**
- **Guided Loop Safety 开关** — 通过提示词引导模型在可用时必须使用 `question` 做用户可见汇报、减少汇报打断，并避免不必要的子代理调用
- **切换账号**
- **删除账号**
- **全部删除**

如果你希望 GitHub Copilot 会话更严格地优先使用 `question` 工具汇报、减少汇报打断，并避免不必要的子代理调用，可以在账号菜单中开启 Guided Loop Safety。

---

## 存储位置

账号信息保存于：

```
~/.config/opencode/copilot-accounts.json
```

---

## 常见问题

**需要改模型配置吗？**
不需要。本插件只做账号管理，继续使用官方 `github-copilot` provider。

**会替换官方 provider 吗？**
不会。它只是在官方 provider 基础上增加账号切换和配额查询。

---

## License

MPL-2.0 License. See [LICENSE](LICENSE) for details.
