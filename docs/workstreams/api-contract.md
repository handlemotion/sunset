# Workstream: Shared API contract

Scope: a NEW `packages/api/**` only. Add it to `pnpm-workspace.yaml` and
`turbo.json` is already generic — check root `package.json`/`turbo.json`
patterns match a new package automatically before editing them.
Do not touch `packages/server`, `packages/acp`, `packages/host`,
`packages/cli`, or `apps/web` — other worktrees own those; adoption into
web/cli is a later task.

## Context

`apps/web/src/api.ts` and `packages/server/src/server.ts` define the same
HTTP/WS contract in two places — they'll drift. Extract the contract into a
shared package: route table, request/response types, and a typed client.

## Tasks

1. **`packages/api` package** exporting:
   - request/response types for every current route (projects, workspaces,
     sessions, runs, diagnostics) — mirror `server.ts` exactly,
   - a `createClient({ baseUrl, token })` typed fetch client returning
     domain types from `@sunset/domain`,
   - the WS event-stream helper: `attachRun(runId, { after })` as an
     AsyncIterable with reconnect/resume semantics (`after` = last seen
     sequence).
2. No runtime deps beyond `@sunset/domain` (+ zod only if needed — prefer
   type-level contracts since the server is the authority).
3. Tests: client parses server-shaped fixtures correctly; WS helper
   resumes from `after` on reconnect (fake WebSocket).

## Acceptance

- `pnpm check` green; package builds standalone.
- A follow-up will swap `apps/web/src/api.ts` and any cli HTTP calls onto it.
