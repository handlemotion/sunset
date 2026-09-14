# Sunset

Browser-based development workspace. Run many coding agents in parallel git
worktrees from a web UI — no desktop app. Sessions run locally on your machine
(using your existing Devin/Codex subscriptions over ACP) or delegate to cloud
sandboxes.

## Quick start

```sh
pnpm install
pnpm build
pnpm --filter @sunset/cli exec sunset open
```

`sunset open` starts the local host daemon, serves the web UI on localhost, and
opens your browser (`sunset serve` does the same without opening a browser).
Local agent sessions need `devin auth login` and/or `codex login`.

## CLI

```sh
sunset serve|open [--port N] [--state-dir DIR] [--worktree-root DIR]
                  [--web-dist DIR] [--engine devin|codex] [--model ID]
sunset doctor    # check engine binaries, model catalogs, and state dir
sunset projects add <repo-root> | list
sunset workspaces create <project-id> <slug> | list <project-id>
sunset capabilities
sunset --version | --help
```

`sunset doctor` verifies that both engines can be spawned (`devin` on PATH;
`codex-acp` on PATH, falling back to the pinned
`npx -y @agentclientprotocol/codex-acp@1.11.0`), fetches each model catalog,
and checks that the state directory is writable. It exits nonzero until both
engines resolve.

### Config file

`sunset` reads `~/.config/sunset/config.json` (override the path with
`SUNSET_CONFIG`). All keys are optional; unknown keys or invalid values warn
and cause the whole file to be ignored:

```json
{
  "port": 8080,
  "stateDir": "/path/to/state",
  "defaultEngine": "codex",
  "defaultModel": "codex:gpt-6-astra"
}
```

`port` sets the `serve`/`open` listen port, `stateDir` the state directory,
and `defaultEngine`/`defaultModel` fill in the engine and model for sessions
created without them. Values resolve file < environment < CLI flag.

### Environment variables

- `SUNSET_CONFIG` — config file path
- `SUNSET_STATE_DIR` — state root (state dir is `$SUNSET_STATE_DIR/state`;
  default `~/.local/share/sunset`)
- `SUNSET_PORT` — default `serve`/`open` port
- `SUNSET_DEFAULT_ENGINE` — `devin` or `codex`
- `SUNSET_DEFAULT_MODEL` — default model id
- `SUNSET_WEB_DIST` — web build directory (default bundled `apps/web/dist`)

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
