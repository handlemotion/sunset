# Workstream: Host event retention

Scope: `packages/host/**` only.
Do not touch `packages/acp`, `packages/domain`, `packages/server`, or
`apps/web` — other worktrees own those.

## Context

`run_events` grows forever: one row per event, and text deltas arrive per
token. Long-running workspaces will accumulate unbounded SQLite growth and
slow `attach` reads.

## Tasks

1. **Retention sweep.** Delete `run_events` rows for runs that finished
   (status `finished`/`error`/`cancelled`) more than 30 days ago. Run the
   sweep once on host startup, and also on a daily interval while the host is
   up. Retention window configurable via `SUNSET_EVENT_RETENTION_DAYS`.

2. **Per-run cap.** Stop persisting new events for a run once it has
   `SUNSET_MAX_EVENTS_PER_RUN` (default 10_000) rows. Instead of dropping
   silently, persist one final `{ type: "status", status: "events_truncated" }`
   marker row so consumers can tell. Runs continue unaffected — truncation
   only affects the event log.

3. Keep `runs.attach` semantics intact: `afterSequence` ordering and the
   live tail must still work for runs mid-flight.

## Acceptance

- Tests in `host.test.ts`: old finished-run events are pruned on startup;
  the cap writes the truncation marker and stops further inserts; attach
  still streams correctly for a live run.
- `pnpm check` green.
