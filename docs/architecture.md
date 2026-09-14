# Architecture

Sunset is local-first: everything on the request path below runs on the
user's machine. The cloud path exists in code but is dormant.

## Request path

```
browser (apps/web)
  → HTTP + WebSocket on 127.0.0.1 (packages/server, boot token)
  → host orchestration (packages/host, sqlite state)
  → git worktrees (packages/git) + ACP engine child processes (packages/acp)
```

## Components

- **Web UI** — [apps/web](../apps/web): React + Vite SPA. Calls the local
  server through `src/api.ts`; run events stream over WebSocket.
- **Server** — [packages/server](../packages/server): `createSunsetServer`
  binds `127.0.0.1` on an ephemeral port. Every `/api/*` request and the WS
  upgrade require the boot token, via `Authorization: Bearer <token>` or a
  `?token=` query param. Non-API GETs serve the built SPA with an
  `index.html` fallback. The only WS route is `/api/runs/:runId/events`,
  which replays persisted events then tails live ones (`after` = last seen
  sequence). See [server.ts](../packages/server/src/server.ts).
- **Host** — [packages/host](../packages/host): `createHost` keeps all state
  in `<stateDir>/sunset.sqlite` (better-sqlite3): projects, workspaces,
  sessions, runs, `run_events`, workspace operations, and a model-capability
  cache. A host lease ([src/lease.ts](../packages/host/src/lease.ts)) allows
  one host per state dir. Runs queue per session, dispatch to an engine
  handle, and persist each streamed event with a sequence number.
- **Git** — [packages/git](../packages/git): creates and removes worktrees
  under the worktree root, archives workspaces, serializes repo mutations
  with leases, and reconciles database rows against on-disk worktrees.
- **ACP engines** — [packages/acp](../packages/acp): spawns `devin acp` or
  `codex-acp` as stdio JSON-RPC child processes inside the workspace
  worktree. See [protocol.md](protocol.md).
- **CLI** — [packages/cli](../packages/cli): `sunset serve`/`open` start the
  host + server and print the tokenized URL; `projects`, `workspaces`, and
  `capabilities` subcommands talk to the host directly. State defaults to
  `~/.local/share/sunset` (`SUNSET_STATE_DIR`, `--state-dir`,
  `--worktree-root`).

## Dormant cloud boundary

`Session.location` admits `"local"` or `"cloud"`
([domain types](../packages/domain/src/types.ts)), but the host rejects
`"cloud"` with `cloud_unavailable`
([create-host.ts](../packages/host/src/create-host.ts)). The cloud pieces are
ported but inactive — nothing on the local path calls them:

- [packages/box](../packages/box) — Upstash Box client: persistent/ephemeral
  boxes, exec, file read/write, GitHub repo bundles.
- [packages/publish](../packages/publish) — GitHub draft-PR publication and
  patch validation.
- [apps/engine](../apps/engine) — Cloudflare Worker control plane;
  `/healthz` answers 200 and all other routes return 501 `engine_dormant`.
  Activation gates are listed in
  [apps/engine/AGENTS.md](../apps/engine/AGENTS.md).
