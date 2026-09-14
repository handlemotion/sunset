import { describe, expect, it } from "vitest";

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { createEngine, ENGINES } from "@sunset/acp";
import type { AgentEvent } from "@sunset/domain";

import { fakeAcpAgent } from "./fake-agent.js";

const createInput = {
  cwd: "/tmp",
  model: { id: "default", params: [] },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("fakeAcpAgent over createEngine", () => {
  it("streams the scripted updates and records model and mode calls", async () => {
    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello " },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Read file",
        name: "read",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: "file contents",
      },
      {
        sessionUpdate: "plan",
        entries: [
          { content: "read the file", status: "completed", priority: "high" },
        ],
      },
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      { sessionUpdate: "session_info_update", title: "fake session" },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "show help", input: null },
        ],
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
      },
    ];
    const fake = fakeAcpAgent({
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "plan", name: "Plan" },
        ],
      },
      prompt: { updates },
    });
    const engine = createEngine(ENGINES.codex, { connector: fake.connector });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "codex:gpt-5.5", params: [{ id: "effort", value: "high" }] },
      mode: "plan",
    });
    expect(session.providerSessionId).toBe("fake-session-1");

    expect(
      fake.calls.find((call) => call.method === "session/set_model")?.params,
    ).toMatchObject({ modelId: "gpt-5.5[high]" });
    expect(
      fake.calls.find((call) => call.method === "session/set_mode")?.params,
    ).toMatchObject({ modeId: "plan" });

    const run = await session.send("say hi");
    const events: AgentEvent[] = [];
    for await (const event of run.stream()) events.push(event);
    const result = await run.wait();

    expect(result.status).toBe("finished");
    expect(result.result).toBe("hello world");
    // usage_update, session_info_update and available_commands_update are
    // delivered to the client but map to no domain events.
    expect(events.map((event) => event.type)).toEqual([
      "thought_delta",
      "text_delta",
      "tool_call",
      "tool_result",
      "plan",
      "text_delta",
    ]);
    await session.dispose();
  });

  it("retries session/new after authenticate with the advertised method", async () => {
    const fake = fakeAcpAgent({
      requireAuth: true,
      authMethods: [{ id: "oauth", name: "OAuth" }],
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.create(createInput);
    expect(session.providerSessionId).toBe("fake-session-1");
    expect(fake.calls.map((call) => call.method)).toEqual([
      "initialize",
      "session/new",
      "authenticate",
      "session/new",
    ]);
    expect(
      fake.calls.find((call) => call.method === "authenticate")?.params,
    ).toMatchObject({ methodId: "oauth" });
    await session.dispose();
  });

  it("fails create when authenticate keeps failing", async () => {
    const fake = fakeAcpAgent({
      requireAuth: true,
      authMethods: [{ id: "oauth", name: "OAuth" }],
      authenticate: { failTimes: 3 },
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    await expect(engine.create(createInput)).rejects.toThrow(
      /not authenticated/i,
    );
    expect(
      fake.calls.filter((call) => call.method === "authenticate"),
    ).toHaveLength(1);
  });

  it("rejects authenticate when a different methodId is required", async () => {
    const fake = fakeAcpAgent({
      requireAuth: true,
      authMethods: [{ id: "oauth", name: "OAuth" }],
      authenticate: { methodId: "token" },
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    await expect(engine.create(createInput)).rejects.toThrow(
      /unknown auth method: oauth/i,
    );
  });

  it("falls back to session/load when session/resume is not implemented", async () => {
    const fake = fakeAcpAgent({
      agentCapabilities: { loadSession: true },
      methodNotFound: ["session/resume"],
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.resume({
      ...createInput,
      providerSessionId: "sess-old",
    });
    expect(session.providerSessionId).toBe("sess-old");
    expect(fake.calls.map((call) => call.method)).toEqual([
      "initialize",
      "session/resume",
      "session/load",
    ]);
    expect(fake.calls[1]?.params).toMatchObject({ sessionId: "sess-old" });
    await session.dispose();
  });

  it("fails resume when both resume and load are configured to fail", async () => {
    const fake = fakeAcpAgent({
      agentCapabilities: { loadSession: true },
      resume: { error: new Error("resume_broken") },
      load: { error: new Error("load_broken") },
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    await expect(
      engine.resume({ ...createInput, providerSessionId: "sess-old" }),
    ).rejects.toThrow(/session_resume_failed.*load_broken/);
  });

  it("resumes after authenticating when resume requires auth", async () => {
    const fake = fakeAcpAgent({
      requireAuth: true,
      authMethods: [{ id: "oauth", name: "OAuth" }],
      agentCapabilities: { loadSession: true },
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.resume({
      ...createInput,
      providerSessionId: "sess-old",
    });
    expect(session.providerSessionId).toBe("sess-old");
    expect(fake.calls.map((call) => call.method)).toEqual([
      "initialize",
      "session/resume",
      "authenticate",
      "session/resume",
    ]);
    await session.dispose();
  });

  it("cancels an in-flight prompt", async () => {
    const fake = fakeAcpAgent({
      prompt: {
        waitForCancel: true,
        updates: [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial" },
          },
        ],
      },
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.create(createInput);
    const run = await session.send("work");

    const events: AgentEvent[] = [];
    const streaming = (async () => {
      for await (const event of run.stream()) events.push(event);
    })();
    await run.cancel();
    const result = await run.wait();
    await streaming;

    expect(result.status).toBe("cancelled");
    expect(events.map((event) => event.type)).toEqual(["text_delta"]);
    expect(fake.calls.some((call) => call.method === "session/cancel")).toBe(
      true,
    );
    await session.dispose();
  });

  it("surfaces a prompt error as a failed run", async () => {
    const fake = fakeAcpAgent({ prompt: { error: new Error("boom") } });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.create(createInput);
    const run = await session.send("hi");
    const result = await run.wait();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("boom");
    await session.dispose();
  });

  it("does not carry cancellation into the next prompt", async () => {
    const fake = fakeAcpAgent({
      prompt: {
        waitForCancel: true,
        updates: [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial" },
          },
        ],
      },
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.create(createInput);

    const first = await session.send("first");
    await first.cancel();
    expect((await first.wait()).status).toBe("cancelled");

    const second = await session.send("second");
    const events: AgentEvent[] = [];
    const streaming = (async () => {
      for await (const event of second.stream()) events.push(event);
    })();
    await sleep(0);
    await second.cancel();
    expect((await second.wait()).status).toBe("cancelled");
    await streaming;

    expect(events).toEqual([{ type: "text_delta", text: "partial" }]);
    await session.dispose();
  });

  it("never answers hung methods until the connection closes", async () => {
    const fake = fakeAcpAgent({ hangOn: ["session/prompt"] });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.create(createInput);
    const run = await session.send("hi");

    const outcome = await Promise.race([
      run.wait().then(() => "resolved" as const),
      sleep(50).then(() => "pending" as const),
    ]);
    expect(outcome).toBe("pending");

    await session.dispose();
    const result = await run.wait();
    expect(result.status).toBe("error");
  });

  it("disconnects after the configured method", async () => {
    const fake = fakeAcpAgent({ exitAfter: "session/new" });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.create(createInput);
    const run = await session.send("hi");
    const result = await run.wait();
    expect(result.status).toBe("error");
    await session.dispose();
  });

  it("disconnects mid-run after the configured prompt update", async () => {
    const fake = fakeAcpAgent({
      exitAfter: 1,
      prompt: {
        updates: [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "first" },
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "second" },
          },
        ],
      },
    });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    const session = await engine.create(createInput);
    const run = await session.send("hi");

    const events: AgentEvent[] = [];
    const streaming = (async () => {
      for await (const event of run.stream()) events.push(event);
    })();
    const result = await run.wait();
    await streaming;

    expect(result.status).toBe("error");
    expect(events).toEqual([{ type: "text_delta", text: "first" }]);
    await session.dispose();
  });

  it("fails create when the agent does not implement session/new", async () => {
    const fake = fakeAcpAgent({ methodNotFound: ["session/new"] });
    const engine = createEngine(ENGINES.devin, { connector: fake.connector });
    await expect(engine.create(createInput)).rejects.toThrow(
      /method not found/i,
    );
  });
});
