# Workstream: Error taxonomy consolidation

SEQUENCING: touches domain + host + server + acp — run LAST, after all other
workstreams merge; rebase first.

Scope: `packages/domain/src/errors.ts` (new), plus surgical edits to
`packages/host/src/errors.ts`, `packages/server/src/server.ts`,
`packages/acp/src/runtime.ts` — only where they define/throw/map errors.

## Context

Errors are strings everywhere: `HostError` codes, `agent_process_exited:*`,
`session_resume_failed:*`, engine spawn failures. The UI can't distinguish
"auth needed" from "engine crashed" from "model rejected". Consolidate into
a stable taxonomy.

## Tasks

1. `packages/domain/src/errors.ts`: `SunsetError` with a `code` enum —
   `engine_spawn_failed`, `engine_auth_required`, `engine_process_exited`,
   `session_resume_failed`, `model_unavailable`, `run_timeout`, plus the
   existing host codes. Keep `isSunsetBoundaryError` working.
2. Make acp runtime throw `SunsetError`s instead of ad-hoc strings; host and
   server map them (server already emits `{error:{code,message}}` — reuse).
3. Attach the engine's stderr tail (already buffered in `client.ts`) to
   `engine_process_exited` errors so crashes are diagnosable from the API.
4. Host persists the error code on failed runs (`runs.error` already stores
   a message — add `code` if the schema allows without migration pain;
   otherwise encode as `code:message`).

## Acceptance

- A failed engine spawn surfaces `engine_spawn_failed` through the HTTP API.
- Tests: error code propagation engine → host → server response.
- `pnpm check` green.
