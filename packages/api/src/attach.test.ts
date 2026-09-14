import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostEvent, Run, RunStatus } from "@sunset/domain";

import { createClient, RunStreamError } from "./index.js";

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
    this.emit("close", { code: 1005, wasClean: true });
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

  it("ends the stream on a clean close with a terminal run, draining buffered events", async () => {
    stubRunStatus(() => "finished");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const ws1 = FakeWebSocket.instances[0]!;
    expect(new URL(ws1.url).searchParams.get("after")).toBe("0");

    ws1.message(ev(1));
    ws1.message(ev(2));
    expect((await iterator.next()).value).toMatchObject({ sequence: 1 });

    // ev(2) is still buffered when the server closes on a finished run.
    ws1.serverClose();
    expect((await iterator.next()).value).toMatchObject({ sequence: 2 });
    expect((await iterator.next()).done).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ends the stream on a clean close when the run no longer exists", async () => {
    stubRunStatus(() => null);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();
    FakeWebSocket.instances[0]!.serverClose();
    expect((await iterator.next()).done).toBe(true);
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
    ];
    for (const frame of badFrames) {
      const iter = client
        .attachRun("r1", { reconnectDelayMs: 1 })
        [Symbol.asyncIterator]();
      const ws = FakeWebSocket.instances.at(-1)!;
      const pending = iter.next();
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

    const ws1 = FakeWebSocket.instances[0]!;
    const pending = iterator.next();
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

    const ws = FakeWebSocket.instances[0]!;
    const pending = iterator.next();
    ws.message(ev(1));
    expect((await pending).value).toMatchObject({ sequence: 1 });
    ws.message(ev(2)); // buffered, undelivered

    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);
  });

  it("return() resolves a pending next, discards the queue, and clears a latched failure", async () => {
    stubRunStatus(() => "running");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const iterator = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();

    const ws = FakeWebSocket.instances[0]!;
    // A stream error with no pending next() latches the failure.
    ws.message({ type: "error", message: "boom" });
    await iterator.return(undefined);
    expect((await iterator.next()).done).toBe(true);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);

    // Buffered events are also discarded.
    const iterator2 = client
      .attachRun("r1", { reconnectDelayMs: 1 })
      [Symbol.asyncIterator]();
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.message(ev(1));
    ws2.message(ev(2));
    await iterator2.return(undefined);
    expect((await iterator2.next()).done).toBe(true);
    expect(ws2.closed).toBe(true);
  });
});
