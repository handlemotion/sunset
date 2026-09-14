# Workstream: Dev bootstrap

Scope: root `package.json`, `apps/web/vite.config.ts`, `packages/cli` README
section or `README.md` dev docs only. Rebase after cli-ergonomics and
repo-docs land (README overlap).

## Context

Running Sunset today means `sunset serve` for the API plus a separate Vite
dev server for hot reload. One command should do both.

## Tasks

1. Root `pnpm dev`: runs `packages/cli`'s serve and `apps/web`'s Vite dev
   server together (use `concurrently` or a tiny node script — prefer no new
   dep if a script works).
2. Vite dev proxy: `/api` → `http://127.0.0.1:<port>` and WS upgrade for
   `/api/runs/*/events`. The dev server needs the boot token — read it from
   the server. Cleanest: `sunset serve` prints/writes the token; the vite
   proxy injects it as `?token=` for WS and `Authorization` for HTTP via a
   small vite plugin or env handoff (`SUNSET_TOKEN`). Document the flow.
3. `sunset open` should keep working against the production-served UI
   unchanged.

## Acceptance

- `pnpm dev` starts both; browser UI connects, lists projects, streams
  events through the proxy.
- No changes to server/host source.
