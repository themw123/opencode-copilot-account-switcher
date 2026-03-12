# OpenCode GitHub Copilot Account Switcher

[![npm version](https://img.shields.io/npm/v/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![npm downloads](https://img.shields.io/npm/dw/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)

[English](#english) | [中文](#中文)

---

<a name="english"></a>

## English

Manage and switch between multiple **GitHub Copilot** accounts in **OpenCode**. This plugin adds account switching, quota checks, and an optional **Guided Loop Safety** mode that can help Copilot keep a single premium request working longer with fewer report interruptions before it truly needs user input. It **uses the official `github-copilot` provider** and does **not** require model reconfiguration.

## What You Get

- **Multi-account support** — add multiple Copilot accounts and switch anytime
- **Quota check** — view remaining quota per account
- **Auth import** — import Copilot tokens from OpenCode auth storage
- **Guided Loop Safety** — a stricter Copilot-only question-first policy designed to keep non-blocked work moving, require `question` for user-facing reports when available, and help cut avoidable quota burn caused by repeated status interruptions
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
- **Guided Loop Safety** — prompt-guided question-first reporting that requires `question` for user-facing reports when available, keeps non-blocked work moving, and avoids unnecessary subagent calls
- **Switch account**
- **Remove account**
- **Remove all**

If you want GitHub Copilot sessions to stay in a single premium request longer, enable Guided Loop Safety from the account menu. It is a prompt-guided, Copilot-only question-first mode: when `question` is available and permitted, user-facing reports must go through it; if safe non-blocked work remains, Copilot should keep going instead of pausing early; only when no safe action remains should it use `question` to ask for the next task or clarification, while also reducing unnecessary subagent calls.

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

在 **OpenCode** 中管理并切换多个 **GitHub Copilot** 账号。本插件提供**账号切换、配额查询**以及可选的 **Guided Loop Safety** 模式，帮助 Copilot 在一次 premium request 里更持续地工作，并尽量减少真正需要你输入之前的汇报打断。**完全依赖官方 `github-copilot` provider**，无需修改模型配置。

## 功能一览

- **多账号管理** — 添加多个 Copilot 账号，随时切换
- **配额查询** — 查看每个账号的剩余额度
- **导入认证** — 可从 OpenCode 认证存储导入
- **Guided Loop Safety** — 仅对 Copilot 生效的更严格 question-first 提示词策略，推动非阻塞工作持续执行、在可用时要求用户可见汇报走 `question`，并帮助降低因反复中断带来的无谓配额消耗
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
- **Guided Loop Safety 开关** — 通过提示词引导模型在可用时必须使用 `question` 做用户可见汇报、继续完成非阻塞工作，并避免不必要的子代理调用
- **切换账号**
- **删除账号**
- **全部删除**

如果你希望 GitHub Copilot 会话在一次 premium request 中尽量持续工作、更少被汇报打断，可以在账号菜单中开启 Guided Loop Safety。它是仅对 Copilot 生效的 prompt 引导式 question-first 模式：当 `question` 工具在当前会话中可用且被允许时，用户可见汇报必须通过它完成；只要还有安全的非阻塞工作可做，Copilot 就应继续执行而不是提前暂停；只有在当前确实没有可安全执行的动作时，才应通过 `question` 询问下一项任务或所需澄清，同时也会减少不必要的子代理调用。

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
