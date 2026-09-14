import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agent as acpAgent,
  client as acpClient,
  type AgentApp,
} from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@sunset/domain";

import { createEngine } from "./runtime.js";
import type { AcpConnector } from "./client.js";
import { ENGINES } from "./engines.js";

function fakeAgent(): AgentApp {
  const app = acpAgent({ name: "fake-acp" });
  app.onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }));
  app.onRequest("session/new", () => ({ sessionId: "fake-session-1" }));
  app.onRequest("session/prompt", async (ctx) => {
    const params = ctx.params as { sessionId: string };
    await ctx.client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello " },
      },
    });
    await ctx.client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Read file",
        name: "read",
        status: "in_progress",
      },
    });
    await ctx.client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: "file contents",
      },
    });
    await ctx.client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
      },
    });
    return { stopReason: "end_turn" };
  });
  app.onNotification("session/cancel", () => undefined);
  return app;
}

function inProcessConnector(
  build: () => AgentApp,
  onClose?: () => void,
): AcpConnector {
  return async ({ onUpdate, onPermission }) => {
    const app = acpClient({ name: "sunset-test" });
    app.onNotification("session/update", (ctx) => {
      const params = ctx.params as {
        sessionId: string;
        update: Parameters<typeof onUpdate>[1];
      };
      onUpdate(params.sessionId, params.update);
    });
    app.onRequest("session/request_permission", (ctx) =>
      onPermission(ctx.params as Parameters<typeof onPermission>[0]),
    );
    const conn = app.connect(build());
    void conn.closed.catch(() => undefined);
    return {
      request: conn.agent.request.bind(conn.agent),
      notify: conn.agent.notify.bind(conn.agent),
      close: () => {
        onClose?.();
        conn.close();
      },
    };
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createEngine over ACP", () => {
  it("bounds hung engine startup and closes its transport", async () => {
    vi.useFakeTimers();
    const app = acpAgent({ name: "hung-acp" });
    app.onRequest("initialize", () => new Promise<never>(() => undefined));
    let closed = false;
    const engine = createEngine(ENGINES.devin, {
      connector: inProcessConnector(
        () => app,
        () => {
          closed = true;
        },
      ),
    });

    const creating = engine.create({
      cwd: "/tmp",
      model: { id: "default", params: [] },
    });
    const rejection = expect(creating).rejects.toThrow(
      "acp_request_timeout:initialize",
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(closed).toBe(true);
  });

  it("creates a session, streams events, and waits for the run", async () => {
    const engine = createEngine(ENGINES.devin, {
      connector: inProcessConnector(fakeAgent),
    });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "default", params: [] },
      mode: "agent",
    });
    expect(session.providerSessionId).toBe("fake-session-1");

    const run = await session.send("say hi");
    const events: AgentEvent[] = [];
    for await (const event of run.stream()) events.push(event);
    const result = await run.wait();

    expect(result.status).toBe("finished");
    expect(result.result).toBe("hello world");
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call",
      "tool_result",
      "text_delta",
    ]);
    await session.dispose();
  });

  it("rejects a second send while a turn is in progress", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    const app = acpAgent({ name: "fake-acp" });
    app.onRequest("initialize", () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
    }));
    app.onRequest("session/new", () => ({ sessionId: "s" }));
    app.onRequest("session/prompt", async () => {
      await blocker;
      return { stopReason: "end_turn" };
    });
    app.onNotification("session/cancel", () => undefined);

    const engine = createEngine(ENGINES.devin, {
      connector: inProcessConnector(() => app),
    });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "default", params: [] },
    });
    const run = await session.send("one");
    await expect(session.send("two")).rejects.toThrow("turn_in_progress");
    release();
    await run.wait();
    await session.dispose();
  });

  it("closes the connection and rejects when session/new outlives the timeout", async () => {
    process.env.SUNSET_ACP_TIMEOUT_MS = "50";
    try {
      let closes = 0;
      const app = acpAgent({ name: "fake-acp" });
      app.onRequest("initialize", () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      }));
      app.onRequest("session/new", () => new Promise(() => {}));
      const base = inProcessConnector(() => app);
      const engine = createEngine(ENGINES.devin, {
        connector: async (input) => {
          const handle = await base(input);
          return {
            ...handle,
            close: () => {
              closes += 1;
              handle.close();
            },
          };
        },
      });
      await expect(
        engine.create({ cwd: "/tmp", model: { id: "default", params: [] } }),
      ).rejects.toThrow("acp_request_timeout:session/new");
      expect(closes).toBe(1);
    } finally {
      delete process.env.SUNSET_ACP_TIMEOUT_MS;
    }
  });

  it("rejects a session/resume timeout instead of falling back to session/load", async () => {
    process.env.SUNSET_ACP_TIMEOUT_MS = "50";
    try {
      let loadCalls = 0;
      const app = acpAgent({ name: "fake-acp" });
      app.onRequest("initialize", () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      }));
      app.onRequest("session/resume", () => new Promise(() => {}));
      app.onRequest("session/load", () => {
        loadCalls += 1;
        return { sessionId: "s" };
      });
      const engine = createEngine(ENGINES.devin, {
        connector: inProcessConnector(() => app),
      });
      await expect(
        engine.resume({
          cwd: "/tmp",
          model: { id: "default", params: [] },
          providerSessionId: "s",
        }),
      ).rejects.toThrow("acp_request_timeout:session/resume");
      expect(loadCalls).toBe(0);
    } finally {
      delete process.env.SUNSET_ACP_TIMEOUT_MS;
    }
  });

  it("uses the default 30s timeout when SUNSET_ACP_TIMEOUT_MS is invalid", async () => {
    vi.useFakeTimers();
    process.env.SUNSET_ACP_TIMEOUT_MS = "bogus";
    try {
      const app = acpAgent({ name: "fake-acp" });
      app.onRequest("initialize", () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      }));
      app.onRequest("session/new", () => new Promise(() => {}));
      const engine = createEngine(ENGINES.devin, {
        connector: inProcessConnector(() => app),
      });
      const pending = engine.create({
        cwd: "/tmp",
        model: { id: "default", params: [] },
      });
      const assertion = expect(pending).rejects.toThrow(
        "acp_request_timeout:session/new",
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      delete process.env.SUNSET_ACP_TIMEOUT_MS;
      vi.useRealTimers();
    }
  });

  it("clamps an oversized timeout to Node's maximum timer delay", async () => {
    vi.useFakeTimers();
    process.env.SUNSET_ACP_TIMEOUT_MS = "3000000000";
    try {
      const app = acpAgent({ name: "fake-acp" });
      app.onRequest("initialize", () => new Promise<never>(() => undefined));
      const engine = createEngine(ENGINES.devin, {
        connector: inProcessConnector(() => app),
      });
      const pending = engine.create({
        cwd: "/tmp",
        model: { id: "default", params: [] },
      });
      const assertion = expect(pending).rejects.toMatchObject({
        method: "initialize",
        timeoutMs: 2_147_483_647,
      });
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      await assertion;
    } finally {
      delete process.env.SUNSET_ACP_TIMEOUT_MS;
      vi.useRealTimers();
    }
  });

  it("leaves session/prompt unbounded and emits a final usage event", async () => {
    process.env.SUNSET_ACP_TIMEOUT_MS = "50";
    try {
      let promptResponse: unknown = {
        stopReason: "end_turn",
        _meta: { quota: { used: 3, size: 10 } },
      };
      const app = acpAgent({ name: "fake-acp" });
      app.onRequest("initialize", () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      }));
      app.onRequest("session/new", () => ({ sessionId: "s" }));
      app.onRequest("session/prompt", async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return promptResponse;
      });
      app.onNotification("session/cancel", () => undefined);
      const engine = createEngine(ENGINES.devin, {
        connector: inProcessConnector(() => app),
      });
      const session = await engine.create({
        cwd: "/tmp",
        model: { id: "default", params: [] },
      });

      // The prompt outlives the 50ms control-plane timeout and still finishes.
      const run = await session.send("hi");
      const events: AgentEvent[] = [];
      for await (const event of run.stream()) events.push(event);
      expect((await run.wait()).status).toBe("finished");
      expect(events.at(-1)).toEqual({ type: "usage", used: 3, size: 10 });

      // An SDK-typed usage payload without numeric used/size emits nothing.
      promptResponse = {
        stopReason: "end_turn",
        usage: { totalTokens: 9, inputTokens: 5, outputTokens: 4 },
      };
      const second = await session.send("again");
      const secondEvents: AgentEvent[] = [];
      for await (const event of second.stream()) secondEvents.push(event);
      expect((await second.wait()).status).toBe("finished");
      expect(secondEvents.some((event) => event.type === "usage")).toBe(false);

      await session.dispose();
    } finally {
      delete process.env.SUNSET_ACP_TIMEOUT_MS;
    }
  });
});
