import { describe, expect, it } from "vitest";

import type { SunsetClient } from "@sunset/api";
import type {
  ExecutionPolicy,
  HostCapabilities,
  HostEvent,
  Run,
  Session,
} from "@sunset/domain";

import { attachRunNdjson, createSession, runExitCode } from "./commands.js";
import type { ResolvedConfig } from "./config.js";

const executionPolicy: ExecutionPolicy = {
  autoReview: false,
  sandbox: { enabled: false },
  agentRetries: true,
  toolAllowlist: null,
  toolDenylist: [],
};

const run: Run = {
  id: "r1",
  sessionId: "s1",
  status: "finished",
  createdAt: 1,
  startedAt: 1,
  finishedAt: 2,
};

const session: Session = {
  id: "s1",
  workspaceId: "w1",
  engine: "devin",
  location: "local",
  providerSessionId: "ps1",
  mode: "agent",
  model: { id: "m1", params: [] },
  executionPolicy,
  createdAt: 1,
};

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    stateDir: "/tmp/state",
    worktreeRoot: "/tmp/worktrees",
    configPath: "/tmp/config.json",
    configFound: false,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function events(count: number): HostEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "text_delta" as const,
    text: `chunk ${i + 1}`,
    workspaceId: "w1",
    sessionId: "s1",
    runId: "r1",
    sequence: i + 1,
  }));
}

function fakeClient(overrides: Partial<SunsetClient>): SunsetClient {
  return overrides as SunsetClient;
}

describe("attachRunNdjson", () => {
  it("writes each event as one NDJSON line and returns the final run", async () => {
    const stream = events(3);
    const calls: { runId: string; after?: number }[] = [];
    const client = fakeClient({
      attachRun: (runId, options) => {
        calls.push({ runId, after: options?.after });
        return (async function* () {
          for (const event of stream) yield event;
        })();
      },
      getRun: () => Promise.resolve(run),
    });

    const lines: string[] = [];
    const result = await attachRunNdjson(client, "r1", { after: 7 }, (line) =>
      lines.push(line),
    );

    expect(calls).toEqual([{ runId: "r1", after: 7 }]);
    // NDJSON framing: every line is exactly one self-contained JSON event.
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line))).toEqual(stream);
    expect(lines).toEqual(stream.map((event) => JSON.stringify(event)));
    expect(result).toEqual(run);
  });

  it("returns null when the run is gone after the stream ends", async () => {
    const client = fakeClient({
      attachRun: () =>
        (async function* () {
          yield* events(1);
        })(),
      getRun: () => Promise.resolve(null),
    });
    const lines: string[] = [];
    const result = await attachRunNdjson(client, "r1", {}, (line) =>
      lines.push(line),
    );
    expect(result).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("propagates stream failures after emitting buffered events", async () => {
    const client = fakeClient({
      attachRun: () =>
        (async function* (): AsyncGenerator<HostEvent> {
          yield events(1)[0]!;
          throw new Error("stream failed");
        })(),
      getRun: () => Promise.resolve(run),
    });
    const lines: string[] = [];
    await expect(
      attachRunNdjson(client, "r1", {}, (line) => lines.push(line)),
    ).rejects.toThrow("stream failed");
    expect(lines).toHaveLength(1);
  });
});

describe("createSession", () => {
  const capabilities: HostCapabilities = {
    engines: [
      {
        id: "codex",
        modes: ["agent", "plan"],
        models: [
          {
            id: "codex:gpt-6-astra",
            displayName: "GPT-6 Astra",
            aliases: ["astra"],
            parameters: [],
            variants: [
              {
                params: [{ id: "effort", value: "medium" }],
                isDefault: true,
              },
            ],
          },
        ],
        modelCatalog: { status: "live", fetchedAt: 0 },
        executionPolicy: { defaults: executionPolicy, controls: [] },
      },
    ],
  };

  it("sends prompt, engine, mode, and the catalog-resolved model", async () => {
    const requests: unknown[] = [];
    const client = fakeClient({
      capabilities: () => Promise.resolve(capabilities),
      createSession: (_workspaceId, input) => {
        requests.push(input);
        return Promise.resolve({ session, run });
      },
    });

    const result = await createSession(
      client,
      config({ defaultEngine: "codex", defaultModel: "astra" }),
      { workspaceId: "w1", prompt: "fix it", mode: "plan" },
    );

    expect(result).toEqual({ session, run });
    expect(requests).toEqual([
      {
        prompt: "fix it",
        engine: "codex",
        mode: "plan",
        model: {
          id: "codex:gpt-6-astra",
          params: [{ id: "effort", value: "medium" }],
        },
      },
    ]);
  });

  it("sends only the prompt when no defaults are configured", async () => {
    const requests: unknown[] = [];
    const client = fakeClient({
      capabilities: () => Promise.reject(new Error("should not be called")),
      createSession: (_workspaceId, input) => {
        requests.push(input);
        return Promise.resolve({ session, run });
      },
    });

    await createSession(client, config(), { workspaceId: "w1", prompt: "hi" });
    expect(requests).toEqual([{ prompt: "hi" }]);
  });

  it("falls back to the raw model id when the catalog lookup fails", async () => {
    const requests: unknown[] = [];
    const client = fakeClient({
      capabilities: () => Promise.reject(new Error("unreachable")),
      createSession: (_workspaceId, input) => {
        requests.push(input);
        return Promise.resolve({ session, run });
      },
    });

    await createSession(client, config({ defaultModel: "m-custom" }), {
      workspaceId: "w1",
      prompt: "hi",
    });
    expect(requests).toEqual([
      { prompt: "hi", model: { id: "m-custom", params: [] } },
    ]);
  });
});

describe("runExitCode", () => {
  it("is 0 only for finished runs", () => {
    expect(runExitCode("finished")).toBe(0);
    expect(runExitCode("error")).toBe(1);
    expect(runExitCode("cancelled")).toBe(1);
    expect(runExitCode("running")).toBe(1);
    expect(runExitCode("missing")).toBe(1);
  });
});
