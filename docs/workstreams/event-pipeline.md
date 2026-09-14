# Workstream: Event pipeline performance

SEQUENCING: touches `packages/host` — run AFTER the host-retention
workstream merges; rebase first.

Scope: `packages/host/**` only.

## Context

Every ACP event becomes one `run_events` row; text deltas arrive per token —
a chatty run writes thousands of tiny rows and `attach` pollers re-read them.
Also every persisted event row carries unbounded `args`/`result` payloads.

## Tasks

1. **Delta coalescing.** Buffer consecutive `text_delta`/`thought_delta`
   events and flush as one row every ~50ms or 4KB, whichever first. Readers
   must see the same event order; coalescing is a persistence detail.
   Alternatively coalesce in the agent event queue before persistence — pick
   whichever layer already sees the full stream.

2. **Payload cap.** Truncate any persisted event payload field
   (`args`/`result`) past ~64KB; mark with `{ truncated: true }` so the UI
   can render "output truncated". Never silently drop data without a marker.

3. **SQLite pragmas.** Ensure `journal_mode = WAL`, `synchronous = NORMAL`,
   `busy_timeout` set — check `state.ts` and add if missing.

4. **Attach path.** If `runs.attach` polls SQLite in a loop, replace with an
   in-process event bus (host emits to subscribers; DB stays the source of
   truth for `afterSequence` replay). Keep behavior identical.

## Acceptance

- Tests: coalesced writes preserve order and survive restart replay; >64KB
  payloads truncated with marker; attach receives live events without
  polling (assert via subscription, not timing).
- `pnpm check` green.
