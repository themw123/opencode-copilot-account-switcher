# OpenCode GitHub Copilot Account Switcher

[![npm version](https://img.shields.io/npm/v/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![npm downloads](https://img.shields.io/npm/dw/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)

[English](#english) | [中文](#中文)

---

<a name="english"></a>

## English

Manage and switch between multiple **GitHub Copilot** accounts in **OpenCode**. This plugin adds account switching, quota checks, a default-on **Guided Loop Safety** mode that can keep a single premium request productive for hours with fewer report interruptions before it truly needs user input, and an optional **Copilot Network Retry** switch for retryable network and certificate failures. It **uses the official `github-copilot` provider** and does **not** require model reconfiguration.

## What You Get

- **Multi-account support** — add multiple Copilot accounts and switch anytime
- **Quota check** — view remaining quota per account
- **Auth import** — import Copilot tokens from OpenCode auth storage
- **Guided Loop Safety** — enabled by default; a stricter Copilot-only question-first policy designed to keep non-blocked work moving, keep one premium request productive for hours, and cut avoidable quota burn by replacing repeated interruption turns with `question`-based waiting
- **Copilot Network Retry** — optional and off by default; normalizes retryable Copilot network or TLS failures so OpenCode's native retry path can handle them
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
- **Guided Loop Safety** — prompt-guided question-first reporting that requires `question` for user-facing reports when available, keeps non-blocked work moving, reduces repeated interruptions, and avoids unnecessary subagent calls
- **Copilot Network Retry** — off by default; only affects the Copilot request `fetch` path and only for retryable network/certificate-style failures
- **Switch account**
- **Remove account**
- **Remove all**

Guided Loop Safety is enabled by default. In practice, this can keep one request productive for hours: when `question` is available and permitted, user-facing reports must go through it, so waiting for your reply does not keep burning extra quota the way repeated direct-status interruptions do. Fewer interruptions also means less avoidable quota burn. If safe non-blocked work remains, Copilot should keep going instead of pausing early; only when no safe action remains should it use `question` to ask for the next task or clarification, while also reducing unnecessary subagent calls.

If you switch Copilot accounts and then hit transient TLS/network failures or `input[*].id too long` errors caused by stale session item IDs, enable Copilot Network Retry from the same menu. It is off by default. When enabled, the plugin keeps the official Copilot header/baseURL behavior from the upstream loader, only wraps the final Copilot `fetch` path, and converts retryable network-like failures into a shape that OpenCode already treats as retryable. It also repairs the matched session part after an `input[*].id too long` 400 so later retries can recover instead of repeatedly failing on stale item IDs.

## Copilot Network Retry

- Default: **disabled**
- Scope: only the official Copilot request `fetch` path returned by `auth.loader`
- Purpose: limited handling for retryable network and certificate-style failures such as `failed to fetch`, `ECONNRESET`, `unknown certificate`, or `self signed certificate`
- Strategy: preserve official loader behavior, then normalize retryable failures so OpenCode's native retry pipeline can decide whether and when to retry
- Risk: because the plugin still wraps the official fetch path, upstream internal behavior may change over time and drift is possible

## Upstream Sync

The repository includes a committed upstream snapshot at `src/upstream/copilot-plugin.snapshot.ts` plus a sync/check script at `scripts/sync-copilot-upstream.mjs`.

Useful commands:

```bash
npm run sync:copilot-snapshot -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
npm run check:copilot-sync -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
```

The script generates or checks the committed snapshot, requires upstream metadata for repository snapshot updates, and helps catch drift from the official `opencode` `copilot.ts` implementation.

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

**Does Copilot Network Retry replace OpenCode's retry logic?**
No. The plugin keeps retry policy inside OpenCode by normalizing retryable Copilot network/TLS failures into a shape that OpenCode already recognizes as retryable.

---

<a name="中文"></a>

## 中文

在 **OpenCode** 中管理并切换多个 **GitHub Copilot** 账号。本插件提供**账号切换、配额查询**、默认开启的 **Guided Loop Safety** 模式，以及默认关闭的 **Copilot Network Retry** 开关；前者帮助一次 premium request 更容易连续工作好几个小时、减少真正需要你输入之前的汇报打断，后者用于处理可重试的网络与证书类失败。**完全依赖官方 `github-copilot` provider**，无需修改模型配置。

## 功能一览

- **多账号管理** — 添加多个 Copilot 账号，随时切换
- **配额查询** — 查看每个账号的剩余额度
- **导入认证** — 可从 OpenCode 认证存储导入
- **Guided Loop Safety** — 默认开启；仅对 Copilot 生效的更严格 question-first 提示词策略，推动非阻塞工作持续执行、让一次 premium request 更容易连续工作好几个小时，并通过减少反复中断来降低无谓配额消耗
- **Copilot Network Retry** — 默认关闭；把可重试的 Copilot 网络或 TLS 失败归一化成 OpenCode 原生重试链路可识别的形态
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
- **Guided Loop Safety 开关** — 通过提示词引导模型在可用时必须使用 `question` 做用户可见汇报、继续完成非阻塞工作、减少反复中断，并避免不必要的子代理调用
- **Copilot Network Retry 开关** — 默认关闭；仅影响 Copilot 请求的 `fetch` 路径，只处理可重试的网络/证书类失败
- **切换账号**
- **删除账号**
- **全部删除**

Guided Loop Safety 现在默认开启。实际使用中，它可以让一次 request 更容易连续工作好几个小时：当 `question` 工具在当前会话中可用且被允许时，用户可见汇报必须通过它完成，因此等待你的回复本身不会像反复插入直接状态消息那样继续额外消耗配额；少一次中断，本身就少一次无谓的配额消耗。只要还有安全的非阻塞工作可做，Copilot 就应继续执行而不是提前暂停；只有在当前确实没有可安全执行的动作时，才应通过 `question` 询问下一项任务或所需澄清，同时也会减少不必要的子代理调用。

如果你在切换 Copilot 账号后遇到瞬时 TLS/网络失败，或者遇到由旧 session item ID 残留引起的 `input[*].id too long` 错误，也可以在同一菜单中开启 Copilot Network Retry。它默认关闭。开启后，插件会先保留 upstream 官方 loader 生成的 `baseURL`、认证头和 `fetch` 行为，只在最后一跳 Copilot `fetch` 路径上做最小包装，把可重试的网络类失败归一化成 OpenCode 已有重试链路能识别的形态；对于明确命中的 `input[*].id too long` 400，还会回写命中的 session part，避免旧 item ID 持续污染后续重试。

## Copilot Network Retry

- 默认：**关闭**
- 作用范围：仅影响 `auth.loader` 返回的官方 Copilot 请求 `fetch` 路径
- 用途：有限处理 `failed to fetch`、`ECONNRESET`、`unknown certificate`、`self signed certificate` 等可重试网络/证书类失败
- 实现策略：尽量保留官方 loader 行为，再把可重试失败归一化给 OpenCode 原生重试链路判断是否重试
- 风险提示：因为插件仍然包裹了官方 fetch 路径，若 upstream 后续内部实现变化，仍可能产生行为漂移

## Upstream 同步机制

仓库中提交了一份 upstream 快照 `src/upstream/copilot-plugin.snapshot.ts`，并提供同步/校验脚本 `scripts/sync-copilot-upstream.mjs`。

常用命令：

```bash
npm run sync:copilot-snapshot -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
npm run check:copilot-sync -- --source <file-or-url> --upstream-commit <sha> --sync-date <YYYY-MM-DD>
```

该脚本会生成或校验仓库中提交的 snapshot，并要求在更新正式 snapshot 时显式提供 upstream commit 与同步日期，用来尽早发现与官方 `opencode` `copilot.ts` 的行为漂移。

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

**Copilot Network Retry 会替代 OpenCode 自己的重试逻辑吗？**
不会。插件的目标是把可重试的 Copilot 网络/TLS 失败归一化成 OpenCode 已识别的可重试错误形态，真正的是否重试与如何退避仍由 OpenCode 原生链路决定。

---

## License

MPL-2.0 License. See [LICENSE](LICENSE) for details.
