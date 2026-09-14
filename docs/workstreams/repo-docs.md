# Workstream: Repository docs

Scope: `AGENTS.md`, `docs/**` (new files), `README.md` only.
Do not touch any `packages/**` or `apps/**` source.

## Context

Agents working in this repo need a map: package boundaries, the ACP quirks
(devin per-process auth, codex set_model, process-group kill), and the
dormant cloud boundary. Today none of that is written down.

## Tasks

1. **`AGENTS.md`** at repo root: pnpm/turbo layout, commands
   (`pnpm check`, format, per-package tests), the golden rules (no
   `any`/`@ts-ignore`/skipped tests, worktree discipline), and pointers into
   `docs/`.
2. **`docs/architecture.md`**: the local-first diagram — browser → localhost
   server (boot token) → host → git worktrees + ACP engine processes; the
   dormant cloud boundary (`location: "cloud"`, `packages/box`,
   `apps/engine`); where each concern lives.
3. **`docs/protocol.md`**: the ACP surface we depend on — methods used
   (`initialize`, `authenticate`, `session/new|resume|load|prompt|cancel|
set_model|set_mode`), update types we map vs ignore, engine quirks
   (devin per-process auth, codex `slug[effort]` model ids, catalog probe).
4. **`docs/workstreams/README.md`**: index of workstream briefs.

Keep it short and factual — write what the code does, link files, no
roadmaps.

## Acceptance

- `pnpm format:check` passes on new markdown.
- No source changes.
