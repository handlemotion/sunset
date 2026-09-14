# ACP surface

Sunset talks to coding agents over the Agent Client Protocol via
`@agentclientprotocol/sdk` 1.4.0: newline-delimited JSON-RPC over the child
process's stdio. Transport and process handling live in
[packages/acp/src/client.ts](../packages/acp/src/client.ts); session logic in
[runtime.ts](../packages/acp/src/runtime.ts).

## Methods used

| Method              | Use                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`        | First request on every connection; advertises `fs` and `terminal` client capabilities as false.                                                                                  |
| `authenticate`      | Sent when `session/new`, `session/resume`, or `session/load` fails with an auth error. Uses the first advertised `authMethods` id; an API key goes in `_meta.api_key`.           |
| `session/new`       | Create a session (`cwd` = worktree path, `mcpServers: []`).                                                                                                                      |
| `session/resume`    | Reattach to a provider session; requires `loadSession` or `sessionCapabilities.resume` in the `initialize` result.                                                               |
| `session/load`      | Fallback when `session/resume` fails (including after a successful re-auth).                                                                                                     |
| `session/prompt`    | One turn; resolves with `stopReason` (`cancelled` maps to a cancelled run).                                                                                                      |
| `session/cancel`    | Notification; cancels the in-flight prompt.                                                                                                                                      |
| `session/set_model` | Applies the model after `session/new`/`resume`/`load` for engines marked `modelViaSetModel` (codex). A `-32601`/unknown-method reply is ignored — the spawn-time default stands. |
| `session/set_mode`  | Best-effort mode selection (see Plan mode below); failures are ignored.                                                                                                          |

Inbound traffic: `session/update` notifications feed the event mapper, and
`session/request_permission` requests are answered by the session's
execution policy — denylisted tools and tools outside a configured allowlist
are cancelled; otherwise the first `allow_always` option is selected, then
`allow_once`, then any `reject*` option, then `cancelled`.

## Update mapping

`mapSessionUpdate` in [map.ts](../packages/acp/src/map.ts) converts ACP
`session/update` payloads into `AgentEvent`s
([domain types](../packages/domain/src/types.ts)). `asAgentEvent` validates
persisted events when they are read back.

Mapped:

- `agent_message_chunk` → `text_delta` (text content only)
- `agent_thought_chunk` → `thought_delta`
- `tool_call` → `tool_call`, plus `tool_result` when the call already carries
  a terminal status (`completed`/`failed`)
- `tool_call_update` → `tool_result` on `completed`/`failed`; a `status`
  event (`tool_pending`/`tool_in_progress`) otherwise
- `plan` → `plan`
- `current_mode_update` → `mode`

Ignored (map to no events): `user_message_chunk`,
`available_commands_update`, `config_option_update`, `session_info_update`,
`usage_update`, `compaction_update`, `compaction_summary_chunk`,
`plan_update`, `plan_removed`, and any unknown update type.

## Engine quirks

Definitions live in [engines.ts](../packages/acp/src/engines.ts); catalog
behavior in [catalog.ts](../packages/acp/src/catalog.ts).

- **Devin per-process auth.** `devin acp` keeps credentials per process, so
  `session/new` (and `session/resume`/`session/load`) can fail with an auth
  error on a fresh connection. The runtime calls `authenticate` once on that
  connection and retries the session call.
- **Codex model ids.** `codex-acp` takes no spawn args (`modelViaSetModel`);
  models are applied via `session/set_model` using `slug[effort]` ids, e.g.
  `gpt-6-astra[medium]`. Sunset-side codex model ids are namespaced
  `codex:<slug>`; the prefix is stripped before reaching the adapter.
- **Codex spawn resolution.** `codex-acp` on PATH wins; otherwise the pinned
  `npx -y @agentclientprotocol/codex-acp@1.11.0` fallback runs. The decision
  is cached per engine.
- **Catalog probe/fallback.** Devin's catalog comes from
  `devin models list --format json`. Codex has no catalog command: the
  runtime spawns the adapter in a temp dir, runs `initialize` +
  `session/new`, and parses `models.availableModels` (`slug[effort]` entries
  grouped by slug); any failure falls back to `DEFAULT_CODEX_CATALOG`. The
  host caches catalogs in sqlite and reports each engine's catalog as
  `live`, `cached`, or `unavailable`.
- **Plan mode.** `mode: "plan"` maps to the first advertised mode id among
  `plan`, `read-only`, `read_only` via `session/set_mode`. Codex advertises
  `agent`/`plan` support; devin is `agent`-only.
- **Process groups.** Engine children spawn `detached` on non-Windows so
  `kill()` signals the whole process group with `SIGKILL` — engines like
  `devin acp` spawn MCP-server children that would otherwise outlive the
  agent process. stderr is drained continuously (8 KB tail retained) and the
  last line is attached to the `agent_process_exited` connection error.
