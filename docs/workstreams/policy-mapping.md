# Workstream: Execution-policy → engine mapping

SEQUENCING: this touches `packages/acp/src/runtime.ts` and
`packages/acp/src/map.ts`, which two other worktrees (engine lifecycle
manager, acp-protocol) also edit. Run AFTER those merge; rebase first.

Scope: `packages/acp/**` and `packages/domain/src/types.ts` only.

## Context

`ExecutionPolicy` (`autoReview`, `sandbox`, `agentRetries`, `toolAllowlist`,
`toolDenylist`) is enforced today only inside the permission callback.
The codex adapter exposes richer controls we ignore:

- modes `read-only` / `agent` / `agent-full-access`,
- `session/set_config_option` (check the adapter's
  `config_option_update`/`configOptions` payload for available options),
- `session/new` `_meta` extensions.

## Tasks

1. Map `executionPolicy.sandbox`/autoReview onto the engine's mode surface:
   codex `read-only` ↔ strict, `agent` ↔ default, `agent-full-access` ↔
   unsandboxed. Decide the mapping, document it in the file.
2. For codex, inspect `configOptions` from `session/new` and apply relevant
   policy fields via `session/set_config_option`; skip options the adapter
   doesn't advertise.
3. `agentRetries`: retry a failed `session/prompt` (status error, not
   cancelled) up to N times on the same session when the error is transient
   (agent process still alive).
4. Keep `toolAllowlist`/`toolDenylist` enforcement in the permission handler;
   add tests that denylisted tools never reach the agent's allowed path.

## Acceptance

- Vitest coverage: policy → mode mapping, config-option application,
  retry-on-transient, denylist.
- `pnpm check` green.
