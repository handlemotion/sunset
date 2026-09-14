# Sunset

Browser-based development workspace: run coding agents in parallel git
worktrees from a web UI. See [README.md](README.md) for the quick start.

## Layout

pnpm + turbo monorepo ([pnpm-workspace.yaml](pnpm-workspace.yaml),
[turbo.json](turbo.json)). Node >= 22.13, pnpm 11.

- `apps/web` (`@sunset/web`) — React + Vite browser UI
- `apps/engine` (`@sunset/engine`) — dormant Cloudflare Worker control plane;
  see [apps/engine/AGENTS.md](apps/engine/AGENTS.md)
- `packages/domain` (`@sunset/domain`) — shared types: events, sessions,
  models, execution policy
- `packages/git` (`@sunset/git`) — worktree lifecycle and mutation leases
- `packages/acp` (`@sunset/acp`) — Agent Client Protocol client; devin/codex
  engine adapters
- `packages/host` (`@sunset/host`) — sqlite-backed orchestration: projects,
  workspaces, sessions, runs, events
- `packages/server` (`@sunset/server`) — localhost HTTP/WebSocket API and
  static UI host
- `packages/cli` (`@sunset/cli`) — `sunset` command
- `packages/box`, `packages/publish` — dormant cloud sandbox + GitHub
  publication
- `packages/typescript-config` — shared tsconfig

## Commands

Root scripts fan out via turbo:

```sh
pnpm install
pnpm build          # turbo run build
pnpm dev            # turbo run dev
pnpm lint           # turbo run lint
pnpm test           # turbo run test
pnpm check-types    # turbo run check-types
pnpm format         # prettier --write
pnpm format:check   # prettier --check
pnpm check          # format:check + check-types + test + build
```

Per-package scripts: every code package has `build` and `check-types`
(`@sunset/typescript-config` ships only shared tsconfig files, no scripts);
packages with tests use `test` → `vitest run` (`--passWithNoTests` where no
tests exist yet). Examples:

```sh
pnpm --filter @sunset/acp test
pnpm --filter @sunset/git test
pnpm --filter @sunset/host test
pnpm --filter @sunset/server test
pnpm --filter @sunset/publish test
pnpm --filter @sunset/web build
```

## Rules

- No `any`, no `@ts-ignore`, no skipped tests.
- Worktree discipline: each workstream owns the paths its brief names; do not
  edit files owned by other workstreams or worktrees.
- No speculative claims in docs — document what the code does today.

## Docs

- [docs/architecture.md](docs/architecture.md) — local-first runtime map and
  the dormant cloud boundary
- [docs/protocol.md](docs/protocol.md) — the ACP surface and engine quirks
- [docs/workstreams/README.md](docs/workstreams/README.md) — index of
  workstream briefs
