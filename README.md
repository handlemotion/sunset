# Sunset

Browser-based development workspace. Run many coding agents in parallel git
worktrees from a web UI — no desktop app. Sessions run locally on your machine
(using your existing Devin/Codex subscriptions over ACP) or delegate to cloud
sandboxes.

## Quick start

```sh
pnpm install
pnpm build
pnpm --filter @sunset/cli exec sunset
```

`sunset` starts the local host daemon, serves the web UI on localhost, and opens
your browser. Local agent sessions need `devin auth login` and/or `codex login`.

## Layout

- `apps/web` — React + Vite browser UI
- `apps/engine` — cloud control plane (Cloudflare Worker + Durable Object +
  Upstash Box). Ported but dormant; not deployed.
- `packages/git` — worktree lifecycle (create/archive/inspect, mutation leases)
- `packages/acp` — Agent Client Protocol client; devin/codex engine adapters
- `packages/host` — sqlite-backed orchestration: projects, workspaces,
  sessions, runs, event persistence, recovery
- `packages/server` — localhost HTTP/WebSocket API + static UI host
- `packages/cli` — `sunset` command
- `packages/box`, `packages/publish` — cloud sandbox + GitHub publication
  (dormant)

## Docs

- [AGENTS.md](AGENTS.md) — repo commands and rules for agents/contributors
- [docs/architecture.md](docs/architecture.md) — local-first runtime map and
  the dormant cloud boundary
- [docs/protocol.md](docs/protocol.md) — the ACP surface and engine quirks
- [docs/workstreams/README.md](docs/workstreams/README.md) — workstream briefs

## Status

Early build. Local mode is the working product; cloud delegation is ported but
inert until the engine is commissioned.
