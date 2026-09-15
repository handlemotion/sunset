import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import WebSocket from "ws";

import type { Host, HostEvent } from "@sunset/host";

import { createSunsetServer } from "./server.js";

function stubHost(
  options: {
    hangAttach?: boolean;
    hangWait?: boolean;
    waitGate?: Promise<void>;
    waitStarted?: () => void;
  } = {},
): Host {
  const project = { id: "p1", repoRoot: "/tmp/repo" };
  const workspace = {
    id: "w1",
    projectId: "p1",
    worktreePath: "/tmp/wt",
    branch: "sunset/w1",
    slug: "w1",
    baseRef: "HEAD",
    createdAt: 0,
    archivedAt: null,
  };
  return {
    async capabilities() {
      return { engines: [] };
    },
    async close() {},
    async suspend() {},
    projects: {
      async register(repoRoot: string) {
        return { id: "p1", repoRoot };
      },
      get: () => project,
      list: () => [project],
      async reconcile() {
        return {
          project,
          repositoryIdentity: null,
          inspectedAt: 0,
          entries: [],
        };
      },
    },
    workspaces: {
      async create() {
        return workspace;
      },
      list: () => [workspace],
      get: () => workspace,
      async archive() {
        return { ...workspace, archivedAt: 1 };
      },
      async diff(input) {
        return {
          worktreePath: "/tmp/wt",
          head: "abc123",
          diff: `diff --git a/f b/f (base:${input.baseRef ?? "none"})`,
          stat: " 1 file changed",
        };
      },
      async commit(input) {
        return { commit: "def456", summary: input.message };
      },
    },
    sessions: {
      async create({ prompt }) {
        return {
          session: {
            id: "s1",
            workspaceId: "w1",
            engine: "devin" as const,
            location: "local" as const,
            providerSessionId: "ps1",
            mode: "agent" as const,
            model: { id: "m", params: [] },
            executionPolicy: {
              autoReview: false,
              sandbox: { enabled: false },
              agentRetries: true,
              toolAllowlist: null,
              toolDenylist: [],
            },
            createdAt: 0,
          },
          run: {
            id: "r1",
            sessionId: "s1",
            status: "queued" as const,
            createdAt: 0,
            startedAt: null,
            finishedAt: null,
          },
        };
      },
      async send({ prompt }) {
        return {
          session: {
            id: "s1",
            workspaceId: "w1",
            engine: "devin" as const,
            location: "local" as const,
            providerSessionId: "ps1",
            mode: "agent" as const,
            model: { id: "m", params: [] },
            executionPolicy: {
              autoReview: false,
              sandbox: { enabled: false },
              agentRetries: true,
              toolAllowlist: null,
              toolDenylist: [],
            },
            createdAt: 0,
          },
          run: {
            id: "r1",
            sessionId: "s1",
            status: "queued" as const,
            createdAt: 0,
            startedAt: null,
            finishedAt: null,
          },
        };
      },
      get: () => undefined,
      list: () => [],
    },
    runs: {
      get: () => undefined,
      list: () => [],
      async wait() {
        if (options.hangWait) {
          options.waitStarted?.();
          await options.waitGate;
        }
        return { runId: "r1", status: "finished" as const, result: "done" };
      },
      async cancel() {
        return { runId: "r1", status: "cancelled" as const };
      },
      attach({ afterSequence, signal }) {
        if (options.hangAttach) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (signal?.aborted) {
                  resolve();
                  return;
                }
                signal?.addEventListener("abort", () => resolve());
              });
            },
          };
        }
        const events: HostEvent[] = [
          {
            type: "text_delta",
            text: "a",
            workspaceId: "w1",
            sessionId: "s1",
            runId: "r1",
            sequence: 1,
          },
          {
            type: "text_delta",
            text: "b",
            workspaceId: "w1",
            sessionId: "s1",
            runId: "r1",
            sequence: 2,
          },
        ];
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              if (event.sequence > (afterSequence ?? 0)) yield event;
            }
          },
        };
      },
    },
    diagnostics: {
      operations: {
        get: () => undefined,
        list: () => [],
      },
    },
  };
}

describe("createSunsetServer", () => {
  it("rejects API calls without the boot token and accepts with it", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    const unauthorized = await fetch(`${server.url}/api/projects`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${server.url}/api/projects`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as { projects: unknown[] };
    expect(body.projects).toHaveLength(1);
    await server.close();
  });

  it("serves REST endpoints for workspaces and sessions", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    const headers = { authorization: `Bearer ${server.token}` };
    const created = await fetch(`${server.url}/api/projects/p1/workspaces`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ slug: "w1" }),
    });
    expect(created.status).toBe(200);

    const session = await fetch(`${server.url}/api/workspaces/w1/sessions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", engine: "devin" }),
    });
    expect(session.status).toBe(200);
    const parsed = (await session.json()) as { session: { id: string } };
    expect(parsed.session.id).toBe("s1");

    const cancel = await fetch(`${server.url}/api/runs/r1/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancel.status).toBe(200);
    await server.close();
  });

  it("serves workspace diff and commit routes", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    const headers = { authorization: `Bearer ${server.token}` };

    const diff = await fetch(`${server.url}/api/workspaces/w1/diff?base=main`, {
      headers,
    });
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as { diff: string; stat: string };
    expect(diffBody.diff).toContain("base:main");

    const noBase = await fetch(`${server.url}/api/workspaces/w1/diff`, {
      headers,
    });
    const noBaseBody = (await noBase.json()) as { diff: string };
    expect(noBaseBody.diff).toContain("base:none");

    const commit = await fetch(`${server.url}/api/workspaces/w1/commit`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ message: "ship it" }),
    });
    expect(commit.status).toBe(200);
    const commitBody = (await commit.json()) as {
      commit: string;
      summary: string;
    };
    expect(commitBody).toEqual({ commit: "def456", summary: "ship it" });
    await server.close();
  });

  it("streams run events over WebSocket and closes at run end", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/api/runs/r1/events?token=${server.token}`,
    );
    const received: unknown[] = [];
    let closeCode: number | undefined;
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => received.push(JSON.parse(String(data))));
      ws.on("close", (code) => {
        closeCode = code;
        resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 5000);
    });
    expect(received).toHaveLength(2);
    expect(closeCode).toBe(1000);
    await server.close();
  });

  it("rejects WebSocket upgrades without a token", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `${server.url.replace("http", "ws")}/api/runs/r1/events`,
        );
        ws.on("open", () => resolve(undefined));
        ws.on("error", (error) => reject(error));
      }),
    ).rejects.toThrow();
    await server.close();
  });

  it("rejects WebSocket upgrades from a foreign Origin", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `${server.url.replace("http", "ws")}/api/runs/r1/events?token=${server.token}`,
          { headers: { origin: "https://evil.example.com" } },
        );
        ws.on("open", () => resolve(undefined));
        ws.on("error", (error) => reject(error));
      }),
    ).rejects.toThrow("403");
    await server.close();
  });

  it("accepts WebSocket upgrades from a localhost Origin", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/api/runs/r1/events?token=${server.token}`,
      { headers: { origin: "http://localhost:5173" } },
    );
    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => received.push(JSON.parse(String(data))));
      ws.on("close", () => resolve());
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 5000);
    });
    expect(received).toHaveLength(2);
    await server.close();
  });

  it("returns 413 for JSON request bodies larger than 1 MiB", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    const oversized = await fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repoRoot: "/tmp/", pad: "x".repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("connection")).toBe("close");

    const ok = await fetch(`${server.url}/api/projects`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(ok.status).toBe(200);
    await server.close();
  });

  it("closes open WebSockets when the server closes", async () => {
    const server = await createSunsetServer({
      host: stubHost({ hangAttach: true }),
    });
    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/api/runs/r1/events?token=${server.token}`,
    );
    let closeCode: number | undefined;
    const closed = new Promise<void>((resolve) =>
      ws.on("close", (code) => {
        closeCode = code;
        resolve();
      }),
    );
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 5000);
    });
    await server.close();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(closeCode).toBe(1001);
  });

  it("aborts a pending HTTP handler when shutdown cannot drain it", async () => {
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    let resolveWaitStarted!: () => void;
    const waitStarted = new Promise<void>((resolve) => {
      resolveWaitStarted = resolve;
    });
    const server = await createSunsetServer({
      host: stubHost({
        hangWait: true,
        waitGate,
        waitStarted: resolveWaitStarted,
      }),
    });
    const pending = fetch(`${server.url}/api/runs/r1/wait`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    await waitStarted;

    await Promise.race([
      server.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("shutdown timeout")), 3000),
      ),
    ]);
    releaseWait();
    await expect(pending).rejects.toThrow();
  });

  it("returns 400 for malformed HTTP request targets", async () => {
    const server = await createSunsetServer({ host: stubHost() });
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1", () =>
        socket.end(
          "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        ),
      );
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(data));
    });
    expect(response.split("\r\n", 1)[0]).toBe("HTTP/1.1 400 Bad Request");
    await server.close();
  });
});
