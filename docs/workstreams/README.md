# Workstream briefs

Scoped work assignments for parallel worktrees. Each brief names the paths it
owns — do not edit files outside that scope.

| Brief                                      | Scope                                               | Summary                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [acp-protocol.md](acp-protocol.md)         | `packages/acp`, `packages/domain/src/types.ts`      | ACP hardening: control-plane timeouts, map dropped update types, codex catalog cache TTL.                                               |
| [api-contract.md](api-contract.md)         | new `packages/api`                                  | Shared HTTP/WS contract and typed client extracted from `server.ts`/`apps/web/src/api.ts`.                                              |
| [cli-ergonomics.md](cli-ergonomics.md)     | `packages/cli`, `README.md`                         | `sunset doctor`, config file, `--version`/help polish.                                                                                  |
| [cloud-engine.md](cloud-engine.md)         | `packages/box`, `apps/engine`, new `packages/cloud` | Cloud engine worker plus an `Engine`-interface client; the host keeps rejecting `location: "cloud"`.                                    |
| [host-retention.md](host-retention.md)     | `packages/host`                                     | `run_events` retention sweep and per-run event cap.                                                                                     |
| [policy-mapping.md](policy-mapping.md)     | `packages/acp`, `packages/domain/src/types.ts`      | Map `ExecutionPolicy` onto codex modes/config options; transient prompt retries. Runs after the other `packages/acp` workstreams merge. |
| [repo-docs.md](repo-docs.md)               | `AGENTS.md`, `docs/**`, `README.md`                 | This documentation set.                                                                                                                 |
| [server-hardening.md](server-hardening.md) | `packages/server`                                   | WS origin check, 1 MB body cap, graceful shutdown, structured request log.                                                              |
| [testing-harness.md](testing-harness.md)   | `packages/testing`                                  | Shared fake ACP agent harness with failure knobs.                                                                                       |
