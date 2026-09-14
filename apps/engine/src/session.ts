/**
 * Cloud engine session bridge.
 *
 * One caller WebSocket maps to one ephemeral Box. The worker runs a fixed
 * per-engine bootstrap inside the box (mkdir the requested cwd + install the
 * selected agent), then starts the agent (`devin acp` / `codex-acp` via the
 * pinned npx package) over the Box exec-session WebSocket. The worker is a
 * frame relay, not a JSON-RPC peer: caller frames are validated, reserialized
 * to single ndjson lines, and written to the agent's stdin; agent stdout is
 * reassembled (streamed UTF-8 decode, split on newlines) and forwarded to the
 * caller as WebSocket text frames.
 *
 * Caller-facing wire contract:
 *   first frame  {"type":"sunset.connect", engine, cwd, model?}
 *   then         {"type":"sunset.ready"} once the agent process is live, or
 *                {"type":"sunset.error","message":code} followed by close
 *   after ready  each text frame is one JSON-RPC message in either direction
 */

import {
  BoxClient,
  cfWebSocketUpgrade,
  required,
  type BoxExecSession,
  type BoxExecSessionStart,
  type BoxSocketOpen,
} from "@sunset/box";

export const ENGINE_SESSION_PATH = "/v1/session";

/** Caller-facing socket. Matches Cloudflare's accepted WebSocket and `ws`. */
export type EngineSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  bufferedAmount?: number;
  addEventListener(
    type: "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event?: unknown) => void): void;
};

export type EngineBox = {
  id: string;
  execSession(
    input: BoxExecSessionStart,
    options?: { open?: BoxSocketOpen; handshakeTimeoutMs?: number },
  ): Promise<BoxExecSession>;
  delete(): Promise<void>;
};

/**
 * Spawn spec for one engine. Fixed argv only — caller input reaches the box
 * exclusively through positional script arguments, never by interpolating
 * caller strings into command text. Mirrors `@sunset/acp` ENGINES; the worker
 * cannot import that package because its module graph pulls in
 * node:child_process. Keep the two in sync.
 */
export type CloudEngineSpawn = {
  /** One-shot bootstrap argv run inside the box before the agent starts.
   * `$1` is the caller cwd; the script makes it and installs the agent if
   * absent. Install chatter goes to stderr, never the ACP stdout stream. */
  bootstrapArgv: (cwd: string) => string[];
  /** Agent process argv. For devin, `$1` of the wrapper script is the model. */
  argv: (model?: string) => string[];
  /** Extra `KEY=VALUE` env for the agent process only (engine-scoped
   * credentials — never worker/box/publication secrets). */
  env?: (model?: string) => Record<string, string>;
};

// Marker lets tests identify the fixed bootstrap invocation. It rides as the
// script's $0 name and as a shell comment — never as a command.
const BOOTSTRAP_MARKER = "sunset-bootstrap";

const DEVIN_BOOTSTRAP = `# ${BOOTSTRAP_MARKER}: devin
mkdir -p -- "$1"
if ! command -v devin >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/devin" ]; then
  curl -fsSL https://cli.devin.ai/install.sh | bash >&2
fi
test -x "$(command -v devin || printf %s "$HOME/.local/bin/devin")"`;

const DEVIN_SPAWN = `# ${BOOTSTRAP_MARKER}: spawn devin
devin="$(command -v devin || printf %s "$HOME/.local/bin/devin")"
exec "$devin" acp \${1:+--model "$1"}`;

const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp@1.11.0";

const CODEX_BOOTSTRAP = `# ${BOOTSTRAP_MARKER}: codex
mkdir -p -- "$1"
command -v npx >/dev/null 2>&1`;

export const CLOUD_ENGINE_SPAWNS: Record<string, CloudEngineSpawn> = {
  devin: {
    bootstrapArgv: (cwd) => [
      "sh",
      "-ec",
      DEVIN_BOOTSTRAP,
      BOOTSTRAP_MARKER,
      cwd,
    ],
    argv: (model) => [
      "sh",
      "-ec",
      DEVIN_SPAWN,
      "sunset-devin",
      ...(model ? [model] : []),
    ],
  },
  codex: {
    bootstrapArgv: (cwd) => [
      "sh",
      "-ec",
      CODEX_BOOTSTRAP,
      BOOTSTRAP_MARKER,
      cwd,
    ],
    argv: () => ["npx", "-y", CODEX_ACP_PACKAGE],
  },
};

export type EngineSessionDeps = {
  engines: Record<string, CloudEngineSpawn>;
  bootBox: () => Promise<EngineBox>;
  /** Transport for the exec-session socket; defaults to the CF fetch upgrade. */
  openSocket?: BoxSocketOpen;
  /** Register background work so it can finish after the fetch handler
   * returns (Worker `ctx.waitUntil`). */
  lifecycle?: (work: Promise<unknown>) => void;
  /** Max wait for the connect envelope after the socket opens. */
  envelopeTimeoutMs?: number;
  /** Overall bound for box boot + bootstrap + agent start. */
  startupTimeoutMs?: number;
  /** Close the session after this much bridge inactivity. */
  idleTimeoutMs?: number;
  /** Largest accepted frame in either direction, in UTF-8 bytes. */
  maxFrameBytes?: number;
  /** Max queued caller frames while the box boots. */
  maxQueuedFrames?: number;
};

const DEFAULT_ENVELOPE_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_FRAME_BYTES = 1 << 20;
const DEFAULT_MAX_QUEUED_FRAMES = 256;

const CWD_PATTERN = /^\/[^\n]{0,512}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;

const utf8 = new TextEncoder();
const byteLength = (value: string): number => utf8.encode(value).length;

type ConnectEnvelope = {
  engine: string;
  cwd: string;
  model?: string;
};

class EnvelopeError extends Error {}

function parseEnvelope(data: string, deps: EngineSessionDeps): ConnectEnvelope {
  if (byteLength(data) > 8192) throw new EnvelopeError("envelope_too_large");
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new EnvelopeError("envelope_invalid_json");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnvelopeError("envelope_invalid");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== "sunset.connect") {
    throw new EnvelopeError("envelope_unexpected_type");
  }
  const engine = envelope.engine;
  if (typeof engine !== "string" || !Object.hasOwn(deps.engines, engine)) {
    throw new EnvelopeError("unsupported_engine");
  }
  const cwd = envelope.cwd;
  if (
    typeof cwd !== "string" ||
    !CWD_PATTERN.test(cwd) ||
    cwd.split("/").includes("..")
  ) {
    throw new EnvelopeError("invalid_cwd");
  }
  const model = envelope.model;
  if (
    model !== undefined &&
    (typeof model !== "string" || !MODEL_PATTERN.test(model))
  ) {
    throw new EnvelopeError("invalid_model");
  }
  return {
    engine,
    cwd,
    ...(typeof model === "string" ? { model } : {}),
  };
}

function eventText(event: { data?: unknown }): string | undefined {
  if (typeof event.data === "string") return event.data;
  if (event.data instanceof ArrayBuffer) {
    return new TextDecoder().decode(event.data);
  }
  if (ArrayBuffer.isView(event.data)) {
    return new TextDecoder().decode(
      event.data.buffer.slice(
        event.data.byteOffset,
        event.data.byteOffset + event.data.byteLength,
      ) as ArrayBuffer,
    );
  }
  return undefined;
}

function errorFrame(code: string): string {
  return JSON.stringify({ type: "sunset.error", message: code });
}

/**
 * Race work against a deadline. On timeout the underlying promise keeps
 * running — `onLate` receives its eventual resolution so late-acquired
 * resources (an upgraded socket, a booted box) are released, not leaked.
 */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  code: string,
  onLate?: (value: T) => void,
): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(code));
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (expired)
      work.then(
        (v) => onLate?.(v),
        () => undefined,
      );
  });
}

/**
 * Bridges one caller socket to one boxed agent process. Never rejects: all
 * failure paths close the caller socket and release the box.
 */
export async function handleEngineSession(
  socket: EngineSocket,
  deps: EngineSessionDeps,
): Promise<void> {
  const maxFrame = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxQueued = deps.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
  const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const startupMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  let phase: "envelope" | "boot" | "ready" = "envelope";
  let done = false;
  let resolveEnvelope: ((envelope: ConnectEnvelope | null) => void) | undefined;
  let box: EngineBox | null = null;
  let boxReleased = false;
  let session: BoxExecSession | null = null;
  let bootstrap: BoxExecSession | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const queued: string[] = [];
  let queuedBytes = 0;

  const safeSend = (data: string): boolean => {
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  };

  /** Bounded delete, registered with the worker lifecycle when provided so it
   * can outlive the caller connection. The timer always clears. */
  const releaseBox = (): void => {
    if (!box || boxReleased) return;
    boxReleased = true;
    const work = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      void box!.delete().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
    // Ephemeral boxes also auto-delete at their TTL; this is the prompt path.
    if (deps.lifecycle) deps.lifecycle(work);
    else void work;
  };

  const cleanup = (code: number, reason: string): void => {
    if (done) return;
    done = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      socket.close(code, reason);
    } catch {
      // socket already closed
    }
    if (bootstrap) {
      // A bootstrap stuck past the deadline must still release its socket
      // even if box deletion hangs or fails.
      bootstrap.close();
      bootstrap = null;
    }
    if (session) {
      try {
        session.kill("KILL");
      } catch {
        // session may already be finished
      }
      session.close();
    }
    releaseBox();
    resolveEnvelope?.(null);
  };

  // Idle bounds silence after ready; before it the envelope timeout and the
  // whole-setup deadline apply.
  const touchIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => cleanup(1001, "idle_timeout"), idleMs);
  };

  // Agent output must never reach the caller before sunset.ready — the client
  // treats the first frame as handshake. Buffer any early lines.
  let readySent = false;
  const pendingLines: string[] = [];
  const deliver = (line: string): void => {
    touchIdle();
    if (!readySent) {
      pendingLines.push(line);
      return;
    }
    if (!safeSend(line)) cleanup(1011, "caller_send_failed");
  };

  socket.addEventListener("close", () => cleanup(1000, "caller_closed"));
  socket.addEventListener("error", () => cleanup(1011, "caller_error"));

  /** One caller frame → exactly one validated ndjson stdin line. */
  const forwardFrame = (data: string): boolean => {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return false;
    }
    if (value === null || typeof value !== "object") return false;
    try {
      session!.write(JSON.stringify(value) + "\n");
      return true;
    } catch {
      cleanup(1011, "agent_write_failed");
      return false;
    }
  };

  // One listener for all phases. WebSocket implementations may emit several
  // buffered messages synchronously in a single data event, so the phase
  // must transition inside the handler — a second listener attached after an
  // await would miss frames batched with the envelope.
  const envelopePromise = new Promise<ConnectEnvelope | null>(
    (resolve) => (resolveEnvelope = resolve),
  );
  const envelopeTimer = setTimeout(() => {
    safeSend(errorFrame("envelope_timeout"));
    cleanup(1008, "envelope_timeout");
    resolveEnvelope?.(null);
  }, deps.envelopeTimeoutMs ?? DEFAULT_ENVELOPE_TIMEOUT_MS);

  socket.addEventListener("message", (event) => {
    if (done) return;
    const data = eventText(event);
    if (phase === "envelope") {
      clearTimeout(envelopeTimer);
      if (data === undefined) {
        safeSend(errorFrame("envelope_binary"));
        cleanup(1003, "envelope_binary");
        resolveEnvelope?.(null);
        return;
      }
      try {
        const parsed = parseEnvelope(data, deps);
        phase = "boot"; // synchronous: later batched frames queue
        resolveEnvelope?.(parsed);
      } catch (error) {
        safeSend(
          errorFrame(
            error instanceof EnvelopeError ? error.message : "envelope_invalid",
          ),
        );
        cleanup(1008, "connect_rejected");
        resolveEnvelope?.(null);
      }
      return;
    }
    if (data === undefined) {
      cleanup(1003, "binary_frame");
      return;
    }
    if (byteLength(data) > maxFrame) {
      cleanup(1009, "frame_too_large");
      return;
    }
    if (phase === "boot") {
      queued.push(data);
      queuedBytes += byteLength(data);
      if (queued.length > maxQueued || queuedBytes > maxFrame * 4) {
        cleanup(1009, "queue_overflow");
      }
      return;
    }
    touchIdle();
    if (!session || !forwardFrame(data)) {
      cleanup(1003, "frame_invalid");
    }
  });

  const envelope = await envelopePromise;
  if (!envelope || done) return;

  const spawn = deps.engines[envelope.engine]!;
  const env = Object.entries(spawn.env?.(envelope.model) ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );
  const startInput: BoxExecSessionStart = {
    argv: spawn.argv(envelope.model),
    cwd: envelope.cwd,
    ...(env.length ? { env } : {}),
  };

  // Whole-setup deadline: box boot, bootstrap exec, and the agent's started
  // handshake share one budget. Each await is followed by a done check so a
  // caller disconnect (or this watchdog) stops queued work and releases
  // late-acquired resources.
  const deadline = Date.now() + startupMs;
  const startupTimer = setTimeout(
    () => cleanup(1011, "startup_timeout"),
    startupMs,
  );
  const remaining = (): number => Math.max(1_000, deadline - Date.now());

  /** Drain a session's output so its queues cannot accumulate. */
  const drain = (s: BoxExecSession): void => {
    for (const stream of [s.stdout, s.stderr]) {
      void (async () => {
        try {
          const reader = stream.getReader();
          while (!(await reader.read()).done) {
            // discard
          }
        } catch {
          // ignore
        }
      })();
    }
  };

  try {
    box = await withDeadline(
      deps.bootBox(),
      startupMs,
      "box_boot_timeout",
      (late) => {
        const work = late.delete().catch(() => undefined);
        if (deps.lifecycle) deps.lifecycle(work);
        else void work;
      },
    );
    if (done) {
      releaseBox();
      return;
    }
    // Bootstrap: mkdir the caller cwd + install the selected agent. Fixed
    // script, positional argv; chatter goes to stderr. The handle is tracked
    // so cleanup() closes its socket even when it never exits.
    bootstrap = await box.execSession(
      { argv: spawn.bootstrapArgv(envelope.cwd) },
      {
        ...(deps.openSocket ? { open: deps.openSocket } : {}),
        handshakeTimeoutMs: remaining(),
      },
    );
    if (done) {
      bootstrap?.close();
      bootstrap = null;
      releaseBox();
      return;
    }
    drain(bootstrap);
    let bootCode: number;
    try {
      bootCode = await withDeadline(
        bootstrap.exited,
        remaining(),
        "bootstrap_timeout",
      );
    } finally {
      bootstrap?.close();
      bootstrap = null;
    }
    if (done) {
      releaseBox();
      return;
    }
    if (bootCode !== 0) {
      throw new Error(`bootstrap_failed:${bootCode}`);
    }
    session = await box.execSession(startInput, {
      ...(deps.openSocket ? { open: deps.openSocket } : {}),
      handshakeTimeoutMs: remaining(),
    });
    if (done) {
      session.close();
      releaseBox();
      return;
    }
  } catch {
    safeSend(errorFrame("engine_start_failed"));
    // cleanup may have already run (caller close or watchdog); releaseBox is
    // idempotent so a box assigned after cleanup is still deleted.
    cleanup(1011, "startup_failed");
    releaseBox();
    return;
  } finally {
    clearTimeout(startupTimer);
  }

  // Pump agent stdout → caller. stdout arrives as arbitrary byte chunks;
  // a streaming decoder keeps multi-byte UTF-8 intact across chunk edges.
  // The pump owns normal completion: the exec-session `exit` frame only
  // closes the stream, so a final response line queued alongside it still
  // reaches the caller.
  const decoder = new TextDecoder();
  let partial = "";
  void (async () => {
    try {
      const reader = session!.stdout.getReader();
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        if (done) return;
        partial += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, index);
          partial = partial.slice(index + 1);
          if (line.length > 0) {
            if (byteLength(line) > maxFrame) {
              cleanup(1009, "frame_too_large");
              return;
            }
            deliver(line);
          }
          if (done) return;
        }
        if (byteLength(partial) > maxFrame) {
          cleanup(1009, "frame_too_large");
          return;
        }
        const buffered = socket.bufferedAmount;
        if (buffered !== undefined && buffered > maxFrame * 4) {
          cleanup(1009, "caller_backpressure");
          return;
        }
      }
      const tail = partial + decoder.decode();
      if (!done && tail.trim().length > 0) {
        if (byteLength(tail) > maxFrame) {
          cleanup(1009, "frame_too_large");
          return;
        }
        deliver(tail);
      }
      if (!done) cleanup(1000, "agent_stream_ended");
    } catch {
      cleanup(1011, "agent_stream_error");
    }
  })();
  // Drain stderr; the pipe must not fill. Never forwarded to the caller.
  void (async () => {
    try {
      const reader = session!.stderr.getReader();
      while (!(await reader.read()).done) {
        // discard
      }
    } catch {
      // ignore
    }
  })();

  if (!safeSend(JSON.stringify({ type: "sunset.ready" }))) {
    cleanup(1011, "caller_send_failed");
    return;
  }
  readySent = true;
  phase = "ready";
  touchIdle();
  for (const line of pendingLines.splice(0)) {
    if (!safeSend(line)) {
      cleanup(1011, "caller_send_failed");
      return;
    }
  }
  for (const frame of queued) {
    if (!forwardFrame(frame)) {
      cleanup(1003, "frame_invalid");
      return;
    }
  }
}

export type EngineEnv = {
  UPSTASH_BOX_API_KEY?: string;
  SUNSET_BOX_NAME?: string;
  GITHUB_REPOSITORY_READ_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  SUNSET_ENGINE_ENABLED?: string;
  SUNSET_ENGINE_TOKEN?: string;
  SUNSET_BOX_TTL_SECONDS?: string;
};

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Gate + auth for the session route, before any box is allocated. Returns the
 * rejection Response, or null when the request may be upgraded.
 */
export function engineSessionGate(input: {
  enabled: boolean;
  path: string;
  upgrade: string | null;
  authorization: string | null;
  token: string | undefined;
}): Response | null {
  if (!input.enabled) {
    return failure(
      501,
      "engine_dormant",
      "the Sunset cloud engine is not enabled; run agents locally for now",
    );
  }
  if (input.path !== ENGINE_SESSION_PATH) {
    return failure(404, "not_found", "unknown engine route");
  }
  if (input.upgrade?.toLowerCase() !== "websocket") {
    return failure(
      400,
      "websocket_required",
      "the engine session endpoint is WebSocket-only",
    );
  }
  if (!input.token) {
    return failure(
      503,
      "engine_misconfigured",
      "SUNSET_ENGINE_ENABLED is set but SUNSET_ENGINE_TOKEN is missing",
    );
  }
  if (input.authorization !== `Bearer ${input.token}`) {
    return failure(401, "unauthorized", "missing or invalid bearer token");
  }
  return null;
}

/** Build session deps from worker env. Credentials stay in headers/env only. */
export function engineSessionDeps(
  env: EngineEnv,
  lifecycle?: (work: Promise<unknown>) => void,
): EngineSessionDeps {
  const ttl = Number.parseInt(env.SUNSET_BOX_TTL_SECONDS ?? "", 10);
  const apiKey = required(env.UPSTASH_BOX_API_KEY, "UPSTASH_BOX_API_KEY");
  return {
    engines: CLOUD_ENGINE_SPAWNS,
    openSocket: cfWebSocketUpgrade,
    ...(lifecycle ? { lifecycle } : {}),
    bootBox: () =>
      BoxClient.ephemeral({
        apiKey,
        runtime: "node",
        ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 1_800,
        labels: ["sunset", "engine", "ephemeral"],
      }),
  };
}
