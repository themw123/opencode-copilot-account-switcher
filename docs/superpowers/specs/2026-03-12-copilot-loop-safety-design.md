# Copilot Loop Safety Design

## Goal

Add a user-toggleable Loop Safety mode to the existing `opencode-copilot-account-switcher` plugin so GitHub Copilot sessions bias toward tool-loop-safe behavior:

- prefer the `question` tool for user-facing reports when that tool is available and allowed
- avoid unnecessary `task` / subagent delegation because it consumes extra quota
- fall back to direct assistant text when `question` is unavailable or unsuitable

This behavior must apply only to `github-copilot` and `github-copilot-enterprise` sessions, and the toggle must live inside the existing Copilot account menu.

## Non-Goals

- Do not modify OpenCode core.
- Do not modify the `superpowers` plugin.
- Do not override provider system prompts via `agent.prompt`.
- Do not affect non-Copilot providers.
- Do not make `question` mandatory without fallback.

## Constraints And Evidence

- OpenCode appends plugin-provided system text after provider and instruction prompts through `experimental.chat.system.transform` in `packages/opencode/src/session/llm.ts`.
- `question` blocks and waits for a user reply, so the injected rule must preserve fallback behavior for non-interactive or denied sessions.
- The published `@opencode-ai/plugin` type definitions do not currently declare `experimental.chat.system.transform`, so the implementation must add a local augmented hook type instead of relying on upstream typings.
- The existing plugin already owns the Copilot auth menu and the persistent store at `~/.config/opencode/copilot-accounts.json`, so the feature should reuse those entry points instead of creating a separate control surface.

## Recommended Approach

Keep a single runtime plugin export, but split the new behavior into a dedicated module.

Why this approach:

- it avoids uncertain multi-export plugin loading behavior
- it keeps auth/menu code separate from prompt-policy logic
- it integrates naturally with the existing Copilot account menu and store

## User-Facing Behavior

### Menu

The existing `GitHub Copilot accounts` menu gains a new action:

- `Enable loop safety` when the feature is off
- `Disable loop safety` when the feature is on

The action appears with the other utility actions and includes a short hint such as `Copilot only` or `question-first reports`.

Toggling it immediately updates the persistent store. No extra confirmation is needed.

### Session Behavior

When Loop Safety is enabled and the session provider is `github-copilot` or `github-copilot-enterprise`, the plugin appends one extra system block containing a compact policy:

- when the `question` tool is available and permitted, user-facing reports about status, findings, conclusions, completion, or next steps should go through `question`
- when `question` is unavailable, denied, or unsuitable for the current interaction mode, direct assistant text is allowed as a fallback
- `task` / subagent delegation is expensive and should be avoided unless it materially improves the result
- if subagents are used, keep the count minimal and briefly explain why

When Loop Safety is disabled, or when the provider is not a Copilot provider, no extra system text is injected.

## Architecture

### `src/loop-safety-plugin.ts`

Add a new module dedicated to Loop Safety behavior. Responsibilities:

- define the injected policy text
- expose a provider guard such as `isCopilotProvider(providerID)`
- expose a system-transform hook factory that reads the persisted setting and conditionally appends the policy
- define a local augmented hook type for `experimental.chat.system.transform`

This module should not depend on auth flow or menu rendering.

### `src/store.ts`

Extend `StoreFile` with a new top-level field:

```ts
loopSafetyEnabled?: boolean
```

Compatibility rules:

- missing field means `false`
- older store files keep working without migration
- writes persist the new flag alongside existing account and refresh settings

### `src/ui/menu.ts`

Extend `MenuAction` with:

```ts
{ type: "toggle-loop-safety" }
```

Extend `showMenu()` inputs so the menu can render current Loop Safety state. The label should invert based on current state.

### `src/plugin.ts`

Keep `CopilotAccountSwitcher` as the single plugin export, but merge two responsibilities in the returned hook object:

- existing `auth` provider behavior
- new `experimental.chat.system.transform` behavior imported from `src/loop-safety-plugin.ts`

`runMenu()` handles `toggle-loop-safety` by flipping `store.loopSafetyEnabled`, writing the store, and returning to the menu loop.

### `src/index.ts`

Keep the current single export unless implementation needs helper re-exports. No second plugin export is required.

## Hook Typing Strategy

Because the current plugin package types do not declare `experimental.chat.system.transform`, define a local extended type similar to:

```ts
type ExperimentalChatSystemTransformHook = (
  input: { sessionID: string; model: { providerID: string } },
  output: { system: string[] },
) => Promise<void>

type CopilotPluginHooks = Hooks & {
  "experimental.chat.system.transform"?: ExperimentalChatSystemTransformHook
}
```

This preserves strict typing without using `any`, and allows the plugin to return an object with the experimental hook while staying assignable to upstream `Hooks`.

## Data Flow

### Toggle Flow

1. User opens `opencode auth login github-copilot`
2. Plugin reads `copilot-accounts.json`
3. Menu shows current Loop Safety state
4. User selects toggle action
5. Plugin flips `store.loopSafetyEnabled`
6. Plugin persists the updated store
7. Menu redraws with the new state

### Prompt Injection Flow

1. OpenCode assembles provider + instruction system prompts
2. Plugin receives `experimental.chat.system.transform`
3. Plugin checks `model.providerID`
4. Plugin reads Loop Safety state from store
5. If provider is Copilot and feature is enabled, append the policy text to `output.system`
6. Otherwise do nothing

## Error Handling

- If the store file does not exist, default to `{ accounts: {} }` with Loop Safety off.
- If reading the store fails during prompt injection, fail open by skipping policy injection instead of breaking the chat request.
- If the menu cannot persist the setting, surface the existing file write failure rather than silently pretending success.
- The injected policy itself must explicitly allow direct-text fallback so the agent does not deadlock in denied or non-interactive sessions.

## Testing Plan

### Build And Type Safety

- `npm run build`
- verify the local augmented hook type compiles cleanly

### Behavior Tests

1. Loop Safety off + Copilot session
   - no extra policy should be injected
2. Loop Safety on + Copilot session
   - agent should show stronger bias toward `question` for user-facing reports
3. Loop Safety on + non-Copilot session
   - no policy should be injected
4. Fallback case
   - in a session where `question` is unavailable or denied, agent should still respond with direct text rather than hanging
5. Subagent thrift
   - simple tasks should prefer direct tools over dispatching subagents
6. Persistence
   - toggled state survives restarting OpenCode

## Open Questions Resolved

- Scope: Copilot-only
- Control surface: existing account menu
- Default state: disabled by default

## Implementation Notes

- Keep the injected policy compact. It should bias behavior, not duplicate `superpowers`.
- Avoid adding more than one new persisted field unless implementation uncovers a concrete need.
- Prefer one new module plus focused changes to existing files over a broad refactor.
