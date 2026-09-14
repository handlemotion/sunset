# Workstream: Cloud engine seam

Scope: `packages/box/**`, `apps/engine/**`, and a NEW `packages/cloud/**`.
Do not touch `packages/host`, `packages/acp`, `packages/server`,
`packages/domain`, `packages/cli`, or `apps/web` — other worktrees own those.
The host already rejects `location: "cloud"`; this task builds the engine
side and a client that satisfies the `Engine` interface, but does NOT wire it
into the host (a follow-up flips that switch once merged).

## Context

Sunset is local-first with a dormant cloud boundary. `packages/box` has the
Upstash Box client ported from Transitive's sunset worker. `apps/engine` is a
scaffolded Cloudflare Worker. The ACP SDK (`@agentclientprotocol/sdk@1.4.0`)
ships an experimental websocket client — check its exports for a
`WebSocketConnector`/`wsConnector` before writing a custom bridge.

## Tasks

1. **`apps/engine` worker.** A Worker (or Box-side supervisor — pick per the
   Transitive pattern in `apps/sunset` of the Transitive repo if accessible)
   that:
   - accepts an ACP session request over HTTPS/WS,
   - boots an Upstash Box, spawns the requested engine (`devin acp` or
     `codex-acp`) inside it,
   - bridges stdio JSON-RPC frames over the WebSocket back to the caller,
   - cleans up the box on close/idle timeout.
     Auth: a shared `SUNSET_ENGINE_TOKEN` bearer for now.

2. **`packages/cloud` client.** `createCloudEngine(options): Engine`
   implementing the `Engine` interface from `@sunset/acp` (`create`, `resume`,
   `listModels`, `supportedModes`) by connecting to the engine worker's WS
   endpoint. Same `EngineSessionHandle`/`EngineRun` contract so the host can
   adopt it without changes. Reconnect semantics: a dropped WS during a run
   yields a `status: "error"` run result, not a hang.

3. **Contract test.** `packages/cloud` test with a fake in-process ACP agent
   behind the WS bridge proving create→prompt→stream→wait→dispose parity
   with the stdio engine. No real Upstash calls in tests — inject the box
   client.

## Acceptance

- `pnpm check` green; cloud tests pass without network.
- `location: "cloud"` remains rejected by the host — this task adds the
  capability, not the switch.
- `apps/engine` compiles; `wrangler.jsonc` unchanged in shape.
