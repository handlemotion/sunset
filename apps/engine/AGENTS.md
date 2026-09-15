# Sunset engine (dormant)

`apps/engine` is the future cloud execution boundary for Sunset. It is **dormant**:
every route returns 501 and nothing in the local host calls it.

Activation requires all of:

- An explicit `SUNSET_ENGINE_ENABLED=true` deployment decision.
- A reviewed transport for cloud ACP (direct stdio supervision inside Box vs.
  a Box-hosted HTTP/streaming bridge).
- Credential isolation: agent sandboxes get only what they need; provider
  subscription credentials are provisioned per engine, never shared with
  validation environments.
- Publication credentials stay outside agent sandboxes entirely.
- No incident-specific logic from Transitive's `apps/sunset` may be copied in
  without being re-scoped to generic workspace execution.

The Box commissioning proof sequence, sandbox requirements, and triage guide
live in [RUNBOOK.md](RUNBOOK.md). The persistent-box run lifecycle and the
locked-down `codex exec` task body live in `@sunset/box`
(`run.ts`, `codex.ts`).
