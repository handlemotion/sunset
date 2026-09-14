# Workstream: ACP protocol hardening

Scope: `packages/acp/**` and `packages/domain/src/types.ts` only.
Do not touch `packages/host`, `packages/server`, or `apps/web` — other worktrees own those.

## Goal

Make the ACP client resilient and capture event data we currently drop.

## Tasks

1. **Control-plane timeouts.** `conn.request(...)` calls in `runtime.ts`
   (`initialize`, `authenticate`, `session/new`, `session/resume`,
   `session/load`, `session/set_model`, `session/set_mode`) can hang forever
   on a wedged agent. Wrap them in a timeout (default 30s, overridable via
   `SUNSET_ACP_TIMEOUT_MS`). `session/prompt` stays unbounded — cancellation
   is the escape hatch there. A timed-out request must also close the
   connection so the session isn't left half-initialized.

2. **Capture dropped events.** `map.ts` currently returns `[]` for several
   update types. Map them into new `AgentEvent` variants in
   `packages/domain/src/types.ts`:
   - `usage_update` → `{ type: "usage"; used: number; size: number }` — and
     also read `usage`/`_meta.quota` off the `session/prompt` response in
     `runtime.ts` and emit a final usage event before `queue.finish()`.
   - `session_info_update` → `{ type: "session_title"; title: string }` when
     `params.title` (or `_meta.title`) is present; ignore otherwise.
   - `available_commands_update` → `{ type: "commands"; commands: Array<{ name: string; description?: string }> }`.
     Extend `asAgentEvent` in `map.ts` so persisted events round-trip.
     Keep ignoring `config_option_update`, `compaction_*`, `plan_update`,
     `plan_removed`, `user_message_chunk`.

3. **Catalog cache TTL.** `codexCatalogCache` in `catalog.ts` never expires.
   Cache for 1 hour, then re-probe. Expose an internal `resetCatalogCache()`
   (or accept an injectable clock) so tests can force a re-probe without
   spawning a real adapter.

## Notes

- The codex adapter (`@agentclientprotocol/codex-acp@1.11.0`) returns models
  as `slug[effort]` in `session/new`'s `models.availableModels`, modes
  `read-only`/`agent`/`agent-full-access`, and supports `session/set_model`,
  `session/close`, `session/fork`, `session/list`.
- `devin acp` requires `authenticate` per process before `session/new`
  (already handled in `openSession`).

## Acceptance

- `pnpm --filter @sunset/acp test` green with new tests for: request timeout
  closes the session, the three new event mappings + `asAgentEvent`
  round-trip, catalog TTL expiry.
- `pnpm check` green repo-wide.
