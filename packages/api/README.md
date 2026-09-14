# @sunset/api

Shared HTTP/WS contract and typed client for the Sunset server. This package
mirrors the contract currently implemented by `@sunset/server`
(`packages/server/src/server.ts`): route table, request/response envelopes,
and a `createClient` fetch client. The server remains the authority —
adoption of the server and `apps/web` onto this package is a follow-up.

## Usage

```ts
import { createClient } from "@sunset/api";

const client = createClient({ baseUrl: server.url, token: server.token });

const projects = await client.listProjects();
const { session, run } = await client.createSession(workspaceId, {
  prompt: "hello",
});
for await (const event of client.attachRun(run.id)) {
  // HostEvent stream, resumable across reconnects
}
```

## Behavior notes

- **Auth.** `token` is sent as `Authorization: Bearer` on HTTP requests and as
  the `?token=` query parameter on the WebSocket upgrade (browser WebSockets
  cannot set headers).
- **Errors.** Non-2xx responses throw `ApiError` carrying `status`, plus the
  server's `error.code`/`error.message` when present (`code` falls back to
  `"unknown"`).
- **`attachRun(runId, { after, signal, reconnectDelayMs })`** returns an
  `AsyncIterable<HostEvent>`:
  - `after` is the last sequence already seen (nonnegative safe integer,
    default `0`). On reconnect the stream resumes from the latest sequence
    received, and replayed events (`sequence <= cursor`) are suppressed.
  - The server sends no terminal frame; it closes the socket cleanly once
    the run's event log is drained and closes with WebSocket code `1000`.
    Every other close — clean or unclean — is confirmed with an authenticated
    `getRun`: `401`/`403` fails the iterator (auth errors are permanent, not
    retried), a drained close on a terminal (`finished`, `error`, `cancelled`)
    or missing run ends the stream, a missing run on any other close fails
    explicitly, and any other state reconnects from the last seen sequence —
    a terminal HTTP status cannot prove the final events were delivered.
    Reconnects are spaced by `reconnectDelayMs` (default 250ms, must be finite
    in `[1, 2147483647]` or `RangeError` is thrown) so there is no busy loop.
    Buffered events are drained before the iterator completes.
  - A bare `{ type: "error", message }` frame (no sequence) throws
    `RunStreamError`; a sequenced `error` HostEvent is yielded normally.
    Malformed JSON fails the iterator, as do malformed event envelopes
    (unknown `type`, non-positive sequence, missing `workspaceId`/
    `sessionId`/`runId`, or a `runId` for a different run) — without
    advancing the cursor. Only the envelope is checked; event payloads are
    not validated.
  - `signal` abort and `iterator.return()` close the socket, remove
    listeners, cancel the reconnect timer, resolve a pending `next()`, and
    discard buffered events.
- **`listWorkspaces`** has no `includeArchived` option: the server only reads
  POST bodies, so a flag on the GET route would do nothing.
- **`createSession` model params** may be omitted; the server defaults them
  to `[]`.
