# Workstream: Server boundary hardening

Scope: `packages/server/**` only.
Do not touch `packages/acp`, `packages/host`, `packages/cli`, or `apps/web` —
other worktrees own those.

## Context

`server.ts` already binds `127.0.0.1` and requires the boot token on HTTP and
WS upgrade. This task closes the remaining gaps.

## Tasks

1. **Origin check on WS upgrade.** When an `Origin` header is present, reject
   unless its host is `localhost`/`127.0.0.1`/`[::1]` (any port — the Vite dev
   server proxies). Absent Origin (CLI/curl) stays allowed; the token still
   guards everything.

2. **Body size limit.** JSON request bodies are read with no cap. Reject with
   413 past 1 MB.

3. **Graceful shutdown.** `close()` should stop accepting connections, close
   open `WebSocket`s in the `sockets` set, and wait for in-flight handlers to
   drain (or abort them) so `sunset serve` exits cleanly on SIGINT/SIGTERM.

4. **Structured request log.** Dependency-free NDJSON log: env
   `SUNSET_LOG=<path>` (or `stateDir/server.log` when unset — keep it opt-in
   via env only if simpler). One line per entry:
   `{ ts, level, msg, method?, path?, status?, ms?, err? }` for requests,
   ws connect/disconnect, and handler errors. Never log token values or
   Authorization headers.

## Acceptance

- Tests in `server.test.ts`: 401 without token on WS upgrade, foreign Origin
   rejected, localhost Origin accepted, >1 MB body → 413, sockets close on
   server close.
- `pnpm check` green.
