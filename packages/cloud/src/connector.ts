import {
  client as acpClient,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import {
  createWebSocketStream,
  type WebSocketConstructor,
  type WebSocketLike,
} from "@agentclientprotocol/sdk/experimental/ws-client";
import type { AcpConnectionHandle, AcpConnector } from "@sunset/acp";
import { wsSocketOpen, type CloudSocketOpen } from "./socket.js";

export type CloudConnectorOptions = {
  /** Engine worker base URL (`https://…` or `ws(s)://…`). */
  url: string;
  /** Shared bearer token; sent as an Authorization header, never in the URL. */
  token: string;
  engine: string;
  /** Upstream model id carried into the remote spawn (devin `--model`). */
  model?: string;
  openSocket?: CloudSocketOpen;
  /** Bound on connect → ready; the worker bounds boot + agent start. */
  handshakeTimeoutMs?: number;
};

export function sessionUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (!url.pathname.endsWith("/v1/session")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/session`;
  }
  return url.toString();
}

function on(
  socket: WebSocketLike,
  type: string,
  listener: (...args: unknown[]) => void,
): () => void {
  if (socket.on) {
    socket.on(type, listener);
    return () => socket.off?.(type, listener);
  }
  const wrapped = (event: unknown): void => listener(event);
  socket.addEventListener?.(type, wrapped);
  return () => socket.removeEventListener?.(type, wrapped);
}

function firstText(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first instanceof Uint8Array) return Buffer.from(first).toString("utf8");
  const event = first as { data?: unknown } | undefined;
  const data = event?.data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    ).toString("utf8");
  }
  return undefined;
}

/**
 * Opens the caller socket, sends the connect envelope, and resolves with the
 * ACP stream once the worker answers `sunset.ready`.
 *
 * The SDK stream is installed *inside* the ready handler, synchronously: Node
 * `ws` can emit several frames from one TCP chunk, so resolving first and
 * attaching the stream in a promise continuation would drop an agent frame
 * (or a close) batched behind `ready`. Listeners are registered before the
 * envelope is sent for the same reason.
 */
async function openStream(
  options: CloudConnectorOptions,
  cwd: string,
): Promise<Stream> {
  const url = sessionUrl(options.url);
  const timeoutMs = options.handshakeTimeoutMs ?? 120_000;
  const socket = await (options.openSocket ?? wsSocketOpen)({
    url,
    headers: { authorization: `Bearer ${options.token}` },
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
  // The stream reuses this already-open socket; readyState OPEN makes the
  // stream's open wait resolve immediately.
  const Preopened = function (this: unknown): WebSocketLike {
    return socket;
  } as unknown as WebSocketConstructor;

  let failHandshake: ((error: Error) => void) | undefined;
  const streamPromise = new Promise<Stream>((resolve, reject) => {
    const detach: Array<() => void> = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const d of detach) d();
      try {
        socket.close();
      } catch {
        // already closed
      }
      reject(error ?? new Error("cloud_engine_handshake_failed"));
    };
    failHandshake = finish;
    const timer = setTimeout(
      () => finish(new Error("cloud_engine_ready_timeout")),
      timeoutMs,
    );
    detach.push(
      on(socket, "message", (...args) => {
        if (settled) return;
        const text = firstText(args);
        if (text === undefined) return;
        let frame: { type?: unknown; message?: unknown };
        try {
          frame = JSON.parse(text) as { type?: unknown; message?: unknown };
        } catch {
          return;
        }
        if (frame.type === "sunset.ready") {
          settled = true;
          clearTimeout(timer);
          // Detach handshake listeners, then attach the SDK stream — all
          // synchronously — so the next frame in this batch is delivered to
          // the stream, not dropped.
          for (const d of detach) d();
          resolve(createWebSocketStream(url, { WebSocket: Preopened }));
        } else if (frame.type === "sunset.error") {
          finish(
            new Error(
              `cloud_engine_start_failed:${typeof frame.message === "string" ? frame.message : "unknown"}`,
            ),
          );
        }
      }),
      on(socket, "close", () =>
        finish(new Error("cloud_engine_socket_closed")),
      ),
      on(socket, "error", () => finish(new Error("cloud_engine_socket_error"))),
    );
  });

  // Single failure path: a send throw rejects the handshake promise, which is
  // always awaited below — no orphan rejection, and finish() closes the
  // socket and clears the timer for every failure.
  try {
    socket.send(
      JSON.stringify({
        type: "sunset.connect",
        engine: options.engine,
        cwd,
        ...(options.model ? { model: options.model } : {}),
      }),
    );
  } catch (error) {
    failHandshake?.(error instanceof Error ? error : new Error(String(error)));
  }
  return await streamPromise;
}

/**
 * ACP connector backed by the engine worker's `/v1/session` WebSocket. The
 * worker owns box allocation; this side only authenticates and relays
 * JSON-RPC frames. Closing the connection ends the remote exec session, which
 * stops the boxed agent process.
 */
export function cloudConnector(options: CloudConnectorOptions): AcpConnector {
  return async ({ cwd, onUpdate, onPermission, onClose }) => {
    const stream = await openStream(options, cwd);
    const app = acpClient({ name: "sunset" });
    app.onNotification("session/update", (ctx) => {
      const params = ctx.params as SessionNotification;
      onUpdate(params.sessionId, params.update);
    });
    app.onRequest("session/request_permission", (ctx) =>
      onPermission(ctx.params as RequestPermissionRequest),
    );
    const conn = app.connect(stream);
    conn.closed.then(
      () => onClose(null),
      () => onClose(null),
    );
    const handle: AcpConnectionHandle = {
      request: conn.agent.request.bind(conn.agent),
      notify: conn.agent.notify.bind(conn.agent),
      close: () => conn.close(),
    };
    return handle;
  };
}
