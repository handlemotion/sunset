import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agent as acpAgent,
  client as acpClient,
  type AgentApp,
} from "@agentclientprotocol/sdk";

import { createEngine } from "./runtime.js";
import type { AcpConnector } from "./client.js";
import { ENGINES } from "./engines.js";

function baseAgent(): AgentApp {
  const app = acpAgent({ name: "fake-acp" });
  app.onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [],
  }));
  app.onRequest("session/new", () => ({ sessionId: "s1" }));
  return app;
}

function recordingConnector(
  build: () => AgentApp,
  events: string[],
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
        events.push("transport-close");
        conn.close();
      },
    };
  };
}

describe("engine session disposal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests session/close with the provider session id before closing the transport", async () => {
    const events: string[] = [];
    const app = baseAgent();
    app.onRequest("session/close", (ctx) => {
      const params = ctx.params as { sessionId: string };
      events.push(`session/close:${params.sessionId}`);
      return {};
    });
    const engine = createEngine(ENGINES.devin, {
      connector: recordingConnector(() => app, events),
    });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "default", params: [] },
    });
    await session.dispose();
    expect(events).toEqual(["session/close:s1", "transport-close"]);
  });

  it("still closes the transport when session/close is rejected", async () => {
    const events: string[] = [];
    const app = baseAgent();
    app.onRequest("session/close", () => {
      events.push("session/close");
      throw new Error("close failed");
    });
    const engine = createEngine(ENGINES.devin, {
      connector: recordingConnector(() => app, events),
    });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "default", params: [] },
    });
    await session.dispose();
    expect(events).toEqual(["session/close", "transport-close"]);
  });

  it("still closes the transport when session/close is unsupported", async () => {
    const events: string[] = [];
    const app = baseAgent();
    const engine = createEngine(ENGINES.devin, {
      connector: recordingConnector(() => app, events),
    });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "default", params: [] },
    });
    await session.dispose();
    expect(events).toEqual(["transport-close"]);
  });

  it("bounds session/close to two seconds before closing the transport", async () => {
    const events: string[] = [];
    const app = baseAgent();
    app.onRequest("session/close", () => {
      events.push("session/close");
      return new Promise<never>(() => undefined);
    });
    const engine = createEngine(ENGINES.devin, {
      connector: recordingConnector(() => app, events),
    });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "default", params: [] },
    });
    vi.useFakeTimers();
    const disposed = session.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    await disposed;
    expect(events).toEqual(["session/close", "transport-close"]);
  });
});
