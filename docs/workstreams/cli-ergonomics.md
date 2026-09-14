# Workstream: CLI ergonomics

Scope: `packages/cli/**` and `README.md` only.
Do not touch `packages/acp`, `packages/host`, `packages/server`, or
`apps/web` — other worktrees own those. `listModels`/`resolveEngineSpawn`
from `@sunset/acp` and `createHost` from `@sunset/host` are read-only
dependencies; do not modify their sources.

## Tasks

1. **`sunset doctor`.** Prints a per-engine health table:
   - binary resolution (`devin` on PATH; `codex-acp` on PATH else the pinned
     `npx @agentclientprotocol/codex-acp@1.11.0` fallback via
     `resolveEngineSpawn`)
   - catalog fetch (`listModels("devin")`, `listModels("codex")`) with model
     count and default model, or the error
   - state dir writability, version info
     Exit 0 when both engines resolve, 1 otherwise.

2. **Config file.** `~/.config/sunset/config.json` (override via
   `SUNSET_CONFIG`): `{ "port"?: number, "stateDir"?: string, "defaultEngine"?: "devin" | "codex", "defaultModel"?: string }`.
   `sunset serve`/`open` read it; CLI flags and `SUNSET_STATE_DIR` env still
   win over file values. Missing/invalid file must not crash — warn and use
   defaults. Reject unknown keys.

3. **Polish.** `sunset --version` (from package.json), clearer `sunset help`
   output listing every subcommand and flag.

4. Update `README.md`'s CLI section with `doctor`, config file path, and env
   vars.

## Acceptance

- `node packages/cli/dist/main.js doctor` works on this machine (both
  engines resolve).
- Vitest coverage for config parsing (missing file, invalid JSON, unknown
  key, precedence file < env < flag).
- `pnpm check` green.
