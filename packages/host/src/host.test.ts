import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentEvent,
  EngineId,
  ModelCapability,
  RunResult,
} from "@sunset/domain";
import type {
  CreateEngineInput,
  Engine,
  EngineRun,
  EngineSessionHandle,
} from "@sunset/acp";

import { createHost } from "./create-host.js";
import { HostError } from "./errors.js";
import type { HostEvent } from "./types.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `sunset-host-${name}-`));
  temps.push(dir);
  return realpath(dir);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function setEnv(name: string, value: string): () => void {
  const prior = process.env[name];
  process.env[name] = value;
  return () => {
    if (prior === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prior;
    }
  };
}

async function initRepo(): Promise<string> {
  const parent = await tempDir("repo");
  const repo = path.join(parent, "repo");
  await mkdir(repo);
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "sunset@example.com"], {
    cwd: repo,
  });
  await execa("git", ["config", "user.name", "Sunset"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "sunset\n");
  await execa("git", ["add", "README.md"], { cwd: repo });
  await execa("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

const FAKE_CATALOG: ModelCapability[] = [
  {
    id: "fake-model",
    displayName: "Fake Model",
    aliases: ["fake"],
    parameters: [
      {
        id: "effort",
        values: [{ value: "low" }, { value: "medium", displayName: "Medium" }],
      },
    ],
    variants: [
      {
        displayName: "Default",
        params: [{ id: "effort", value: "medium" }],
        isDefault: true,
      },
    ],
  },
];

type FakeRunScript = {
  events?: AgentEvent[];
  result?: RunResult["status"];
  resultText?: string;
  hang?: boolean;
};

function fakeEngine(
  scripts: FakeRunScript[] = [{ events: [{ type: "text_delta", text: "hi" }] }],
) {
  const state = {
    creates: [] as CreateEngineInput[],
    resumes: [] as string[],
    scripts: [...scripts],
  };

  function run(script: FakeRunScript): EngineRun {
    const runId = `fake-run-${Math.random().toString(36).slice(2)}`;
    const events = script.events ?? [];
    let cancelled = false;
    const waitPromise = new Promise<RunResult>((resolve) => {
      queueMicrotask(() => {
        if (script.hang) return;
        resolve({
          runId,
          status: script.result ?? "finished",
          ...(script.resultText ? { result: script.resultText } : {}),
        });
      });
    });
    return {
      runId,
      async *stream(): AsyncIterable<AgentEvent> {
        for (const event of events) {
          if (cancelled) return;
          yield event;
        }
        if (script.hang) {
          await new Promise<void>((resolve) => {
            const check = () => (cancelled ? resolve() : setTimeout(check, 5));
            check();
          });
        }
      },
      async wait() {
        return cancelled
          ? { runId, status: "cancelled" as const }
          : waitPromise;
      },
      async cancel() {
        cancelled = true;
      },
    };
  }

  function handle(id: string): EngineSessionHandle {
    return {
      providerSessionId: id,
      async send() {
        const script = state.scripts.shift() ?? {};
        return run(script);
      },
      async dispose() {},
    };
  }

  const engine: Engine = {
    id: "devin" as EngineId,
    async listModels() {
      return FAKE_CATALOG;
    },
    supportedModes: () => ["agent"],
    async create(input) {
      state.creates.push(input);
      return handle(`fake-provider-${state.creates.length}`);
    },
    async resume(input) {
      state.resumes.push(input.providerSessionId);
      return handle(input.providerSessionId);
    },
  };
  return { engine, state };
}

async function setup(engineOverride?: Engine) {
  const root = await tempDir("state");
  const stateDir = path.join(root, "state");
  const worktreeRoot = path.join(root, "worktrees");
  const repo = await initRepo();
  const { engine, state } = fakeEngine();
  const host = await createHost({
    stateDir,
    worktreeRoot,
    engines: { devin: engineOverride ?? engine },
  });
  return {
    host,
    stateDir,
    worktreeRoot,
    repo,
    engine: engineOverride ?? engine,
    engineState: state,
  };
}

describe("createHost", () => {
  it("registers and lists projects", async () => {
    const { host, repo } = await setup();
    const project = await host.projects.register(repo);
    expect(project.repoRoot).toBe(repo);
    const again = await host.projects.register(repo);
    expect(again.id).toBe(project.id);
    expect(host.projects.list()).toHaveLength(1);
    await host.close();
  });

  it("creates a workspace worktree and session, runs to completion, and persists events", async () => {
    const { host, repo } = await setup();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "feat",
    });
    expect(workspace.branch).toBe("sunset/feat");

    const { session, run } = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "hello",
    });
    expect(session.engine).toBe("devin");
    expect(session.location).toBe("local");
    expect(session.providerSessionId).toBe("fake-provider-1");

    const result = await host.runs.wait({ runId: run.id });
    expect(result.status).toBe("finished");

    const events: string[] = [];
    for await (const event of host.runs.attach({ runId: run.id })) {
      events.push(event.type);
    }
    expect(events).toContain("text_delta");
    await host.close();
  }, 15_000);

  it("serializes queued sends per session", async () => {
    const root = await tempDir("state");
    const { engine } = fakeEngine([
      { events: [{ type: "text_delta", text: "one" }] },
      { events: [{ type: "text_delta", text: "two" }] },
    ]);
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "worktrees"),
      engines: { devin: engine },
    });
    const repo = await initRepo();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "queued",
    });
    const { session, run } = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "first",
    });
    const second = await host.sessions.send({
      sessionId: session.id,
      prompt: "second",
    });
    await host.runs.wait({ runId: run.id });
    const secondResult = await host.runs.wait({ runId: second.run.id });
    expect(secondResult.status).toBe("finished");
    expect(host.runs.list({ sessionId: session.id })).toHaveLength(2);
    await host.close();
  });

  it("cancels a queued run before dispatch", async () => {
    const { host, repo } = await setup();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "cancel",
    });
    const { session, run } = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "first",
    });
    await host.runs.wait({ runId: run.id });
    const queued = await host.sessions.send({
      sessionId: session.id,
      prompt: "second",
    });
    const result = await host.runs.cancel({ runId: queued.run.id });
    expect(result.status === "cancelled" || result.status === "finished").toBe(
      true,
    );
    await host.close();
  });

  it("resumes sessions by providerSessionId after restart and fails in-flight runs", async () => {
    const root = await tempDir("state");
    const repo = await initRepo();
    const first = fakeEngine();
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "worktrees"),
      engines: { devin: first.engine },
    });
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "restart",
    });
    const { session, run } = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "hello",
    });
    await host.runs.wait({ runId: run.id });
    await host.suspend();

    const second = fakeEngine();
    const host2 = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "worktrees"),
      engines: { devin: second.engine },
    });
    const resumed = host2.sessions.get(session.id);
    expect(resumed?.providerSessionId).toBe("fake-provider-1");

    const next = await host2.sessions.send({
      sessionId: session.id,
      prompt: "again",
    });
    const result = await host2.runs.wait({ runId: next.run.id });
    expect(result.status).toBe("finished");
    expect(second.state.resumes).toEqual(["fake-provider-1"]);
    await host2.close();
  });

  it("rejects cloud sessions until the cloud engine is available", async () => {
    const { host, repo } = await setup();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "cloud",
    });
    await expect(
      host.sessions.create({
        workspaceId: workspace.id,
        location: "cloud",
        prompt: "hi",
      }),
    ).rejects.toMatchObject({ code: "cloud_unavailable" });
    await host.close();
  });

  it("rejects unknown engines and unsupported modes", async () => {
    const { host, repo } = await setup();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "bad",
    });
    await expect(
      host.sessions.create({
        workspaceId: workspace.id,
        engine: "bogus" as EngineId,
        prompt: "hi",
      }),
    ).rejects.toMatchObject({ code: "invalid_engine" });
    await expect(
      host.sessions.create({
        workspaceId: workspace.id,
        mode: "plan",
        prompt: "hi",
      }),
    ).rejects.toMatchObject({ code: "mode_unsupported" });
    await host.close();
  });

  it("reports capabilities for both engines with a cached devin fallback", async () => {
    const { host } = await setup();
    const capabilities = await host.capabilities();
    const devin = capabilities.engines.find((entry) => entry.id === "devin");
    expect(devin?.models[0]?.id).toBe("fake-model");
    expect(devin?.modelCatalog.status).toBe("live");
    await host.close();
  });

  it("archives a workspace, cancels its runs, and keeps the branch", async () => {
    const root = await tempDir("state");
    const { engine } = fakeEngine([{ hang: true, events: [] }]);
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "worktrees"),
      engines: { devin: engine },
    });
    const repo = await initRepo();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "archive",
    });
    const { run } = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "work",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const archived = await host.workspaces.archive({
      workspaceId: workspace.id,
      keepBranch: true,
    });
    expect(archived.archivedAt).not.toBeNull();
    const result = await host.runs.wait({ runId: run.id });
    expect(result.status).toBe("cancelled");
    await host.close();
  });

  it("throws HostError with codes for unknown ids", async () => {
    const { host } = await setup();
    expect(host.projects.get("nope")).toBeUndefined();
    expect(host.sessions.get("nope")).toBeUndefined();
    try {
      host.runs.list({ sessionId: "nope" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HostError);
      expect((error as HostError).code).toBe("unknown_session");
    }
    await host.close();
  });

  it("prunes events for runs finished beyond the retention window on startup", async () => {
    const root = await tempDir("state");
    const stateDir = path.join(root, "state");
    const worktreeRoot = path.join(root, "worktrees");
    const first = fakeEngine([
      { events: [{ type: "text_delta", text: "old" }] },
      { events: [{ type: "text_delta", text: "recent" }] },
    ]);
    const host = await createHost({
      stateDir,
      worktreeRoot,
      engines: { devin: first.engine },
    });
    const repo = await initRepo();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "retention",
    });
    const { session, run: oldRun } = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "first",
    });
    const recent = await host.sessions.send({
      sessionId: session.id,
      prompt: "second",
    });
    await host.runs.wait({ runId: oldRun.id });
    await host.runs.wait({ runId: recent.run.id });
    await host.close();

    const database = new Database(path.join(stateDir, "sunset.sqlite"));
    try {
      database
        .prepare("UPDATE runs SET finished_at = ? WHERE id = ?")
        .run(Date.now() - 31 * 24 * 60 * 60 * 1_000, oldRun.id);
    } finally {
      database.close();
    }

    const host2 = await createHost({
      stateDir,
      worktreeRoot,
      engines: { devin: fakeEngine().engine },
    });
    const oldEvents: HostEvent[] = [];
    for await (const event of host2.runs.attach({ runId: oldRun.id })) {
      oldEvents.push(event);
    }
    expect(oldEvents).toHaveLength(0);
    const recentEvents: HostEvent[] = [];
    for await (const event of host2.runs.attach({ runId: recent.run.id })) {
      recentEvents.push(event);
    }
    expect(recentEvents.map((event) => event.type)).toEqual(["text_delta"]);
    await host2.close();
  });

  it("caps persisted run events and records an events_truncated marker", async () => {
    const restoreMaxEvents = setEnv("SUNSET_MAX_EVENTS_PER_RUN", "3");
    try {
      const root = await tempDir("state");
      const { engine } = fakeEngine([
        {
          events: [
            { type: "text_delta", text: "a" },
            { type: "text_delta", text: "b" },
            { type: "text_delta", text: "c" },
            { type: "text_delta", text: "d" },
            { type: "text_delta", text: "e" },
          ],
        },
      ]);
      const host = await createHost({
        stateDir: path.join(root, "state"),
        worktreeRoot: path.join(root, "worktrees"),
        engines: { devin: engine },
      });
      const repo = await initRepo();
      const project = await host.projects.register(repo);
      const workspace = await host.workspaces.create({
        projectId: project.id,
        slug: "capped",
      });
      const { run } = await host.sessions.create({
        workspaceId: workspace.id,
        prompt: "hi",
      });
      const result = await host.runs.wait({ runId: run.id });
      expect(result.status).toBe("finished");

      const events: HostEvent[] = [];
      for await (const event of host.runs.attach({ runId: run.id })) {
        events.push(event);
      }
      expect(events).toHaveLength(3);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 4]);
      expect(events.slice(0, 2).map((event) => event.type)).toEqual([
        "text_delta",
        "text_delta",
      ]);
      expect(events[2]).toMatchObject({
        type: "status",
        status: "events_truncated",
      });
      await host.close();
    } finally {
      restoreMaxEvents();
    }
  });

  it("live-tails events through attach while a run is in flight", async () => {
    const root = await tempDir("state");
    const { engine } = fakeEngine([
      { events: [{ type: "text_delta", text: "live" }], hang: true },
    ]);
    const host = await createHost({
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "worktrees"),
      engines: { devin: engine },
    });
    const repo = await initRepo();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "live",
    });
    const { run } = await host.sessions.create({
      workspaceId: workspace.id,
      prompt: "go",
    });

    const collected: HostEvent[] = [];
    const attached = (async () => {
      for await (const event of host.runs.attach({ runId: run.id })) {
        collected.push(event);
      }
    })();
    await waitFor(() => collected.length === 1);
    expect(collected[0]).toMatchObject({ type: "text_delta", sequence: 1 });

    const result = await host.runs.cancel({ runId: run.id });
    expect(result.status).toBe("cancelled");
    await attached;
    await host.close();
  });

  it("diffs and commits workspace worktree changes", async () => {
    const { host, repo } = await setup();
    const project = await host.projects.register(repo);
    const workspace = await host.workspaces.create({
      projectId: project.id,
      slug: "diff-commit",
      baseRef: "main",
    });
    await writeFile(
      path.join(workspace.worktreePath, "feature.txt"),
      "from agent\n",
    );
    await writeFile(path.join(workspace.worktreePath, "README.md"), "edited\n");

    const diff = await host.workspaces.diff({ workspaceId: workspace.id });
    expect(diff.diff).toContain("feature.txt");
    expect(diff.diff).toContain("+from agent");
    expect(diff.diff).toContain("+edited");
    expect(diff.stat).toContain("feature.txt");

    const committed = await host.workspaces.commit({
      workspaceId: workspace.id,
      message: "agent work",
    });
    const head = await execa("git", ["rev-parse", "HEAD"], {
      cwd: workspace.worktreePath,
    });
    expect(committed.commit).toBe(head.stdout.trim());
    const subject = await execa("git", ["log", "-1", "--format=%s"], {
      cwd: workspace.worktreePath,
    });
    expect(subject.stdout).toBe("agent work");
    const branch = await execa("git", ["branch", "--show-current"], {
      cwd: workspace.worktreePath,
    });
    expect(branch.stdout).toBe("sunset/diff-commit");

    const clean = await host.workspaces.diff({
      workspaceId: workspace.id,
      baseRef: "HEAD",
    });
    expect(clean.diff).toBe("");

    await expect(
      host.workspaces.diff({ workspaceId: "missing" }),
    ).rejects.toMatchObject({ code: "unknown_workspace" });
    await host.close();
  });

  it("rejects malformed retention environment configuration", async () => {
    const root = await tempDir("state");
    const restoreMaxEvents = setEnv("SUNSET_MAX_EVENTS_PER_RUN", "abc");
    try {
      await expect(
        createHost({
          stateDir: path.join(root, "state"),
          worktreeRoot: path.join(root, "worktrees"),
        }),
      ).rejects.toMatchObject({ code: "invalid_options" });
    } finally {
      restoreMaxEvents();
    }
    const restoreRetention = setEnv("SUNSET_EVENT_RETENTION_DAYS", "-1");
    try {
      await expect(
        createHost({
          stateDir: path.join(root, "state"),
          worktreeRoot: path.join(root, "worktrees"),
        }),
      ).rejects.toMatchObject({ code: "invalid_options" });
    } finally {
      restoreRetention();
    }
  });
});
