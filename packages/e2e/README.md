# @sunset/e2e

End-to-end proof of the conductor loop: repo → worktree → session → prompt →
streamed events → file actually edited — through the real host, real HTTP/WS
server, real git, and the `@sunset/api` client.

`src/e2e.test.ts` runs the loop against `@sunset/testing`'s fake ACP agent,
both in-process and spawned as a real stdio child. This file is the manual
runbook for the same flow against a real `devin` or `codex` engine.

## Automated

```sh
pnpm build                      # the tests run against workspace dist builds
pnpm --filter @sunset/e2e test
```

## Manual smoke against a real engine

Prereqs: `pnpm install && pnpm build` at the repo root, plus an authenticated
engine CLI: `devin` on PATH and logged in (`devin auth login` — run
`devin models list --format json` to confirm), or `codex-acp` on PATH with a
signed-in codex (otherwise the adapter runs through `npx`). If session
creation fails with `model_catalog_unavailable`, the engine's catalog command
could not run — usually missing auth; `sunset doctor` reports the same.

Use a scratch state root so the smoke never touches real Sunset state:

```sh
export SMOKE=/tmp/sunset-smoke
mkdir -p "$SMOKE"
node packages/cli/dist/main.js serve \
  --state-dir "$SMOKE/state" --worktree-root "$SMOKE/worktrees" --port 8791
```

The server prints its boot URL with a token:

```
sunset is running
  url:   http://127.0.0.1:8791/?token=<TOKEN>
  state: /tmp/sunset-smoke/state
```

Export it for the steps below:

```sh
export BASE=http://127.0.0.1:8791
export TOKEN=<TOKEN>
```

### 1. Register a project

```sh
curl -s "$BASE/api/projects" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"repoRoot\": \"$(pwd)\"}"
```

Check: returns `{"id": "...", "repoRoot": "..."}`. Export `PROJECT=<id>`.

### 2. Create a workspace

```sh
curl -s "$BASE/api/projects/$PROJECT/workspaces" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug": "smoke"}'
```

Check: returns a workspace with `worktreePath` under `$SMOKE/worktrees`, and
`ls "$SMOKE/worktrees/smoke"` shows the repo contents on branch
`sunset/smoke`. Export `WORKSPACE=<id>` and `WT=<worktreePath>`.

### 3. Create a session with a prompt

```sh
curl -s "$BASE/api/workspaces/$WORKSPACE/sessions" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"prompt": "Create a file called hello.txt containing the word hello, then stop.", "engine": "devin"}'
```

Check: returns `{session, run}` with `run.status` `"queued"`. Export
`SESSION=<session.id>` and `RUN=<run.id>`.

### 4. Attach to the run's event stream

The event stream is a WebSocket. The `@sunset/api` client handles replay,
reconnect, and the drained-close handshake:

```sh
node --input-type=module -e '
import { createClient } from "./packages/api/dist/index.js";
const client = createClient({ baseUrl: process.env.BASE, token: process.env.TOKEN });
for await (const event of client.attachRun(process.env.RUN)) {
  console.log(event.sequence, event.type, JSON.stringify(event).slice(0, 200));
}
'
```

Check: sequenced events (text_delta, tool_call, tool_result, …) stream in
order; the stream ends on its own when the run finishes.

### 5. Confirm the file edit and the run result

```sh
curl -s "$BASE/api/runs/$RUN/wait" -H "authorization: Bearer $TOKEN"
cat "$WT/hello.txt"
```

Check: `wait` returns `{"status": "finished", "result": ...}` and
`hello.txt` exists in the worktree.

### 6. Follow-up prompt on the same session

```sh
curl -s "$BASE/api/sessions/$SESSION/runs" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"prompt": "Append the word again to hello.txt."}'
```

Check: a new queued run on the same session; attach to it as in step 4; the
file gains a second line.

### 7. Cancel a running turn

Start another prompt, then cancel before it finishes:

```sh
RUN2=$(curl -s "$BASE/api/sessions/$SESSION/runs" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"prompt": "Write a long essay about sunsets to essay.txt."}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).run.id))')
curl -s "$BASE/api/runs/$RUN2/cancel" -X POST -H "authorization: Bearer $TOKEN"
```

Check: returns `{"status": "cancelled", ...}`; attaching to `$RUN2` replays
whatever partial events streamed before the cancel.

### 8. Restart and replay

Ctrl-C the server, then re-run the `serve` command with the same
`--state-dir`/`--worktree-root`, re-export `TOKEN`, and attach again with a
mid-stream cursor — `client.attachRun(process.env.RUN, { after: 3 })` in the
step-4 snippet. Check: only events after sequence 3 are replayed, proving the
event log survives a host restart.

### Notes

- Codex works the same way with `"engine": "codex"`; model selection happens
  through `session/set_model` after session creation.
- `sunset doctor` checks engine CLIs on PATH before you start.
- `SUNSET_LOG=/path/to/log` makes the server write a JSON request log.
