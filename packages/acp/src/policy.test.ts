import { describe, expect, it } from "vitest";

import {
  agent as acpAgent,
  client as acpClient,
  RequestError,
  type AgentApp,
  type AgentConnection,
  type AgentRequestHandler,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_EXECUTION_POLICY,
  type AgentMode,
  type ExecutionPolicy,
} from "@sunset/domain";

import { createEngine } from "./runtime.js";
import type { AcpConnector } from "./client.js";
import { ENGINES } from "./engines.js";

type Call = { method: string; params: unknown };
type PromptCtx = Parameters<
  AgentRequestHandler<PromptRequest, PromptResponse>
>[0];

const CODEX_MODES = ["read-only", "agent", "agent-full-access"];

function codexModeConfigOption(
  values: string[] = CODEX_MODES,
): SessionConfigOption {
  return {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: "agent",
    options: values.map((value) => ({ value, name: value })),
  };
}

function modeState(ids: string[] = CODEX_MODES): SessionModeState {
  return {
    currentModeId: "agent",
    availableModes: ids.map((id) => ({ id, name: id })),
  };
}

type AgentControls = {
  calls: Call[];
  connection: { ref: AgentConnection | null };
  waitForCancel: (sessionId: string) => Promise<void>;
};

function newControls(): AgentControls {
  return {
    calls: [],
    connection: { ref: null },
    waitForCancel: () => Promise.resolve(),
  };
}

function callsFor(calls: Call[], method: string): Call[] {
  return calls.filter((call) => call.method === method);
}

function policyAgent(options: {
  controls: AgentControls;
  sessionNew?: Omit<NewSessionResponse, "sessionId">;
  sessionResume?: ResumeSessionResponse;
  loadSession?: boolean;
  /** These methods throw an internal error after being recorded. */
  failOn?: string[];
  prompt?: (
    ctx: PromptCtx,
    controls: AgentControls,
  ) => PromptResponse | Promise<PromptResponse>;
}): () => AgentApp {
  return () => {
    const cancelled = new Set<string>();
    const waiters = new Map<string, Array<() => void>>();
    options.controls.waitForCancel = (sessionId) =>
      new Promise<void>((resolve) => {
        if (cancelled.has(sessionId)) return resolve();
        const list = waiters.get(sessionId) ?? [];
        list.push(resolve);
        waiters.set(sessionId, list);
      });

    const app = acpAgent({ name: "policy-fake" });
    app.onConnect((conn) => {
      options.controls.connection.ref = conn;
    });
    app.onRequest("initialize", () => ({
      protocolVersion: 1,
      agentCapabilities: options.loadSession ? { loadSession: true } : {},
      authMethods: [],
    }));
    app.onRequest("session/new", (ctx) => {
      options.controls.calls.push({
        method: "session/new",
        params: ctx.params,
      });
      return { sessionId: "s1", ...options.sessionNew };
    });
    app.onRequest("session/resume", (ctx) => {
      options.controls.calls.push({
        method: "session/resume",
        params: ctx.params,
      });
      return { ...options.sessionResume };
    });
    app.onRequest("session/load", (ctx) => {
      options.controls.calls.push({
        method: "session/load",
        params: ctx.params,
      });
      return {};
    });
    app.onRequest("session/set_mode", (ctx) => {
      options.controls.calls.push({
        method: "session/set_mode",
        params: ctx.params,
      });
      if (options.failOn?.includes("session/set_mode")) {
        throw RequestError.internalError(undefined, "set_mode rejected");
      }
      return {};
    });
    app.onRequest("session/set_config_option", (ctx) => {
      options.controls.calls.push({
        method: "session/set_config_option",
        params: ctx.params,
      });
      if (options.failOn?.includes("session/set_config_option")) {
        throw RequestError.internalError(
          undefined,
          "set_config_option rejected",
        );
      }
      return { configOptions: [] };
    });
    app.onRequest("session/prompt", async (ctx) => {
      options.controls.calls.push({
        method: "session/prompt",
        params: ctx.params,
      });
      if (options.prompt) return options.prompt(ctx, options.controls);
      return { stopReason: "end_turn" };
    });
    app.onNotification("session/cancel", (ctx) => {
      options.controls.calls.push({
        method: "session/cancel",
        params: ctx.params,
      });
      cancelled.add(ctx.params.sessionId);
      for (const wake of waiters.get(ctx.params.sessionId) ?? []) wake();
      waiters.delete(ctx.params.sessionId);
    });
    return app;
  };
}

function inProcessConnector(build: () => AgentApp): AcpConnector {
  return async ({ onUpdate, onPermission, onClose }) => {
    const app = acpClient({ name: "sunset-test" });
    app.onNotification("session/update", (ctx) => {
      onUpdate(ctx.params.sessionId, ctx.params.update);
    });
    app.onRequest("session/request_permission", (ctx) =>
      onPermission(ctx.params),
    );
    const conn = app.connect(build());
    conn.closed.then(
      () => onClose(null),
      (error) => onClose(error),
    );
    return {
      request: conn.agent.request.bind(conn.agent),
      notify: conn.agent.notify.bind(conn.agent),
      close: () => conn.close(),
    };
  };
}

/** Counts client-side requests per method, even ones the agent never sees. */
function countingConnector(
  build: () => AgentApp,
  counts: Map<string, number>,
): AcpConnector {
  const base = inProcessConnector(build);
  return async (input) => {
    const handle = await base(input);
    const request = handle.request;
    return {
      ...handle,
      request: ((method: string, params?: unknown) => {
        counts.set(method, (counts.get(method) ?? 0) + 1);
        return request(method, params);
      }) as typeof handle.request,
    };
  };
}

/** Counts transport closes issued by the runtime. */
function closeCountingConnector(
  build: () => AgentApp,
  state: { closes: number },
): AcpConnector {
  const base = inProcessConnector(build);
  return async (input) => {
    const handle = await base(input);
    return {
      ...handle,
      close: () => {
        state.closes += 1;
        handle.close();
      },
    };
  };
}

function engineFor(connector: AcpConnector) {
  return createEngine(ENGINES.codex, { connector });
}

function create(
  build: () => AgentApp,
  executionPolicy?: ExecutionPolicy,
  mode?: AgentMode,
) {
  const engine = engineFor(inProcessConnector(build));
  return engine.create({
    cwd: "/tmp",
    model: { id: "", params: [] },
    ...(mode ? { mode } : {}),
    ...(executionPolicy ? { executionPolicy } : {}),
  });
}

describe("execution policy → engine mode", () => {
  it("maps sandbox.enabled to read-only via the advertised mode config option", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: { configOptions: [codexModeConfigOption()] },
      }),
      {
        ...DEFAULT_EXECUTION_POLICY,
        autoReview: true,
        sandbox: { enabled: true },
      },
    );
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([
      {
        method: "session/set_config_option",
        params: { sessionId: "s1", configId: "mode", value: "read-only" },
      },
    ]);
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([]);
    await session.dispose();
  });

  it("maps autoReview to agent when the sandbox is off", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: { configOptions: [codexModeConfigOption()] },
      }),
      { ...DEFAULT_EXECUTION_POLICY, autoReview: true },
    );
    expect(
      callsFor(controls.calls, "session/set_config_option").map(
        (call) => (call.params as { value: string }).value,
      ),
    ).toEqual(["agent"]);
    await session.dispose();
  });

  it("maps the default policy to agent-full-access", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: { configOptions: [codexModeConfigOption()] },
      }),
      DEFAULT_EXECUTION_POLICY,
    );
    expect(
      callsFor(controls.calls, "session/set_config_option").map(
        (call) => (call.params as { value: string }).value,
      ),
    ).toEqual(["agent-full-access"]);
    await session.dispose();
  });

  it("finds grouped select values on the mode config option", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: {
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              type: "select",
              currentValue: "agent",
              options: [
                {
                  group: "modes",
                  name: "Modes",
                  options: [{ value: "read-only", name: "Read-only" }],
                },
              ],
            },
          ],
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, sandbox: { enabled: true } },
    );
    expect(
      callsFor(controls.calls, "session/set_config_option").map(
        (call) => (call.params as { value: string }).value,
      ),
    ).toEqual(["read-only"]);
    await session.dispose();
  });

  it("falls back to session/set_mode when no mode config option is advertised", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({ controls, sessionNew: { modes: modeState() } }),
      { ...DEFAULT_EXECUTION_POLICY, sandbox: { enabled: true } },
    );
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([]);
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([
      {
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: "read-only" },
      },
    ]);
    await session.dispose();
  });

  it("skips a non-select mode option and still uses the advertised set_mode fallback", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: {
          modes: modeState(),
          configOptions: [
            { id: "mode", name: "Mode", type: "boolean", currentValue: true },
          ],
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, autoReview: true },
    );
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([]);
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([
      {
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: "agent" },
      },
    ]);
    await session.dispose();
  });

  it("uses set_mode when the config option does not advertise the desired value", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: {
          modes: modeState(),
          configOptions: [
            codexModeConfigOption(["agent", "agent-full-access"]),
          ],
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, sandbox: { enabled: true } },
    );
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([]);
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([
      {
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: "read-only" },
      },
    ]);
    await session.dispose();
  });

  it("sends no mode request when neither surface advertises the target", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: {
          modes: modeState(["agent"]),
          configOptions: [
            {
              id: "other",
              name: "Other",
              type: "select",
              currentValue: "x",
              options: [{ value: "agent-full-access", name: "Full" }],
            },
          ],
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, sandbox: { enabled: true } },
    );
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([]);
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([]);
    await session.dispose();
  });

  it("applies the policy mode on a resumed session", async () => {
    const controls = newControls();
    const engine = engineFor(
      inProcessConnector(
        policyAgent({
          controls,
          loadSession: true,
          sessionResume: { configOptions: [codexModeConfigOption()] },
        }),
      ),
    );
    const session = await engine.resume({
      cwd: "/tmp",
      model: { id: "", params: [] },
      providerSessionId: "resume-1",
      executionPolicy: { ...DEFAULT_EXECUTION_POLICY, autoReview: true },
    });
    expect(callsFor(controls.calls, "session/resume")).toHaveLength(1);
    expect(
      callsFor(controls.calls, "session/set_config_option").map(
        (call) => (call.params as { value: string }).value,
      ),
    ).toEqual(["agent"]);
    await session.dispose();
  });

  it("keeps an explicit plan mode request ahead of the policy mapping", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: {
          modes: modeState(["plan", ...CODEX_MODES]),
          configOptions: [codexModeConfigOption()],
        },
      }),
      DEFAULT_EXECUTION_POLICY,
      "plan",
    );
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([
      {
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: "plan" },
      },
    ]);
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([]);
    await session.dispose();
  });

  it("never lands an unhonored plan request in agent-full-access", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        sessionNew: {
          modes: modeState(["agent", "agent-full-access"]),
          configOptions: [codexModeConfigOption()],
        },
      }),
      DEFAULT_EXECUTION_POLICY,
      "plan",
    );
    // No plan-capable mode is advertised, so the policy applies — clamped to
    // agent rather than the policy's agent-full-access target.
    expect(
      callsFor(controls.calls, "session/set_config_option").map(
        (call) => (call.params as { value: string }).value,
      ),
    ).toEqual(["agent"]);
    await session.dispose();
  });

  it("tries session/set_mode when the config-option write is rejected", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        failOn: ["session/set_config_option"],
        sessionNew: {
          modes: modeState(),
          configOptions: [codexModeConfigOption()],
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, sandbox: { enabled: true } },
    );
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([
      {
        method: "session/set_config_option",
        params: { sessionId: "s1", configId: "mode", value: "read-only" },
      },
    ]);
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([
      {
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: "read-only" },
      },
    ]);
    await session.dispose();
  });

  it("fails closed when every advertised surface rejects the policy mode", async () => {
    const controls = newControls();
    const state = { closes: 0 };
    const build = policyAgent({
      controls,
      failOn: ["session/set_config_option", "session/set_mode"],
      sessionNew: {
        modes: modeState(),
        configOptions: [codexModeConfigOption()],
      },
    });
    const engine = createEngine(ENGINES.codex, {
      connector: closeCountingConnector(build, state),
    });
    await expect(
      engine.create({
        cwd: "/tmp",
        model: { id: "", params: [] },
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          sandbox: { enabled: true },
        },
      }),
    ).rejects.toThrow("policy_mode_unapplied:read-only");
    expect(state.closes).toBe(1);
  });

  it("falls back to the clamped policy mode when a plan set_mode is rejected", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        failOn: ["session/set_mode"],
        sessionNew: {
          modes: modeState(["plan", ...CODEX_MODES]),
          configOptions: [codexModeConfigOption()],
        },
      }),
      DEFAULT_EXECUTION_POLICY,
      "plan",
    );
    expect(callsFor(controls.calls, "session/set_mode")).toEqual([
      {
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: "plan" },
      },
    ]);
    // Plan could not be applied, so the policy runs — clamped to agent.
    expect(callsFor(controls.calls, "session/set_config_option")).toEqual([
      {
        method: "session/set_config_option",
        params: { sessionId: "s1", configId: "mode", value: "agent" },
      },
    ]);
    await session.dispose();
  });
});

describe("session/prompt retries", () => {
  it("retries a rejected prompt once on the live session", async () => {
    const controls = newControls();
    let attempts = 0;
    const session = await create(
      policyAgent({
        controls,
        prompt: () => {
          attempts += 1;
          if (attempts === 1) {
            throw RequestError.internalError(undefined, "transient blip");
          }
          return { stopReason: "end_turn" };
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, agentRetries: true },
    );
    const run = await session.send("hi");
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(attempts).toBe(2);
    await session.dispose();
  });

  it("does not retry when agentRetries is off", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        prompt: () => {
          throw RequestError.internalError(undefined, "always fails");
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, agentRetries: false },
    );
    const run = await session.send("hi");
    const result = await run.wait();
    expect(result.status).toBe("error");
    expect(callsFor(controls.calls, "session/prompt")).toHaveLength(1);
    await session.dispose();
  });

  it("stops after a single retry", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        prompt: () => {
          throw RequestError.internalError(undefined, "always fails");
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, agentRetries: true },
    );
    const run = await session.send("hi");
    const result = await run.wait();
    expect(result.status).toBe("error");
    expect(callsFor(controls.calls, "session/prompt")).toHaveLength(2);
    await session.dispose();
  });

  it("never retries a cancelled response", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        prompt: async (ctx, c) => {
          await c.waitForCancel(ctx.params.sessionId);
          return { stopReason: "cancelled" };
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, agentRetries: true },
    );
    const run = await session.send("hi");
    await run.cancel();
    const result = await run.wait();
    expect(result.status).toBe("cancelled");
    expect(callsFor(controls.calls, "session/prompt")).toHaveLength(1);
    await session.dispose();
  });

  it("does not retry a prompt rejected after cancellation", async () => {
    const controls = newControls();
    const session = await create(
      policyAgent({
        controls,
        prompt: async (ctx, c) => {
          await c.waitForCancel(ctx.params.sessionId);
          throw RequestError.internalError(undefined, "cancelled turn");
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, agentRetries: true },
    );
    const run = await session.send("hi");
    await run.cancel();
    const result = await run.wait();
    expect(result.status).toBe("error");
    expect(callsFor(controls.calls, "session/prompt")).toHaveLength(1);
    await session.dispose();
  });

  it("does not retry on a dead connection", async () => {
    const controls = newControls();
    const counts = new Map<string, number>();
    const build = policyAgent({
      controls,
      prompt: async (ctx, c) => {
        c.connection.ref?.close(new Error("agent_died"));
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return { stopReason: "end_turn" };
      },
    });
    const engine = createEngine(ENGINES.codex, {
      connector: countingConnector(build, counts),
    });
    const session = await engine.create({
      cwd: "/tmp",
      model: { id: "", params: [] },
      executionPolicy: { ...DEFAULT_EXECUTION_POLICY, agentRetries: true },
    });
    const run = await session.send("hi");
    const result = await run.wait();
    expect(result.status).toBe("error");
    expect(counts.get("session/prompt")).toBe(1);
    await session.dispose();
  });
});

describe("permission policy", () => {
  const permissionParams = (
    name: string,
  ): Omit<RequestPermissionRequest, "sessionId"> => ({
    toolCall: { toolCallId: `t-${name}`, name },
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
    ],
  });

  it("cancels a denylisted tool before the allowed permission path", async () => {
    const controls = newControls();
    const outcomes: RequestPermissionResponse[] = [];
    const session = await create(
      policyAgent({
        controls,
        prompt: async (ctx) => {
          for (const tool of ["bash", "read"]) {
            outcomes.push(
              await ctx.client.request("session/request_permission", {
                sessionId: ctx.params.sessionId,
                ...permissionParams(tool),
              }),
            );
          }
          return { stopReason: "end_turn" };
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, toolDenylist: ["bash"] },
    );
    const run = await session.send("go");
    const result = await run.wait();
    expect(result.status).toBe("finished");
    // The denylisted bash call is cancelled even though allow_always was
    // offered first in preference order; the permitted read call still picks
    // allow_always over the earlier allow_once.
    expect(outcomes).toEqual([
      { outcome: { outcome: "cancelled" } },
      { outcome: { outcome: "selected", optionId: "always" } },
    ]);
    await session.dispose();
  });

  it("keeps allowlist enforcement alongside the denylist", async () => {
    const controls = newControls();
    const outcomes: RequestPermissionResponse[] = [];
    const session = await create(
      policyAgent({
        controls,
        prompt: async (ctx) => {
          for (const tool of ["read", "bash"]) {
            outcomes.push(
              await ctx.client.request("session/request_permission", {
                sessionId: ctx.params.sessionId,
                ...permissionParams(tool),
              }),
            );
          }
          return { stopReason: "end_turn" };
        },
      }),
      { ...DEFAULT_EXECUTION_POLICY, toolAllowlist: ["read"] },
    );
    const run = await session.send("go");
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(outcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "always" } },
      { outcome: { outcome: "cancelled" } },
    ]);
    await session.dispose();
  });
});
