import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createEngine,
  ENGINES,
  stdioConnector,
  type AcpConnector,
  type Engine,
} from "@sunset/acp";
import {
  createClient,
  type HostEvent,
  type Run,
  type SunsetClient,
} from "@sunset/api";
import type { EngineId, ModelCapability } from "@sunset/domain";
import { createHost, type Host } from "@sunset/host";
import { createSunsetServer, type SunsetServer } from "@sunset/server";
import {
  fakeAcpAgent,
  fakeAgentSpawn,
  type FakeAcpSpawnOptions,
} from "@sunset/testing";

import { createE2eFixture, type E2eFixture } from "./fixture.js";

const FAKE_CATALOG: ModelCapability[] = [
  {
    id: "fake-model",
    displayName: "Fake Model",
    aliases: [],
    parameters: [],
    variants: [{ params: [], displayName: "Fake", isDefault: true }],
  },
];

const textChunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text },
});

/**
 * A real `createEngine` ACP runtime over an injected connector, with the
 * model catalog stubbed so no engine CLI is probed.
 */
function fakeEngine(
  connector: AcpConnector,
  definition = ENGINES.devin,
): Engine {
  const engine = createEngine(definition, { connector });
  return { ...engine, listModels: () => Promise.resolve(FAKE_CATALOG) };
}

type Boot = {
  fixture: E2eFixture;
  host: Host;
  server: SunsetServer;
  client: SunsetClient;
};

async function boot(
  engines: Partial<Record<EngineId, Engine>>,
  fixture?: E2eFixture,
): Promise<Boot> {
  const fx = fixture ?? (await createE2eFixture());
  const host = await createHost({
    stateDir: fx.stateDir,
    worktreeRoot: fx.worktreeRoot,
    engines,
  });
  const server = await createSunsetServer({ host });
  const client = createClient({ baseUrl: server.url, token: server.token });
  return { fixture: fx, host, server, client };
}

async function shutdown(target: Boot): Promise<void> {
  await target.server.close();
  await target.host.close();
  await target.fixture.cleanup();
}

async function collect(
  client: SunsetClient,
  runId: string,
  after = 0,
): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  for await (const event of client.attachRun(runId, { after })) {
    events.push(event);
  }
  return events;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRunStatus(
  client: SunsetClient,
  runId: string,
  status: Run["status"],
): Promise<Run> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const run = await client.getRun(runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    if (run.status === status) return run;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} stuck at ${run.status}, wanted ${status}`);
    }
    await sleep(25);
  }
}

describe("conductor loop over HTTP/WS with a fake ACP agent", () => {
  it("creates a worktree, streams ordered events, and the agent edits a file", async () => {
    const fake = fakeAcpAgent({
      writes: { "agent/result.txt": "written by the fake agent\n" },
      prompt: {
        updates: [
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "planning" },
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "Write file",
            name: "write",
            status: "in_progress",
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "completed",
            rawOutput: "ok",
          },
          textChunk("done"),
        ],
      },
    });
    const target = await boot({ devin: fakeEngine(fake.connector) });
    const { client, fixture } = target;
    try {
      const project = await client.addProject(fixture.repo);
      const workspace = await client.createWorkspace(project.id, {
        slug: "agent-run",
      });
      expect(workspace.worktreePath).toBe(
        path.join(fixture.worktreeRoot, "agent-run"),
      );
      await access(path.join(workspace.worktreePath, "README.md"));

      const { session, run } = await client.createSession(workspace.id, {
        prompt: "write a file",
      });
      const events = await collect(client, run.id);
      const result = await client.waitRun(run.id);

      expect(result.status).toBe("finished");
      expect(result.result).toBe("done");
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
      expect(events.map((event) => event.type)).toEqual([
        "thought_delta",
        "tool_call",
        "tool_result",
        "text_delta",
      ]);
      for (const event of events) {
        expect(event.runId).toBe(run.id);
        expect(event.sessionId).toBe(session.id);
        expect(event.workspaceId).toBe(workspace.id);
      }
      expect(
        await readFile(
          path.join(workspace.worktreePath, "agent/result.txt"),
          "utf8",
        ),
      ).toBe("written by the fake agent\n");
      // The ACP session was opened against the worktree, not the repo.
      expect(
        fake.calls.find((call) => call.method === "session/new")?.params,
      ).toMatchObject({ cwd: workspace.worktreePath });

      // A follow-up prompt reuses the same engine session.
      const followUp = await client.send(session.id, "again");
      const followUpEvents = await collect(client, followUp.run.id);
      expect((await client.waitRun(followUp.run.id)).status).toBe("finished");
      expect(followUpEvents.map((event) => event.type)).toEqual([
        "thought_delta",
        "tool_call",
        "tool_result",
        "text_delta",
      ]);
      expect(
        fake.calls.filter((call) => call.method === "session/prompt"),
      ).toHaveLength(2);
      expect(await client.listRuns(session.id)).toHaveLength(2);
    } finally {
      await shutdown(target);
    }
  });

  it("cancels a running turn and replays the partial stream", async () => {
    const fake = fakeAcpAgent({
      prompt: {
        waitForCancel: true,
        updates: [textChunk("partial")],
      },
      writes: { "should-not-exist.txt": "cancelled turns write nothing\n" },
    });
    const target = await boot({ devin: fakeEngine(fake.connector) });
    const { client } = target;
    try {
      const project = await client.addProject(target.fixture.repo);
      const workspace = await client.createWorkspace(project.id, {
        slug: "cancel-run",
      });
      const { run } = await client.createSession(workspace.id, {
        prompt: "hang",
      });

      await waitForRunStatus(client, run.id, "running");
      const result = await client.cancelRun(run.id);
      expect(result.status).toBe("cancelled");

      const events = await collect(client, run.id);
      expect(events.map((event) => event.type)).toEqual(["text_delta"]);
      expect(fake.calls.some((call) => call.method === "session/cancel")).toBe(
        true,
      );
      await expect(
        access(path.join(workspace.worktreePath, "should-not-exist.txt")),
      ).rejects.toThrow();
    } finally {
      await shutdown(target);
    }
  });

  it("replays persisted run events after a host restart", async () => {
    const fixture = await createE2eFixture();
    const first = await boot(
      {
        devin: fakeEngine(
          fakeAcpAgent({
            writes: { "result.txt": "persisted\n" },
            prompt: {
              updates: [textChunk("one"), textChunk("two")],
            },
          }).connector,
        ),
      },
      fixture,
    );
    let runId: string;
    let live: HostEvent[];
    try {
      const project = await first.client.addProject(fixture.repo);
      const workspace = await first.client.createWorkspace(project.id, {
        slug: "restart",
      });
      const { run } = await first.client.createSession(workspace.id, {
        prompt: "work",
      });
      runId = run.id;
      live = await collect(first.client, run.id);
      expect((await first.client.waitRun(run.id)).status).toBe("finished");
    } finally {
      await first.server.close();
      await first.host.close();
    }

    // A second host on the same state dir replays the persisted log; the run
    // is terminal so no engine is resumed.
    const second = await boot(
      { devin: fakeEngine(fakeAcpAgent().connector) },
      fixture,
    );
    try {
      const replayed = await collect(second.client, runId);
      expect(replayed).toEqual(live);

      const after = live[0]!.sequence;
      const tail = await collect(second.client, runId, after);
      expect(tail).toEqual(live.slice(1));
    } finally {
      await shutdown(second);
    }
  });

  it("drives the fake agent as a spawned stdio child process", async () => {
    const spawnOptions: FakeAcpSpawnOptions = {
      writes: { "spawned.txt": "from the child process\n" },
      prompt: { updates: [textChunk("spawned reply")] },
    };
    const hanging: FakeAcpSpawnOptions = {
      prompt: { waitForCancel: true, updates: [textChunk("hanging")] },
    };
    const target = await boot({
      devin: fakeEngine(stdioConnector(fakeAgentSpawn(spawnOptions))),
      codex: fakeEngine(stdioConnector(fakeAgentSpawn(hanging)), ENGINES.codex),
    });
    const { client } = target;
    try {
      const project = await client.addProject(target.fixture.repo);
      const workspace = await client.createWorkspace(project.id, {
        slug: "spawned",
      });
      const { session, run } = await client.createSession(workspace.id, {
        prompt: "write a file",
      });
      const events = await collect(client, run.id);
      expect((await client.waitRun(run.id)).status).toBe("finished");
      expect(events.map((event) => event.type)).toEqual(["text_delta"]);
      expect(
        await readFile(
          path.join(workspace.worktreePath, "spawned.txt"),
          "utf8",
        ),
      ).toBe("from the child process\n");

      // A second prompt reuses the pooled child process.
      const followUp = await client.send(session.id, "again");
      expect((await client.waitRun(followUp.run.id)).status).toBe("finished");
      expect(await client.listRuns(session.id)).toHaveLength(2);

      // Cancellation crosses the real pipe: session/cancel reaches the child.
      const hangingSession = await client.createSession(workspace.id, {
        engine: "codex",
        prompt: "hang",
      });
      await waitForRunStatus(client, hangingSession.run.id, "running");
      expect((await client.cancelRun(hangingSession.run.id)).status).toBe(
        "cancelled",
      );
      const partial = await collect(client, hangingSession.run.id);
      expect(partial.map((event) => event.type)).toEqual(["text_delta"]);
    } finally {
      await shutdown(target);
    }
  });
});
