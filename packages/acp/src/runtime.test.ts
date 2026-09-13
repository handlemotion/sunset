import { describe, expect, it } from "vitest";

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

function inProcessConnector(build: () => AgentApp): AcpConnector {
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
      close: () => conn.close(),
    };
  };
}

describe("createEngine over ACP", () => {
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
});
