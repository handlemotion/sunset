import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedConfig } from "./config.js";
import { resolveClient } from "./client.js";
import {
  announceServer,
  discoverServer,
  readServerRecord,
  serverRecordPath,
  type ServerRecord,
} from "./server-discovery.js";

let dir: string;
const stubs: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sunset-discovery-test-"));
});

afterEach(async () => {
  await Promise.allSettled(stubs.splice(0).map((close) => close()));
  await rm(dir, { recursive: true, force: true });
});

/** Minimal stand-in for the sunset HTTP API's auth + capabilities route. */
async function startStubServer(
  token: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((request, response) => {
    const authorized =
      request.headers.authorization === `Bearer ${token}` ||
      new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get(
        "token",
      ) === token;
    if (request.url === "/api/capabilities" && authorized) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ engines: [] }));
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { code: "unauthorized", message: "invalid boot token" },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  stubs.push(close);
  return { url: `http://127.0.0.1:${port}`, close };
}

function record(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    url: "http://127.0.0.1:1",
    token: "tok",
    pid: process.pid,
    startedAt: Date.now(),
    ...overrides,
  };
}

async function writeRecord(value: unknown): Promise<void> {
  await writeFile(
    serverRecordPath(dir),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** A pid that is definitely not running: spawn a child and wait for exit. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid!));
  });
}

function config(): ResolvedConfig {
  return {
    stateDir: dir,
    worktreeRoot: path.join(dir, "worktrees"),
    configPath: path.join(dir, "config.json"),
    configFound: false,
    warnings: [],
    errors: [],
  };
}

describe("announceServer", () => {
  it("writes a discoverable record and removes it on cleanup", async () => {
    const stub = await startStubServer("tok");
    const remove = await announceServer(dir, { url: stub.url, token: "tok" });

    const written = await readServerRecord(dir);
    expect(written).toMatchObject({
      url: stub.url,
      token: "tok",
      pid: process.pid,
    });
    await expect(discoverServer(dir)).resolves.toEqual(written);

    await remove();
    expect(await exists(serverRecordPath(dir))).toBe(false);
    await expect(discoverServer(dir)).resolves.toBeNull();
  });

  it("cleanup is idempotent", async () => {
    const stub = await startStubServer("tok");
    const remove = await announceServer(dir, { url: stub.url, token: "tok" });
    await remove();
    await remove();
    expect(await exists(serverRecordPath(dir))).toBe(false);
  });

  it("cleanup does not remove a record owned by another pid", async () => {
    const stub = await startStubServer("tok");
    const remove = await announceServer(dir, { url: stub.url, token: "tok" });
    await writeRecord(record({ pid: 424242, token: "other" }));

    await remove();
    const kept = await readServerRecord(dir);
    expect(kept?.pid).toBe(424242);
  });
});

describe("discoverServer", () => {
  it("returns null when no record exists", async () => {
    await expect(discoverServer(dir)).resolves.toBeNull();
  });

  it("returns null for malformed JSON and removes the file", async () => {
    await writeRecord("{ not json");
    await expect(discoverServer(dir)).resolves.toBeNull();
    expect(await exists(serverRecordPath(dir))).toBe(false);
  });

  it("returns null for a record missing required fields", async () => {
    await writeRecord({ url: "http://127.0.0.1:1" });
    await expect(discoverServer(dir)).resolves.toBeNull();
  });

  it("returns null and removes the record when the pid is dead", async () => {
    await writeRecord(record({ pid: await deadPid() }));
    await expect(discoverServer(dir)).resolves.toBeNull();
    expect(await exists(serverRecordPath(dir))).toBe(false);
  });

  it("returns null when the connection is refused", async () => {
    const stub = await startStubServer("tok");
    const url = stub.url;
    await stub.close();
    await writeRecord(record({ url }));
    await expect(discoverServer(dir)).resolves.toBeNull();
  });

  it("returns null when the probe is unauthorized", async () => {
    const stub = await startStubServer("real-token");
    await writeRecord(record({ url: stub.url, token: "wrong-token" }));
    await expect(discoverServer(dir)).resolves.toBeNull();
  });

  it("returns the record when the server answers an authenticated probe", async () => {
    const stub = await startStubServer("tok");
    await writeRecord(record({ url: stub.url, token: "tok" }));
    await expect(discoverServer(dir)).resolves.toMatchObject({
      url: stub.url,
      token: "tok",
    });
  });
});

describe("resolveClient", () => {
  it("returns null with no announced server", async () => {
    await expect(resolveClient(config())).resolves.toBeNull();
  });

  it("returns a working API client when a server is live", async () => {
    const stub = await startStubServer("tok");
    await announceServer(dir, { url: stub.url, token: "tok" });
    const client = await resolveClient(config());
    expect(client).not.toBeNull();
    await expect(client!.capabilities()).resolves.toEqual({ engines: [] });
  });

  it("returns null when the announced server is gone", async () => {
    const stub = await startStubServer("tok");
    const remove = await announceServer(dir, { url: stub.url, token: "tok" });
    await stub.close();
    // The pid is still alive (ours) but the port is refused.
    await expect(resolveClient(config())).resolves.toBeNull();
    await remove();
  });
});
