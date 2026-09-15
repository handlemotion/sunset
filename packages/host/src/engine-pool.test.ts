import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

import { createHost, type CreateHostOptions } from "./create-host.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `sunset-pool-${name}-`));
  temps.push(dir);
  return realpath(dir);
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
    parameters: [],
    variants: [],
  },
];

type FakeRunScript = {
  events?: AgentEvent[];
  result?: RunResult["status"];
  resultText?: string;
  hang?: boolean;
};

function fakeEngine(
  scripts: FakeRunScript[] = [],
  options: { blockFirstCreate?: boolean; blockFirstDispose?: boolean } = {},
) {
  let releaseFirstCreate!: () => void;
  const firstCreate = new Promise<void>((resolve) => {
    releaseFirstCreate = resolve;
  });
  let releaseFirstDispose!: () => void;
  const firstDispose = new Promise<void>((resolve) => {
    releaseFirstDispose = resolve;
  });
  const state = {
    creates: [] as CreateEngineInput[],
    resumes: [] as string[],
    disposes: [] as string[],
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
        return run(state.scripts.shift() ?? {});
      },
      async dispose() {
        state.disposes.push(id);
        if (options.blockFirstDispose && id === "fake-provider-1") {
          await firstDispose;
        }
      },
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
      if (options.blockFirstCreate && state.creates.length === 1) {
        await firstCreate;
      }
      return handle(`fake-provider-${state.creates.length}`);
    },
    async resume(input) {
      state.resumes.push(input.providerSessionId);
      return handle(input.providerSessionId);
    },
  };
  return { engine, state, releaseFirstCreate, releaseFirstDispose };
}

async function setup(
  engine: Engine,
  options?: Partial<CreateHostOptions>,
): Promise<{
  host: Awaited<ReturnType<typeof createHost>>;
  workspaceId: string;
}> {
  const root = await tempDir("state");
  const repo = await initRepo();
  const host = await createHost({
    stateDir: path.join(root, "state"),
    worktreeRoot: path.join(root, "worktrees"),
    engines: { devin: engine },
    ...options,
  });
  const project = await host.projects.register(repo);
  const workspace = await host.workspaces.create({
    projectId: project.id,
    slug: "ws",
  });
  return { host, workspaceId: workspace.id };
}

async function eventually(check: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("engine pool", () => {
  it("rejects non-positive lifecycle options", async () => {
    const root = await tempDir("options");
    const base = {
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "worktrees"),
    };
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        createHost({ ...base, engineIdleTtlMs: value }),
      ).rejects.toMatchObject({ code: "invalid_options" });
      await expect(
        createHost({ ...base, maxEnginesPerWorkspace: value }),
      ).rejects.toMatchObject({ code: "invalid_options" });
    }
    await expect(
      createHost({ ...base, engineIdleTtlMs: 2_147_483_648 }),
    ).rejects.toMatchObject({ code: "invalid_options" });
    await expect(
      createHost({ ...base, maxEnginesPerWorkspace: 1.5 }),
    ).rejects.toMatchObject({ code: "invalid_options" });
  });

  it("evicts the least recently used idle engine at capacity", async () => {
    const { engine, state } = fakeEngine([
      { events: [{ type: "text_delta", text: "a" }] },
      { events: [{ type: "text_delta", text: "b" }] },
      { events: [{ type: "text_delta", text: "c" }] },
    ]);
    const { host, workspaceId } = await setup(engine, {
      maxEnginesPerWorkspace: 2,
    });
    const first = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await host.runs.wait({ runId: first.run.id });
    const second = await host.sessions.create({
      workspaceId,
      prompt: "two",
    });
    await host.runs.wait({ runId: second.run.id });

    const third = await host.sessions.create({
      workspaceId,
      prompt: "three",
    });
    await host.runs.wait({ runId: third.run.id });

    expect(state.disposes).toEqual(["fake-provider-1"]);
    await host.close();
  }, 15_000);

  it("disposes an idle engine after the TTL and resumes the session on the next prompt", async () => {
    const { engine, state } = fakeEngine([
      { events: [{ type: "text_delta", text: "a" }] },
      { events: [{ type: "text_delta", text: "b" }] },
    ]);
    const { host, workspaceId } = await setup(engine, {
      engineIdleTtlMs: 40,
      maxEnginesPerWorkspace: 5,
    });
    const { session, run } = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await host.runs.wait({ runId: run.id });

    await eventually(() => expect(state.disposes).toEqual(["fake-provider-1"]));

    const next = await host.sessions.send({
      sessionId: session.id,
      prompt: "two",
    });
    const result = await host.runs.wait({ runId: next.run.id });
    expect(result.status).toBe("finished");
    expect(state.resumes).toEqual(["fake-provider-1"]);
    await host.close();
  });

  it("recreates an evicted session through the resume path", async () => {
    const { engine, state } = fakeEngine([
      { events: [] },
      { events: [] },
      { events: [] },
    ]);
    const { host, workspaceId } = await setup(engine, {
      maxEnginesPerWorkspace: 1,
    });
    const first = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await host.runs.wait({ runId: first.run.id });
    const second = await host.sessions.create({
      workspaceId,
      prompt: "two",
    });
    await host.runs.wait({ runId: second.run.id });
    expect(state.disposes).toEqual(["fake-provider-1"]);

    const again = await host.sessions.send({
      sessionId: first.session.id,
      prompt: "again",
    });
    const result = await host.runs.wait({ runId: again.run.id });
    expect(result.status).toBe("finished");
    expect(state.resumes).toEqual(["fake-provider-1"]);
    await host.close();
  });

  it("cancels a capacity-waiting run before resuming or sending its prompt", async () => {
    const { engine, state } = fakeEngine([{ events: [] }, { hang: true }]);
    const { host, workspaceId } = await setup(engine, {
      maxEnginesPerWorkspace: 1,
    });
    const first = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await host.runs.wait({ runId: first.run.id });
    const second = await host.sessions.create({
      workspaceId,
      prompt: "two",
    });
    await eventually(() => {
      expect(host.runs.get(second.run.id)?.status).toBe("running");
    });

    const retry = await host.sessions.send({
      sessionId: first.session.id,
      prompt: "again",
    });
    await expect(
      host.runs.cancel({ runId: retry.run.id }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(state.resumes).toEqual([]);

    await host.close();
  });

  it("waits for an in-flight engine creation during shutdown", async () => {
    const { engine, state, releaseFirstCreate } = fakeEngine([{ events: [] }], {
      blockFirstCreate: true,
    });
    const { host, workspaceId } = await setup(engine);
    const creating = host.sessions.create({ workspaceId, prompt: "one" });
    await eventually(() => expect(state.creates).toHaveLength(1));

    let closed = false;
    const closing = host.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    releaseFirstCreate();
    await expect(creating).rejects.toMatchObject({ code: "host_closed" });
    await closing;
    expect(state.disposes).toEqual(["fake-provider-1"]);
  });

  it("counts a retiring engine until disposal completes", async () => {
    const { engine, state, releaseFirstDispose } = fakeEngine(
      [{ events: [] }, { events: [] }],
      { blockFirstDispose: true },
    );
    const { host, workspaceId } = await setup(engine, {
      engineIdleTtlMs: 30,
      maxEnginesPerWorkspace: 1,
    });
    const first = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await host.runs.wait({ runId: first.run.id });
    await eventually(() => expect(state.disposes).toEqual(["fake-provider-1"]));

    const second = host.sessions.create({ workspaceId, prompt: "two" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.creates).toHaveLength(1);

    releaseFirstDispose();
    const created = await second;
    await host.runs.wait({ runId: created.run.id });
    expect(state.creates).toHaveLength(2);
    await host.close();
  });

  it("waits for retiring disposal during shutdown", async () => {
    const { engine, state, releaseFirstDispose } = fakeEngine(
      [{ events: [] }],
      { blockFirstDispose: true },
    );
    const { host, workspaceId } = await setup(engine, {
      engineIdleTtlMs: 30,
      maxEnginesPerWorkspace: 1,
    });
    const first = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await host.runs.wait({ runId: first.run.id });
    await eventually(() => expect(state.disposes).toEqual(["fake-provider-1"]));

    let closed = false;
    const closing = host.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    releaseFirstDispose();
    await closing;
    expect(closed).toBe(true);
  });

  it("FIFO-waits while every engine in the workspace is busy", async () => {
    const { engine, state } = fakeEngine([
      { hang: true },
      { hang: true },
      { events: [] },
    ]);
    const { host, workspaceId } = await setup(engine, {
      maxEnginesPerWorkspace: 1,
    });
    const first = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await eventually(() => {
      const run = host.runs.get(first.run.id);
      expect(run?.status).toBe("running");
    });

    const second = host.sessions.create({ workspaceId, prompt: "two" });
    const third = host.sessions.create({ workspaceId, prompt: "three" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.creates).toHaveLength(1);

    await host.runs.cancel({ runId: first.run.id });
    const secondResult = await second;
    expect(state.creates).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.creates).toHaveLength(2);

    const secondRun = host.runs
      .list({ sessionId: secondResult.session.id })
      .find((run) => run.status !== "cancelled");
    await host.runs.cancel({ runId: secondRun!.id });
    await third;
    expect(state.creates).toHaveLength(3);
    expect(state.disposes.slice(0, 2)).toEqual([
      "fake-provider-1",
      "fake-provider-2",
    ]);
    await host.close();
  });

  it("rejects capacity waiters when the host shuts down", async () => {
    const { engine } = fakeEngine([{ hang: true }]);
    const { host, workspaceId } = await setup(engine, {
      maxEnginesPerWorkspace: 1,
    });
    const first = await host.sessions.create({
      workspaceId,
      prompt: "one",
    });
    await eventually(() => {
      const run = host.runs.get(first.run.id);
      expect(run?.status).toBe("running");
    });
    const waiting = host.sessions.create({ workspaceId, prompt: "two" });
    const rejection = expect(waiting).rejects.toMatchObject({
      code: "host_closed",
    });
    await host.close();
    await rejection;
  });
});
