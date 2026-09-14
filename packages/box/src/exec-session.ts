/**
 * Live exec session over `GET /v2/box/{id}/exec-session` upgraded to a
 * WebSocket. Wire protocol (verified against the official upstash/box SDK):
 *
 *   client → {type:"start", argv, cwd?, env?}        sent once the socket opens
 *   client → {type:"stdin", data:<base64>}           raw bytes to stdin
 *   client → {type:"stdin_close"}                    EOF on stdin
 *   client → {type:"signal", signal}                 signal the process tree
 *   server → {type:"started", pid, execId}           handshake completes
 *   server → {type:"stdout"|"stderr", data:<base64>} raw process output
 *   server → {type:"exit", code}                     process exited
 *   server → {type:"error", message}                 transport-level failure
 *
 * The session owns the process: closing the socket kills it. There is no
 * reattach — a dropped socket ends the run.
 */

/** Minimal socket surface shared by Cloudflare `fetch`-upgraded sockets and
 * Node `ws` sockets. `open` must resolve only once the socket can send. */
export type BoxSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Cloudflare sockets require accept() before events are delivered. */
  accept?: () => void;
  addEventListener(
    type: "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event?: unknown) => void): void;
};

export type BoxSocketOpen = (input: {
  url: string;
  headers: Record<string, string>;
}) => Promise<BoxSocket>;

export type BoxExecSessionStart = {
  argv: string[];
  cwd?: string;
  /** `KEY=VALUE` entries overlaid on the box environment. */
  env?: string[];
};

export type BoxExecSession = {
  pid: number;
  execId: string;
  /** Raw stdout bytes, chunked as produced by the process. */
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code; -1 when the socket dropped first. */
  exited: Promise<number>;
  write(data: string | Uint8Array): void;
  endStdin(): void;
  kill(signal?: string): void;
  /** Hang up the socket; the box stops the process. */
  close(): void;
};

const EXEC_SESSION_SIGNALS = new Set([
  "TERM",
  "KILL",
  "INT",
  "HUP",
  "TSTP",
  "QUIT",
  "USR1",
  "USR2",
]);

// Output streams are consumed as soon as they arrive; these bounds only guard
// against a stalled consumer. One stdout frame may carry up to ~4 MiB; the
// queue bound caps total buffered output.
const MAX_FRAME_BYTES = 4 << 20;
const MAX_QUEUED_BYTES = 8 << 20;

/**
 * Race work against a deadline. On timeout the underlying promise keeps
 * running — `onLate` receives its eventual resolution so late-acquired
 * resources (an upgraded socket, a booted box) can be released instead of
 * leaking.
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function textMessage(event: { data?: unknown }): string | undefined {
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

/**
 * Cloudflare outbound WebSocket: `fetch` performs the upgrade, so arbitrary
 * headers (the box API key) ride the handshake — unlike a `new WebSocket`
 * constructor, which cannot set them.
 */
export const cfWebSocketUpgrade: BoxSocketOpen = async ({ url, headers }) => {
  const response = await fetch(url, {
    headers: { ...headers, upgrade: "websocket" },
  });
  const socket = (response as unknown as { webSocket?: BoxSocket }).webSocket;
  if (!socket) {
    throw new Error(`exec_session_upgrade_failed:${response.status}`);
  }
  socket.accept?.();
  return socket;
};

export async function openBoxExecSession(
  input: BoxExecSessionStart & {
    url: string;
    headers: Record<string, string>;
    open: BoxSocketOpen;
    handshakeTimeoutMs?: number;
  },
): Promise<BoxExecSession> {
  const handshakeMs = input.handshakeTimeoutMs ?? 30_000;
  // The upgrade itself is bounded: a hung `open` rejects here, and a socket
  // that resolves after the deadline is closed immediately.
  const socket = await withDeadline(
    input.open({ url: input.url, headers: input.headers }),
    handshakeMs,
    "exec_session_upgrade_timeout",
    (late) => late.close(),
  );

  const byteSize = {
    highWaterMark: 64 << 10,
    size: (c: Uint8Array) => c.byteLength,
  };
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>(
    { start: (controller) => (stdoutController = controller) },
    byteSize,
  );
  const stderr = new ReadableStream<Uint8Array>(
    { start: (controller) => (stderrController = controller) },
    byteSize,
  );

  let started = false;
  let done = false;
  let resolveStarted!: (session: BoxExecSession) => void;
  let rejectStarted!: (error: Error) => void;
  const startedPromise = new Promise<BoxExecSession>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));

  const send = (frame: Record<string, unknown>): void => {
    if (done) return;
    socket.send(JSON.stringify(frame));
  };

  const finish = (code: number): void => {
    if (done) return;
    done = true;
    try {
      socket.close();
    } catch {
      // already closing
    }
    try {
      stdoutController.close();
    } catch {
      // stream may already be closed
    }
    try {
      stderrController.close();
    } catch {
      // stream may already be closed
    }
    resolveExit(code);
  };

  const fail = (error: Error): void => {
    if (!started) {
      started = true;
      rejectStarted(error);
      startedPromise.catch(() => undefined);
      finish(-1);
      return;
    }
    try {
      stdoutController.error(error);
    } catch {
      // stream may already be closed
    }
    try {
      stderrController.error(error);
    } catch {
      // stream may already be closed
    }
    finish(-1);
  };

  const pushOutput = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    data: unknown,
  ): void => {
    if (
      typeof data !== "string" ||
      data.length > (MAX_FRAME_BYTES * 4) / 3 + 8
    ) {
      fail(new Error("exec_session_frame_invalid"));
      return;
    }
    let chunk: Uint8Array;
    try {
      chunk = base64ToBytes(data);
    } catch {
      fail(new Error("exec_session_bad_base64"));
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch {
      // stream cancelled by consumer
    }
    // desiredSize counts bytes via the queuing strategy.
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED_BYTES) {
      fail(new Error("exec_session_backpressure"));
    }
  };

  const handle = (frame: Record<string, unknown>): void => {
    switch (frame.type) {
      case "started": {
        const pid = typeof frame.pid === "number" ? frame.pid : 0;
        if (pid <= 0) {
          fail(new Error("exec_session_started_without_pid"));
          return;
        }
        started = true;
        resolveStarted({
          pid,
          execId: typeof frame.execId === "string" ? frame.execId : "",
          stdout,
          stderr,
          exited,
          write: (data) => {
            const bytes =
              typeof data === "string" ? new TextEncoder().encode(data) : data;
            send({ type: "stdin", data: bytesToBase64(bytes) });
          },
          endStdin: () => send({ type: "stdin_close" }),
          kill: (signal) => {
            const sig = (signal ?? "KILL").trim().toUpperCase();
            if (!EXEC_SESSION_SIGNALS.has(sig)) {
              throw new Error(`exec_session_signal_unsupported:${sig}`);
            }
            send({ type: "signal", signal: sig });
          },
          close: () => finish(-1),
        });
        return;
      }
      case "stdout":
        pushOutput(stdoutController, frame.data);
        return;
      case "stderr":
        pushOutput(stderrController, frame.data);
        return;
      case "exit":
        if (!started) {
          fail(
            new Error(
              `exec_session_exit_before_start:${typeof frame.code === "number" ? frame.code : "unknown"}`,
            ),
          );
          return;
        }
        finish(typeof frame.code === "number" ? frame.code : -1);
        return;
      case "error":
        fail(
          new Error(
            `exec_session_error:${typeof frame.message === "string" ? frame.message : "unknown"}`,
          ),
        );
        return;
      default:
        return;
    }
  };

  socket.addEventListener("message", (event) => {
    const text = textMessage(event);
    if (text === undefined) return;
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    handle(frame);
  });
  socket.addEventListener("close", () => {
    if (!started) fail(new Error("exec_session_closed_before_start"));
    else finish(-1);
  });
  socket.addEventListener("error", () => {
    if (!started) fail(new Error("exec_session_socket_error"));
    else finish(-1);
  });

  try {
    socket.send(
      JSON.stringify({
        type: "start",
        argv: input.argv,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      }),
    );
  } catch {
    fail(new Error("exec_session_start_send_failed"));
  }

  const timeout = setTimeout(() => {
    fail(new Error("exec_session_start_timeout"));
  }, handshakeMs);

  try {
    return await startedPromise;
  } finally {
    clearTimeout(timeout);
  }
}
