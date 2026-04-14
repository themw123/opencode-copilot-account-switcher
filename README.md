# OpenCode GitHub Copilot Account Switcher

[![npm version](https://img.shields.io/npm/v/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![npm downloads](https://img.shields.io/npm/dw/opencode-copilot-account-switcher.svg)](https://www.npmjs.com/package/opencode-copilot-account-switcher)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)

Manage and switch between multiple **GitHub Copilot** accounts in **OpenCode**. The plugin builds on the official `github-copilot` provider to add account management, quota visibility, and a few Copilot workflow enhancements, with **no model reconfiguration required**.

Default behavior and optional switches:

- **Guided Loop Safety** — enabled by default; helps a single premium request stay productive longer with fewer report interruptions before it truly needs user input
- **Copilot Network Retry** — optional and off by default; handles retryable network or certificate-style failures
- **Synthetic Agent Initiator** — optional and off by default; experimental switch that diverges from stable upstream behavior, sends or overrides `x-initiator=agent`, does not guarantee non-billable treatment, and carries abuse or unexpected-billing risk
- **Copilot Status Slash Command** — enabled by default; experimental `/copilot-status` workaround with TUI-first support and no cross-client UX guarantee
- **Copilot Inject Slash Command** — enabled by default; no-arg `/copilot-inject` force-intervention switch that injects a marker into the next non-`question` tool output and drives immediate `question`
- **Wait Tool** — enabled by default; provides `wait` (minimum 30s) and returns `started/waited/now`

## What You Get

- **Multi-account support** — add multiple Copilot accounts and switch anytime
- **Quota check** — view remaining quota per account
- **Auth import** — import Copilot tokens from OpenCode auth storage
- **Guided Loop Safety** — enabled by default; a Copilot-only dual-channel policy (`question` for strong interaction, `notify` for pure progress) that keeps non-blocked work moving and reduces avoidable interruptions
- **Copilot Network Retry** — optional and off by default; normalizes retryable Copilot network or TLS failures so OpenCode's native retry path can handle them
- **Synthetic Agent Initiator** — optional and off by default; experimental switch that diverges from stable upstream behavior, sends or overrides `x-initiator=agent`, and carries billing/abuse risk
- **`/copilot-status`** — enabled by default; experimental slash command that shows a loading toast first and then a quota result or error toast
- **`/copilot-inject`** — enabled by default; no-arg force-intervention command that appends a marker to the next non-`question` tool output to force immediate `question`
- **`wait` tool** — enabled by default; minimum wait is 30 seconds and response contains start/wait/current timestamps
- **Zero model config** — no model changes required (official provider only)

---

## Installation

<details open>
<summary><b>For Humans</b></summary>

**Option A: Let an LLM do it**

Paste this into any LLM agent (OpenCode, Claude Code, Cursor, etc.):

```
First read the latest GitHub Release for opencode-copilot-account-switcher and execute the exact versioned install/upgrade command from its "Upgrade" section. Do not manually edit the OpenCode config, and do not use a bare package name or latest. Reference: https://raw.githubusercontent.com/jiwangyihao/opencode-copilot-account-switcher/master/README.md
```

**Option B: Manual setup**

1. **Read the latest GitHub Release** and look for the `## Upgrade` section.

2. **Run the exact versioned command** from that section. For the current version, the command is:

   ```bash
   opencode plugin opencode-copilot-account-switcher@0.14.39 --force
   ```

3. **If an upgrade still looks stale**, clear the OpenCode plugin cache and rerun the same versioned command:

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

4. **If OpenCode is already running, restart it before verification**.

5. **Login** to GitHub Copilot:

   ```bash
   opencode auth login --provider github-copilot
   ```

</details>

<details>
<summary><b>For LLM Agents</b></summary>

### Step-by-Step Instructions

1. Read the **latest GitHub Release body** for this repository and extract the exact versioned command from `## Upgrade`.

2. Execute that command directly. For the current version, the command is:

   ```bash
   opencode plugin opencode-copilot-account-switcher@0.14.39 --force
   ```

3. Do not install or upgrade this plugin by hand-editing the OpenCode config, and do not use a bare package name or `latest`.

4. If the installed version still does not change, clear the OpenCode plugin cache and rerun the same versioned command:

   ```bash
   rm -rf ~/.cache/opencode/packages/opencode-copilot-account-switcher@*
   ```

5. If OpenCode is already running, restart it before verification.

### Verification

```bash
opencode auth login --provider github-copilot
```

> **Note**: Current OpenCode does not reliably refresh cached npm plugins automatically. Prefer the exact versioned command from the latest GitHub Release.

</details>

---

## Usage

Run inside the GitHub Copilot auth flow:

```bash
opencode auth login --provider github-copilot
```

You will see an interactive menu. Use the built-in language switch action if you want to swap between Chinese and English labels.

- **Add account**
- **Import from auth.json**
- **Check quota**
- **Guided Loop Safety toggle** — enforces dual-channel interaction: strong-interaction content must use `question`, while pure progress prefers `notify` and stays silent if `notify` is unavailable
- **Copilot Network Retry toggle** — off by default; only affects the Copilot `fetch` path for retryable network/certificate failures
- **Synthetic Agent Initiator toggle** — off by default; experimental switch that sends or overrides `x-initiator=agent`, diverges from stable upstream behavior, and does not guarantee non-billable treatment
- **`/copilot-status`** — enabled by default; experimental slash command workaround that shows a loading toast first and then a quota result or error toast
- **`/copilot-inject`** — enabled by default; no-arg force-intervention command that injects a marker into the next non-`question` tool output and requires immediate `question`
- **Switch account**
- **Delete account**
- **Delete all**

Guided Loop Safety is enabled by default. In practice, this can keep one request productive for hours: when `question` is available and permitted, all strong-interaction content (decisions, missing required input, explicit waiting states, final handoff, and no-safe-work-left states) must use it. Pure progress updates and phase changes should use `notify`; if `notify` is unavailable, pure progress stays silent and work continues instead of being escalated into interrupting questions. If routing is uncertain, default to `question`. The policy also constrains user-visible interaction channels to `question/notify`, avoiding ordinary plain-text assistant interruptions.

## Experimental `/copilot-inject`

- Default: **enabled**
- Trigger: type `/copilot-inject` in chat (**no arguments**)
- Behavior: it first shows a toast saying it will require immediate question on the model's next tool call; then on the next real output from any non-`question` tool, it appends the marker below and shows another toast saying question is now required:

```text
[COPILOT_INJECT_V1_BEGIN]
立即调用 question 工具并等待用户指示；在收到用户新指示前，不要继续执行后续任务。
[COPILOT_INJECT_V1_END]
```

- Clear condition: armed inject state is auto-cleared as soon as `question` executes
- Scope: instance memory only; not persisted to store and not shared across plugin instances

## `wait` Tool

- Default: **enabled**
- Usage: `wait({ seconds })`; `seconds` is optional and clamped to minimum 30
- Output shape: `started: <ISO>; waited: <N>s; now: <ISO>`

If you switch Copilot accounts and then hit transient TLS/network failures or `input[*].id too long` errors caused by stale session item IDs, enable Copilot Network Retry from the same menu. It is off by default. When enabled, the plugin keeps the official Copilot header/baseURL behavior from the upstream loader, only wraps the final Copilot `fetch` path, and converts retryable network-like failures into a shape that OpenCode already treats as retryable. It also repairs the matched session part after an `input[*].id too long` 400 so later retries can recover instead of repeatedly failing on stale item IDs.

You can also enable Synthetic Agent Initiator from the same menu. It is off by default. From a user perspective, it changes the request marker by sending or overriding `x-initiator=agent` so requests follow an early version of upstream's still-in-development synthetic initiator semantics instead of the current stable upstream behavior; it does not change who makes the final billing decision, and it does not guarantee the platform will treat those requests as non-billable.

## Experimental `/copilot-status`

- Default: **enabled**
- Nature: **experimental / workaround**, not a stable public plugin command API
- Support scope: **TUI-first**; Web/App behavior is explicitly not guaranteed to match
- Trigger: enter `/copilot-status` in a normal chat session
- Expected feedback: first a `Fetching Copilot quota...` toast, then a success or error toast

To disable this experimental feature, edit `~/.config/opencode/copilot-accounts.json` and add or set:

```json
{
  "experimentalStatusSlashCommandEnabled": false
}
```

After disabling it:

- OpenCode config injection no longer includes `/copilot-status`
- Even manual `/copilot-status` input will no longer enter the plugin workaround execution chain

## Copilot Network Retry

- Default: **disabled**
- Scope: only the official Copilot request `fetch` path returned by `auth.loader`
- Purpose: limited handling for retryable network and certificate-style failures such as `failed to fetch`, `ECONNRESET`, `unknown certificate`, or `self signed certificate`
- Strategy: preserve official loader behavior, then normalize retryable failures so OpenCode's native retry pipeline can decide whether and when to retry
- Risk: because the plugin still wraps the official fetch path, upstream internal behavior may change over time and drift is possible

## Synthetic Agent Initiator

- Default: **disabled**
- Effect: sends or overrides `x-initiator=agent` to enable upstream's in-progress synthetic initiator semantics early
- Relation to stable upstream: when enabled, request behavior intentionally differs from the current stable upstream code path; this is an early-adoption path based on upstream work in progress, not the stable upstream default
- Billing note: compressed continue-working flows and other automatically generated synthetic prompt messages may be more likely to fall outside premium request billing, but that is not guaranteed; the platform decides whether and how billing applies, so do not treat this as "guaranteed non-billable"
- Risk: this behavior may be more likely to be treated as abuse, may stop working as upstream/platform behavior changes, and may also lead to unexpected billing
- Upstream references:
  - Issue: https://github.com/anomalyco/opencode/issues/8700
  - PR: https://github.com/anomalyco/opencode/pull/8721
  - Issue: https://github.com/anomalyco/opencode/issues/8766
  - Commit: https://github.com/anomalyco/opencode/commit/88226f30610d6038a431796a8ae5917199d49c74

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

## License

MPL-2.0 License. See [LICENSE](LICENSE) for details.
