# Workstream: Fake ACP agent test harness

Scope: a NEW `packages/testing/**` only.
Do not touch `packages/acp`, `packages/host`, `packages/server`,
`packages/domain`, `packages/cli`, or `apps/web` — other worktrees own those.
`packages/acp/src/runtime.test.ts` already contains an in-process fake agent
— read it for the shape, but leave that file untouched.

## Context

Every engine-level test currently rebuilds a fake ACP agent inline. A shared
harness makes future work cheaper and lets us simulate failure modes real
engines have shown: per-process auth requirements, stderr flooding, hangs,
method-not-found, mid-run disconnects.

## Tasks

1. **`packages/testing`** exporting `fakeAcpAgent(options)` — an in-process
   ACP agent usable via `createEngine(ENGINES.x, { connector })` injection:
   - serves `initialize` (configurable `authMethods`, `agentCapabilities`),
   - `authenticate` (configurable to fail N times or require specific
     methodId),
   - `session/new` returning configurable `models`, `modes`,
   - `session/resume`/`session/load` (configurable success/failure),
   - `session/set_model`, `session/set_mode` recording calls for assertions,
   - `session/prompt` emitting a scripted update sequence (text/thought
     deltas, tool calls, plan, usage_update, session_info_update,
     available_commands_update) then a configurable stopReason or error,
   - `session/cancel` honoring cancels,
   - failure knobs: `hangOn` (never respond to a method), `exitAfter`
     (kill the agent mid-run).
2. Self-tests proving the harness works with `@sunset/acp`'s runtime.

## Acceptance

- `pnpm check` green; harness covered by its own tests.
