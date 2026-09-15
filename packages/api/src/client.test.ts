import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExecutionPolicy,
  HostCapabilities,
  Project,
  Run,
  RunResult,
  Session,
  Workspace,
} from "@sunset/domain";

import { ApiError, createClient } from "./index.js";
import type { ProjectReconciliation, WorkspaceOperation } from "./index.js";

const BASE = "http://sunset.test";
const TOKEN = "tok-123";

const project: Project = { id: "p1", repoRoot: "/repo" };
const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  worktreePath: "/repo/.sunset/w1",
  branch: "sunset/w1",
  slug: "w1",
  baseRef: "HEAD",
  createdAt: 1,
  archivedAt: null,
};
const executionPolicy: ExecutionPolicy = {
  autoReview: false,
  sandbox: { enabled: false },
  agentRetries: true,
  toolAllowlist: null,
  toolDenylist: [],
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
  createdAt: 2,
};
const run: Run = {
  id: "r1",
  sessionId: "s1",
  status: "running",
  createdAt: 3,
  startedAt: 4,
  finishedAt: null,
};
const runResult: RunResult = {
  runId: "r1",
  status: "finished",
  result: "done",
  durationMs: 10,
};
const capabilities: HostCapabilities = {
  engines: [
    {
      id: "devin",
      modes: ["agent", "plan"],
      models: [],
      modelCatalog: { status: "live", fetchedAt: 0 },
      executionPolicy: {
        defaults: executionPolicy,
        controls: ["autoReview", "sandbox"],
      },
    },
  ],
};
const reconciliation: ProjectReconciliation = {
  project,
  repositoryIdentity: "deadbeef",
  inspectedAt: 5,
  entries: [{ state: "missing", workspace }],
};
const operation: WorkspaceOperation = {
  schemaVersion: 1,
  id: "op1",
  type: "create_workspace",
  phase: "operation_completed",
  projectId: "p1",
  workspaceId: "w1",
  createdAt: 1,
  updatedAt: 2,
  lastRecoveryAt: null,
  recoveryAttemptCount: 0,
  terminalOutcome: "succeeded",
  terminalAt: 2,
  compensationOutcome: "not_required",
  diagnostic: null,
  branchOutcome: null,
  requestedInputs: {
    slug: "w1",
    branch: "sunset/w1",
    baseRef: "HEAD",
    worktreePath: "/repo/.sunset/w1",
    copyGlobs: [],
  },
};

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function stubFetch(
  responder: (request: RecordedRequest) => { status?: number; body: unknown },
): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    async (
      input: unknown,
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      },
    ) => {
      const request: RecordedRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        body: init?.body,
      };
      calls.push(request);
      const result = responder(request);
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return calls;
}

function ok(body: unknown) {
  return { body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createClient", () => {
  it("sends the boot token as a bearer header and GETs capabilities", async () => {
    const calls = stubFetch(() => ok(capabilities));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    await expect(client.capabilities()).resolves.toEqual(capabilities);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${BASE}/api/capabilities`,
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  });

  it("lists and adds projects", async () => {
    const calls = stubFetch((request) =>
      request.method === "POST" ? ok(project) : ok({ projects: [project] }),
    );
    const client = createClient({ baseUrl: BASE, token: TOKEN });

    await expect(client.listProjects()).resolves.toEqual([project]);
    expect(calls[0]).toMatchObject({
      url: `${BASE}/api/projects`,
      method: "GET",
    });

    await expect(client.addProject("/repo")).resolves.toEqual(project);
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ repoRoot: "/repo" });
    expect(calls[1]!.headers["content-type"]).toBe("application/json");
  });

  it("lists and creates workspaces under a project", async () => {
    const calls = stubFetch((request) =>
      request.method === "POST"
        ? ok(workspace)
        : ok({ workspaces: [workspace] }),
    );
    const client = createClient({ baseUrl: BASE, token: TOKEN });

    await expect(client.listWorkspaces("p1")).resolves.toEqual([workspace]);
    expect(calls[0]!.url).toBe(`${BASE}/api/projects/p1/workspaces`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();

    const input = {
      slug: "w1",
      branch: "sunset/w1",
      baseRef: "HEAD",
      copyGlobs: [".env"],
    };
    await expect(client.createWorkspace("p1", input)).resolves.toEqual(
      workspace,
    );
    expect(calls[1]!.method).toBe("POST");
    expect(JSON.parse(calls[1]!.body!)).toEqual(input);
  });

  it("reconciles a project", async () => {
    const calls = stubFetch(() => ok(reconciliation));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    await expect(client.reconcileProject("p1")).resolves.toEqual(
      reconciliation,
    );
    expect(calls[0]!.url).toBe(`${BASE}/api/projects/p1/reconcile`);
    expect(calls[0]!.method).toBe("GET");
  });

  it("gets a workspace, including the null envelope", async () => {
    const calls = stubFetch(() => ok(workspace));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    await expect(client.getWorkspace("w1")).resolves.toEqual(workspace);
    expect(calls[0]!.url).toBe(`${BASE}/api/workspaces/w1`);

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(null), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.getWorkspace("missing")).resolves.toBeNull();
  });

  it("archives a workspace, defaulting to a bare POST body", async () => {
    const calls = stubFetch(() => ok({ ...workspace, archivedAt: 9 }));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    await expect(client.archiveWorkspace("w1")).resolves.toMatchObject({
      archivedAt: 9,
    });
    expect(calls[0]!.url).toBe(`${BASE}/api/workspaces/w1/archive`);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({});

    await client.archiveWorkspace("w1", { keepBranch: false });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ keepBranch: false });
  });

  it("lists and creates sessions, returning the session/run envelope", async () => {
    const envelope = { session, run };
    const calls = stubFetch((request) =>
      request.method === "POST" ? ok(envelope) : ok({ sessions: [session] }),
    );
    const client = createClient({ baseUrl: BASE, token: TOKEN });

    await expect(client.listSessions("w1")).resolves.toEqual([session]);
    expect(calls[0]!.url).toBe(`${BASE}/api/workspaces/w1/sessions`);

    const input = {
      prompt: "hi",
      engine: "devin" as const,
      mode: "agent" as const,
      model: { id: "m1" },
      executionPolicy: { autoReview: true },
    };
    await expect(client.createSession("w1", input)).resolves.toEqual(envelope);
    expect(calls[1]!.method).toBe("POST");
    expect(JSON.parse(calls[1]!.body!)).toEqual(input);
  });

  it("lists runs and sends a follow-up prompt", async () => {
    const calls = stubFetch((request) =>
      request.method === "POST" ? ok({ session, run }) : ok({ runs: [run] }),
    );
    const client = createClient({ baseUrl: BASE, token: TOKEN });

    await expect(client.listRuns("s1")).resolves.toEqual([run]);
    expect(calls[0]!.url).toBe(`${BASE}/api/sessions/s1/runs`);
    expect(calls[0]!.method).toBe("GET");

    await expect(client.send("s1", "again")).resolves.toEqual({
      session,
      run,
    });
    expect(calls[1]!.method).toBe("POST");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ prompt: "again" });
  });

  it("gets, cancels, and waits on runs", async () => {
    stubFetch((request) => {
      if (request.url.endsWith("/cancel")) return ok(runResult);
      if (request.url.endsWith("/wait")) return ok(runResult);
      return ok(run);
    });
    const client = createClient({ baseUrl: BASE, token: TOKEN });

    await expect(client.getRun("r1")).resolves.toEqual(run);
    await expect(client.cancelRun("r1")).resolves.toEqual(runResult);
    await expect(client.waitRun("r1")).resolves.toEqual(runResult);
  });

  it("encodes path parameters", async () => {
    const calls = stubFetch(() => ok(null));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    await client.getRun("run/with?chars");
    expect(calls[0]!.url).toBe(
      `${BASE}/api/runs/${encodeURIComponent("run/with?chars")}`,
    );
  });

  it("gets a workspace diff with an optional base", async () => {
    const diff = {
      worktreePath: "/w",
      head: "abc",
      diff: "patch",
      stat: " 1 file changed",
    };
    const calls = stubFetch(() => ok(diff));
    const client = createClient({ baseUrl: BASE, token: TOKEN });

    await expect(client.workspaceDiff("w1")).resolves.toEqual(diff);
    expect(calls[0]!.url).toBe(`${BASE}/api/workspaces/w1/diff`);
    expect(calls[0]!.method).toBe("GET");

    await client.workspaceDiff("w1", "release/1.0");
    expect(calls[1]!.url).toBe(
      `${BASE}/api/workspaces/w1/diff?base=${encodeURIComponent("release/1.0")}`,
    );
  });

  it("commits a workspace", async () => {
    const calls = stubFetch(() => ok({ commit: "c1", summary: "s" }));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    await expect(
      client.workspaceCommit("w1", { message: "ship it" }),
    ).resolves.toEqual({ commit: "c1", summary: "s" });
    expect(calls[0]!.url).toBe(`${BASE}/api/workspaces/w1/commit`);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ message: "ship it" });
  });

  it("lists diagnostics operations", async () => {
    const calls = stubFetch(() => ok({ operations: [operation] }));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    await expect(client.listOperations()).resolves.toEqual([operation]);
    expect(calls[0]!.url).toBe(`${BASE}/api/diagnostics/operations`);
    expect(calls[0]!.method).toBe("GET");
  });

  it("throws ApiError with the server's status, code, and message", async () => {
    stubFetch(() => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "invalid boot token" } },
    }));
    const client = createClient({ baseUrl: BASE, token: "wrong" });
    const error = await client.listProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "invalid boot token",
    });
  });

  it("throws ApiError with a fallback code/message for non-envelope errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const client = createClient({ baseUrl: BASE, token: TOKEN });
    const error = await client.getRun("r1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, code: "unknown" });
    expect((error as ApiError).message).toContain("500");
  });
});
