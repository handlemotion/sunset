import type { HostEvent, Run } from "@sunset/domain";

export type AttachRunOptions = {
  /**
   * Last event sequence already seen. The stream resumes after it.
   * Must be a nonnegative safe integer; defaults to 0.
   */
  after?: number;
  /** Aborts the stream: the socket, listeners, and reconnect timer close. */
  signal?: AbortSignal;
  /** Delay between a dropped connection and the next attempt. Default 250ms. */
  reconnectDelayMs?: number;
};

/** Thrown when the server sends a terminal `{type:"error"}` stream frame. */
export class RunStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStreamError";
  }
}

export type AttachRunContext = {
  /** Builds the WebSocket URL for the run's event stream. */
  eventsUrl: (runId: string, after: number) => string;
  /** Fetches the current run record to decide terminal vs. reconnect. */
  getRun: (runId: string) => Promise<Run | null>;
};

type CloseFrame = { code?: number; wasClean?: boolean };

interface AttachSocket {
  readonly readyState: number;
  close(): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close", listener: (event: CloseFrame) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "close",
    listener: (event: CloseFrame) => void,
  ): void;
  removeEventListener(type: "error", listener: () => void): void;
}

interface AttachSocketConstructor {
  new (url: string): AttachSocket;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "finished",
  "error",
  "cancelled",
]);

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "text_delta",
  "thought_delta",
  "tool_call",
  "tool_result",
  "plan",
  "mode",
  "status",
  "error",
]);

type Waiter = {
  resolve: (result: IteratorResult<HostEvent>) => void;
  reject: (error: unknown) => void;
};

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as Uint8Array);
  }
  return String(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Envelope check only — payloads are not validated against the event type. */
function isHostEvent(value: unknown, runId: string): value is HostEvent {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    KNOWN_EVENT_TYPES.has(value.type) &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    typeof value.workspaceId === "string" &&
    typeof value.sessionId === "string" &&
    value.runId === runId
  );
}

const DONE: IteratorResult<HostEvent> = { value: undefined, done: true };

/**
 * Streams run events over the run-events WebSocket.
 *
 * The server sends no explicit terminal frame: it closes the socket cleanly
 * when the run's event log is drained. A clean close (`wasClean`) confirms
 * the run via `getRun` — terminal (or missing) ends the stream, anything else
 * reconnects. An unclean close always reconnects from the last delivered
 * sequence, even when the run is already terminal, because a terminal status
 * cannot prove the final events crossed the socket.
 */
export function attachRunEvents(
  context: AttachRunContext,
  runId: string,
  options: AttachRunOptions = {},
): AsyncIterable<HostEvent> {
  const initialAfter = options.after ?? 0;
  if (!Number.isSafeInteger(initialAfter) || initialAfter < 0) {
    throw new RangeError(
      "attachRun: `after` must be a nonnegative safe integer",
    );
  }
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  const signal = options.signal;

  return {
    [Symbol.asyncIterator]() {
      let cursor = initialAfter;
      const queue: HostEvent[] = [];
      const waiters: Waiter[] = [];
      let socket: AttachSocket | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      let ended = false;
      let finished = false;
      let cancelled = false;
      let failure: { error: unknown } | null = null;

      const onMessage = (frame: { data: unknown }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frameText(frame.data));
        } catch {
          fail(new Error("attachRun: received a malformed JSON frame"));
          return;
        }
        // A bare {type:"error"} frame is the server's terminal stream error;
        // a sequenced error is an ordinary HostEvent and is yielded.
        if (
          isRecord(parsed) &&
          parsed.type === "error" &&
          !Number.isSafeInteger(parsed.sequence)
        ) {
          fail(
            new RunStreamError(
              typeof parsed.message === "string"
                ? parsed.message
                : "run event stream failed",
            ),
          );
          return;
        }
        if (!isHostEvent(parsed, runId)) {
          fail(new Error("attachRun: received a malformed event frame"));
          return;
        }
        if (parsed.sequence <= cursor) return;
        cursor = parsed.sequence;
        if (ended) return;
        const waiter = waiters.shift();
        if (waiter) waiter.resolve({ value: parsed, done: false });
        else queue.push(parsed);
      };

      const onClose = (event: CloseFrame) => {
        detachSocket();
        if (event.wasClean === true) {
          void decide();
        } else {
          scheduleReconnect();
        }
      };

      const onError = () => {
        socket?.close();
      };

      const onAbort = () => cancel();

      function detachSocket() {
        if (!socket) return;
        const current = socket;
        socket = undefined;
        current.removeEventListener("message", onMessage);
        current.removeEventListener("close", onClose);
        current.removeEventListener("error", onError);
      }

      function teardown(): boolean {
        if (ended) return false;
        ended = true;
        signal?.removeEventListener("abort", onAbort);
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        const current = socket;
        detachSocket();
        if (current) {
          try {
            current.close();
          } catch {
            // best-effort close
          }
        }
        return true;
      }

      /** Natural completion: buffered events drain before the iterator ends. */
      function finish() {
        if (!teardown()) return;
        finished = true;
        for (const waiter of waiters.splice(0)) waiter.resolve(DONE);
      }

      /** Stream failure: buffered events drain, then the iterator throws. */
      function fail(error: unknown) {
        if (!teardown()) return;
        failure = { error };
        const pending = waiters.splice(0);
        for (const waiter of pending) waiter.reject(error);
        if (pending.length > 0) failure = null;
      }

      /** Cancellation (abort/return/throw): buffered events are discarded. */
      function cancel() {
        cancelled = true;
        queue.length = 0;
        failure = null;
        teardown();
        for (const waiter of waiters.splice(0)) waiter.resolve(DONE);
      }

      async function decide() {
        let run: Run | null;
        try {
          run = await context.getRun(runId);
        } catch {
          if (!ended) scheduleReconnect();
          return;
        }
        if (ended) return;
        if (run === null || TERMINAL_STATUSES.has(run.status)) {
          finish();
          return;
        }
        scheduleReconnect();
      }

      function scheduleReconnect() {
        if (ended || timer !== undefined) return;
        timer = setTimeout(() => {
          timer = undefined;
          connect();
        }, reconnectDelayMs);
      }

      function connect() {
        const Impl = (globalThis as { WebSocket?: unknown }).WebSocket as
          AttachSocketConstructor | undefined;
        if (!Impl) {
          fail(new Error("attachRun: WebSocket is not available"));
          return;
        }
        let ws: AttachSocket;
        try {
          ws = new Impl(context.eventsUrl(runId, cursor));
        } catch (error) {
          fail(error);
          return;
        }
        socket = ws;
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
      }

      function start() {
        if (started) return;
        started = true;
        if (signal?.aborted) {
          cancel();
          return;
        }
        signal?.addEventListener("abort", onAbort);
        connect();
      }

      start();

      const iterator: AsyncIterableIterator<HostEvent> = {
        next() {
          if (cancelled) return Promise.resolve(DONE);
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (failure) {
            const { error } = failure;
            failure = null;
            finished = true;
            return Promise.reject(error);
          }
          if (finished || ended) return Promise.resolve(DONE);
          return new Promise<IteratorResult<HostEvent>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return() {
          cancel();
          return Promise.resolve(DONE);
        },
        throw(error?: unknown) {
          cancel();
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };

      return iterator;
    },
  };
}
