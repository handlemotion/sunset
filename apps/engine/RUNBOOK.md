# Engine operations

`apps/engine` is Sunset's cloud execution boundary. Interactive sessions use
one ephemeral Box per accepted WebSocket (`/v1/session`); `packages/box` also
carries a persistent-box run supervisor (`launchRun`/`inspectRun`/
`terminateRun`/`findRun`) for non-interactive work. Both stay disabled until
every commissioning gate below is current and reviewed — a configured
credential alone is not activation.

## Box commissioning

Use a dedicated Box per environment with `keepAlive` disabled. Install
exactly the pinned CLI versions under `/workspace/home/node_modules`; Sunset
puts that `.bin` first when checking and launching (`CODEX_BIN_DIR`,
`assertCodexVersion`), so the image's bundled CLI cannot be selected
silently. For engines that need a login, authenticate inside the Box with the
provider's own flow (for Codex, `codex login --device-auth`); never copy a
developer credential cache or configure API keys.

The Box image must provide GNU `timeout`, `setsid`, `flock`, Git, pnpm, and
Bubblewrap (`bwrap`). Validation (`packages/publish` `validatePatch`) runs
check commands under bwrap with read-only mounts for the base git state and
tooling: `.git`, every tracked file outside src/test dirs, and the src/test
dirs themselves are ro-bound, so patched code cannot rewrite itself or the
base configuration mid-check. Only dependency installation gets a network
namespace, with lifecycle scripts disabled; all later checks run with
`--unshare-net`. Patch bytes are captured before checks; check output is
never published as trusted prose.

Agent runs (`codexTaskScript`) force ChatGPT authentication and a named
filesystem permission profile that denies the box home, the trusted
directory, and `/proc`, and permits writes only inside the task repo.
Strict configuration errors block execution; there is no weaker sandbox
fallback.

Before activation, record pass/fail plus version metadata — never tokens or
command output — for this sequence:

1. verify the pinned `codex --version` and one structured authenticated
   `codex exec`;
2. pause and resume the Box, then verify another authenticated execution;
3. prove an automatic token refresh, pause and resume a second time, then
   verify one more execution;
4. prove the supervisor lock survives interruption, recovery observes the
   same marker/PID, and a lost identity is blocked without starting another
   process;
5. prove the hard deadline terminates the process group and prevents
   publication;
6. from agent tools, attempt credential reads, trusted-directory writes,
   `/proc` reads, process escape, and network access; each must fail, while
   authenticated refresh still succeeds;
7. in validation, attempt to replace package scripts and base tooling and
   verify the read-only mounts reject those writes; confirm hung commands
   terminate before the persisted deadline.

Each run lives in a fresh per-run task directory. Prompts, schemas, status,
reports, and patches live outside it in the trusted directory. The only
retained private state is the Box credential store and trusted tooling.
Review the Box filesystem and process restrictions before each activation;
filesystem persistence alone is not proof that credentials are isolated from
repository commands.

## Activation gate

Do not set `SUNSET_ENGINE_ENABLED=true` until all of these are current and
reviewed:

- the Box authentication/recovery proof above;
- tests showing publication credentials never enter either Box and that
  prohibited paths, secrets, forged checks, and stale bases fail closed;
- session-bridge tests proving the Box is released on caller close, idle
  timeout, startup failure, and envelope rejection;
- one real end-to-end cloud session against a commissioned Box.

Activation is a reviewed repository configuration change through the normal
release path. Never use `wrangler deploy`.

## Triage

`GET /healthz` proves only that the Worker runs. Everything else returns 501
until enabled; once enabled, `/v1/session` requires the
`SUNSET_ENGINE_TOKEN` bearer and a WebSocket upgrade before any Box is
allocated.

- `lost` run state: the marker or pid vanished; reconcile the box manually
  and never relaunch blindly.
- `agent_failed` / `authentication` / `quota`: read `agent.stderr` in the
  run's trusted output; fix the named cause instead of retrying.
- Publication returning `publication_unknown`: reconcile the deterministic
  branch and all PR states with `reconcilePublication`; never repeat PR
  creation.
- Termination doubts: confirm process-tree death (`terminateRun` returns
  false only when the pgid survived KILL) before allowing later work.
