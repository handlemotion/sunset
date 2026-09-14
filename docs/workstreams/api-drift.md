# Workstream: API contract drift tests

SEQUENCING: depends on `packages/api` (api-contract workstream) — run after
it merges.

Scope: `packages/api/**` tests only (may add `@sunset/server` as a
devDependency for fixture generation — do not edit server source).

## Context

`packages/api` defines the client contract; `packages/server` implements it.
Nothing yet proves they agree. This adds a round-trip contract test.

## Tasks

1. Boot a real `createSunsetServer` against a fake host (the host interface
   is injectable — build a minimal stub) on an ephemeral port.
2. Drive every route through the `packages/api` client; assert typed
   responses match server output for success AND error shapes
   (`{ error: { code, message } }`).
3. WS round-trip: `attachRun` receives events in order and `after` resume
   skips replayed events.
4. If the drift test finds mismatches between the client's assumed shapes
   and actual server responses, fix the CLIENT types (server is authority)
   and report each mismatch in the PR.

## Acceptance

- Contract test covers every route + one WS reconnect path.
- `pnpm check` green.
