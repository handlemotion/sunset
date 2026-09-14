import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostEvent, Run, RunStatus } from "@sunset/domain";

import { ApiError, createClient, RunStreamError } from "./index.js";

const BASE = "http://sunset.test";
const TOKEN = "tok-123";

type FakeEvent = { data?: unknown; code?: number; wasClean?: boolean };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  closed = false;
  private errored = false;
  private readonly listeners = new Map<
    string,
    Set<(event: FakeEvent) => void>
  >();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Client-initiated close; an errored socket reports an unclean close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {
      code: this.errored ? 1006 : 1005,
      wasClean: !this.errored,
    });
  }

  /** Test helper: deliver a message frame. */
  message(value: unknown): void {
    this.emit("message", {
      data: typeof value === "string" ? value : JSON.stringify(value),
    });
  }

  /** Test helper: server completes the stream and closes cleanly. */
  serverClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code: 1000, wasClean: true });
  }

  /** Test helper: server shuts down before the stream is drained. */
  serverShutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code: 1001, wasClean: true });
  }

  /** Test helper: the connection drops without a closing handshake. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.errored = true;
    this.emit("error");
    this.emit("close", { code: 1006, wasClean: false });
  }

  emit(type: string, event: FakeEvent = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function ev(sequence: number, extra: Record<string, unknown> = {}): HostEvent {
  return {
    type: "text_delta",
    text: `t${sequence}`,
    workspaceId: "w1",
    sessionId: "s1",
    runId: "r1",
    sequence,
    ...extra,
  } as HostEvent;
}

function runWith(status: RunStatus): Run {
  return {
    id: "r1",
    sessionId: "s1",
    status,
    createdAt: 3,
    startedAt: 4,
    finishedAt: null,
  };
}

function stubRunStatus(status: () => RunStatus | null) {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify(status() === null ? null : runWith(status()!)),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("attachRun", () => {
  it("validates `after` is a nonnegative safe integer", () => {
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    expect(() => client.attachRun("r1", { after: -1 })).toThrow(RangeError);
    expect(() => client.attachRun("r1", { after: 1.5 })).toThrow(RangeError);
    expect(() => client.attachRun("r1", { after: NaN })).toThrow(RangeError);
  });

  it("validates `reconnectDelayMs` is finite within [1, 2147483647]", () => {
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    for (const delay of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
      expect(() => client.attachRun("r1", { reconnectDelayMs: delay })).toThrow(
        RangeError,
      );
    }
    expect(() => client.attachRun("r1", { reconnectDelayMs: 1 })).not.toThrow();
    expect(() =>
      client.attachRun("r1", { reconnectDelayMs: 2147483647 }),
    ).not.toThrow();
  });

  it("streams events after the initial sequence and resumes from the latest on drop", async () => {
    let status: RunStatus = "running";
    stubRunStatus(() => status);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { after: 3, reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    let next = iterator.next();
    const ws1 = FakeWebSocket.instances[0]!;
    expect(ws1.url).toBe(
      `ws://sunset.test/api/runs/r1/events?token=${TOKEN}&after=3`,
    );

    ws1.message(ev(4));
    expect((await next).value).toMatchObject({ sequence: 4 });
    ws1.message(ev(5));
    expect((await iterator.next()).value).toMatchObject({ sequence: 5 });

    // Abnormal disconnect: the client reconnects resuming from sequence 5.
    ws1.drop();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    expect(ws2.url).toContain("after=5");

    // Replayed events are suppressed; only newer sequences are delivered.
    ws2.message(ev(4));
    ws2.message(ev(5));
    next = iterator.next();
    ws2.message(ev(6));
    expect((await next).value).toMatchObject({ sequence: 6 });

    status = "finished";
    ws2.serverClose();
    expect((await iterator.next()).done).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reconnects on an unclean close even when the run is already terminal, then ends on clean close", async () => {
    // The run finished server-side, but seq6 was persisted after the socket
    // dropped — a terminal status alone cannot prove it was delivered.
    stubRunStatus(() => "finished");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    let next = iterator.next();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.message(ev(5));
    expect((await next).value).toMatchObject({ sequence: 5 });

    ws1.drop();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    expect(ws2.url).toContain("after=5");

    next = iterator.next();
    ws2.message(ev(6));
    expect((await next).value).toMatchObject({ sequence: 6 });

    ws2.serverClose();
    expect((await iterator.next()).done).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reconnects on a clean shutdown close even when the run is terminal", async () => {
    stubRunStatus(() => "finished");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    let next = iterator.next();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.message(ev(5));
    expect((await next).value).toMatchObject({ sequence: 5 });

    ws1.serverShutdown();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    expect(ws2.url).toContain("after=5");

    next = iterator.next();
    ws2.message(ev(6));
    expect((await next).value).toMatchObject({ sequence: 6 });
    ws2.serverClose();
    expect((await iterator.next()).done).toBe(true);
  });

  it("ends the stream on a clean close with a terminal run, draining buffered events", async () => {
    stubRunStatus(() => "finished");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    const ws1 = FakeWebSocket.instances[0]!;
    expect(new URL(ws1.url).searchParams.get("after")).toBe("0");

    ws1.message(ev(1));
    ws1.message(ev(2));
    expect((await pending).value).toMatchObject({ sequence: 1 });

    // ev(2) is still buffered when the server closes on a finished run.
    ws1.serverClose();
    expect((await iterator.next()).value).toMatchObject({ sequence: 2 });
    expect((await iterator.next()).done).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it.each([401, 403])(
    "fails the iterator on HTTP %i instead of retrying",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "unauthorized",
                message: "invalid boot token",
              },
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("WebSocket", FakeWebSocket);

      const client = createClient({ baseUrl: BASE, token: "bad" });
      const iterator = client
        .attachRun("r1", { reconnectDelayMs: 1 })
        [Symbol.asyncIterator]();

      const pending = iterator.next();
      FakeWebSocket.instances[0]!.drop();

      const error = await pending.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status,
        code: "unauthorized",
        message: "invalid boot token",
      });
      await sleep(30);
      expect(FakeWebSocket.instances).toHaveLength(1);
    },
  );

  it("retries the status check when getRun fails transiently", async () => {
    let status: RunStatus = "running";
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return new Response(JSON.stringify(runWith(status)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    FakeWebSocket.instances[0]!.drop();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));

    status = "finished";
    FakeWebSocket.instances[1]!.serverClose();
    expect((await pending).done).toBe(true);
  });

  it("fails explicitly when the run is missing after an unclean close", async () => {
    stubRunStatus(() => null);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    FakeWebSocket.instances[0]!.drop();
    await expect(pending).rejects.toThrow(/run r1 not found/);
  });

  it("ends the stream on a clean close when the run no longer exists", async () => {
    stubRunStatus(() => null);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    FakeWebSocket.instances[0]!.serverClose();
    expect((await pending).done).toBe(true);
  });

  it("throws RunStreamError on a bare error frame", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const next = iterator.next();
    FakeWebSocket.instances[0]!.message({
      type: "error",
      message: "stream failed",
    });
    await expect(next).rejects.toThrow(RunStreamError);
    await expect(next).rejects.toThrow("stream failed");
    expect((await iterator.next()).done).toBe(true);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  it("yields sequenced error events as ordinary HostEvents", async () => {
    stubRunStatus(() => "error");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const next = iterator.next();
    FakeWebSocket.instances[0]!.message({
      type: "error",
      message: "agent exploded",
      workspaceId: "w1",
      sessionId: "s1",
      runId: "r1",
      sequence: 4,
    });
    expect((await next).value).toMatchObject({
      type: "error",
      sequence: 4,
      message: "agent exploded",
    });
  });

  it("fails on malformed JSON and malformed event envelopes", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    FakeWebSocket.instances[0]!.emit("message", { data: "{not json" });
    await expect(next).rejects.toThrow(/malformed JSON/);

    const badFrames = [
      { type: "status", sequence: 5 }, // missing workspace/session/run ids
      {
        type: "nonsense", // unknown event type
        sequence: 9,
        workspaceId: "w1",
        sessionId: "s1",
        runId: "r1",
      },
      {
        type: "text_delta", // frame for a different run
        text: "x",
        sequence: 7,
        workspaceId: "w1",
        sessionId: "s1",
        runId: "r2",
      },
      {
        type: "text_delta", // non-positive sequence
        text: "x",
        sequence: 0,
        workspaceId: "w1",
        sessionId: "s1",
        runId: "r1",
      },
      {
        type: "error", // present but non-numeric sequence
        message: "x",
        sequence: "4",
        workspaceId: "w1",
        sessionId: "s1",
        runId: "r1",
      },
      {
        type: "error", // present but fractional sequence
        message: "x",
        sequence: 1.5,
        workspaceId: "w1",
        sessionId: "s1",
        runId: "r1",
      },
      {
        type: "error", // present but null sequence
        message: "x",
        sequence: null,
        workspaceId: "w1",
        sessionId: "s1",
        runId: "r1",
      },
    ];
    for (const frame of badFrames) {
      const iter = client
        .attachRun("r1", { reconnectDelayMs: 1 })
        [Symbol.asyncIterator]();
      const pending = iter.next();
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.message(frame);
      await expect(pending).rejects.toThrow(/malformed event/);
    }
  });

  it("an already-aborted signal resolves next without opening a socket", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const controller = new AbortController();
    controller.abort();

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { signal: controller.signal, reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("aborting while a reconnect timer is queued prevents a new socket", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const controller = new AbortController();

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { signal: controller.signal, reconnectDelayMs: 20 })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.drop();
    controller.abort();

    expect((await pending).done).toBe(true);
    await sleep(60);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws1.listenerCount("message")).toBe(0);
  });

  it("aborting discards buffered events", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const controller = new AbortController();

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { signal: controller.signal, reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    const ws = FakeWebSocket.instances[0]!;
    ws.message(ev(1));
    expect((await pending).value).toMatchObject({ sequence: 1 });
    ws.message(ev(2)); // buffered, undelivered

    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);
  });

  it("opens no socket until the first next(), so return/throw beforehand leak nothing", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const abandoned = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();
    expect(FakeWebSocket.instances).toHaveLength(0);

    await abandoned.return(undefined);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect((await abandoned.next()).done).toBe(true);

    const thrown = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();
    await expect(thrown.throw(new Error("halt"))).rejects.toThrow("halt");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("return() resolves a pending next, discards the queue, and clears a latched failure", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    // A pending next() resolves done on return.
    const pending = iterator.next();
    const ws = FakeWebSocket.instances[0]!;
    await iterator.return(undefined);
    expect((await pending).done).toBe(true);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);

    // A failure latched before return is cleared, not thrown.
    const iterator2 = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();
    const first2 = iterator2.next();
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.message(ev(1));
    expect((await first2).value).toMatchObject({ sequence: 1 });
    ws2.message(ev(2)); // buffered, discarded by return
    ws2.message({ type: "error", message: "boom" }); // latched, no waiter
    await iterator2.return(undefined);
    expect((await iterator2.next()).done).toBe(true);
    expect(ws2.closed).toBe(true);
  });
});
