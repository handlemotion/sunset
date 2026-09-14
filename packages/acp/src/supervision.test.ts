import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { nodeSpawn, stdioConnector } from "./client.js";
import { reapOrphanedEngineGroups, trackEngineGroup } from "./supervision.js";

const POSIX = process.platform !== "win32";
const posixIt = POSIX ? it : it.skip;

const temps: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `sunset-acp-${name}-`));
  temps.push(dir);
  return realpath(dir);
}

function spawnSleeper(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => undefined, 60_000)"],
    { detached: POSIX, stdio: "ignore" },
  );
  child.unref();
  children.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exited(child);
  if (child.pid === undefined) throw new Error("spawn failed");
  return child.pid;
}

function markerFile(dir: string, leaderPid: number): string {
  return path.join(dir, `${leaderPid}.json`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("engine process supervision", () => {
  it("tags spawned processes with the host pid", async () => {
    let captured: NodeJS.ProcessEnv | undefined;
    const connector = stdioConnector({
      command: "fake-agent",
      args: [],
      spawn: (input) => {
        captured = input.env;
        return {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          kill: () => undefined,
          exited: new Promise<void>(() => undefined),
        };
      },
    });
    const handle = await connector({
      cwd: "/tmp",
      onUpdate: () => undefined,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onClose: () => undefined,
    });
    expect(captured?.SUNSET_HOST_PID).toBe(String(process.pid));
    handle.close();
  });

  posixIt(
    "writes a group marker and removes it when the process exits",
    async () => {
      const dir = await tempDir("markers");
      const proc = nodeSpawn({
        command: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 60_000)"],
        cwd: dir,
        env: { ...process.env },
        engineGroupDir: dir,
      });
      const names = await readdir(dir);
      const name = names.find((entry) => entry.endsWith(".json"));
      expect(name).toBeDefined();
      const marker = JSON.parse(
        readFileSync(path.join(dir, name!), "utf8"),
      ) as {
        host: { pid: number; start: string };
        leader: { pid: number; start: string };
      };
      expect(marker.host.pid).toBe(process.pid);
      expect(marker.host.start.length).toBeGreaterThan(0);
      expect(marker.leader.pid).toBeGreaterThan(0);
      expect(marker.leader.start.length).toBeGreaterThan(0);
      expect(name).toBe(`${marker.leader.pid}.json`);

      proc.kill();
      await proc.exited;
      expect(existsSync(path.join(dir, name!))).toBe(false);
    },
  );

  posixIt("reaps a detached group whose recorded host is gone", async () => {
    const dir = await tempDir("reap");
    const leader = spawnSleeper();
    const leaderDone = exited(leader);
    const leaderPid = leader.pid!;
    trackEngineGroup(dir, leaderPid);
    const file = markerFile(dir, leaderPid);
    const marker = JSON.parse(readFileSync(file, "utf8")) as {
      host: { pid: number; start: string };
      leader: { pid: number; start: string };
    };
    marker.host = { pid: await deadPid(), start: "gone" };
    writeFileSync(file, JSON.stringify(marker));

    reapOrphanedEngineGroups(dir);

    await leaderDone;
    expect(alive(leaderPid)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  posixIt("preserves a group whose recorded host is still alive", async () => {
    const dir = await tempDir("keep");
    const leader = spawnSleeper();
    const leaderPid = leader.pid!;
    trackEngineGroup(dir, leaderPid);
    const file = markerFile(dir, leaderPid);

    reapOrphanedEngineGroups(dir);

    expect(existsSync(file)).toBe(true);
    expect(alive(leaderPid)).toBe(true);
  });

  posixIt(
    "removes a stale leader marker for a live host without killing the leader",
    async () => {
      const dir = await tempDir("stale-leader");
      const leader = spawnSleeper();
      const leaderPid = leader.pid!;
      trackEngineGroup(dir, leaderPid);
      const file = markerFile(dir, leaderPid);
      const marker = JSON.parse(readFileSync(file, "utf8")) as {
        host: { pid: number; start: string };
        leader: { pid: number; start: string };
      };
      marker.leader.start = "reused";
      writeFileSync(file, JSON.stringify(marker));

      reapOrphanedEngineGroups(dir);

      expect(alive(leaderPid)).toBe(true);
      expect(existsSync(file)).toBe(false);
    },
  );

  posixIt(
    "removes the marker for a dead leader while the host is live",
    async () => {
      const dir = await tempDir("dead-leader");
      const leader = spawnSleeper();
      const leaderPid = leader.pid!;
      trackEngineGroup(dir, leaderPid);
      const file = markerFile(dir, leaderPid);
      const marker = JSON.parse(readFileSync(file, "utf8")) as {
        host: { pid: number; start: string };
        leader: { pid: number; start: string };
      };
      marker.leader.pid = await deadPid();
      writeFileSync(file, JSON.stringify(marker));

      reapOrphanedEngineGroups(dir);

      expect(existsSync(file)).toBe(false);
      expect(alive(leaderPid)).toBe(true);
    },
  );

  posixIt(
    "does not kill a reused leader pid and removes the stale marker",
    async () => {
      const dir = await tempDir("reuse");
      const leader = spawnSleeper();
      const leaderPid = leader.pid!;
      trackEngineGroup(dir, leaderPid);
      const file = markerFile(dir, leaderPid);
      const marker = JSON.parse(readFileSync(file, "utf8")) as {
        host: { pid: number; start: string };
        leader: { pid: number; start: string };
      };
      marker.host = { pid: await deadPid(), start: "gone" };
      marker.leader.start = "reused";
      writeFileSync(file, JSON.stringify(marker));

      reapOrphanedEngineGroups(dir);

      expect(alive(leaderPid)).toBe(true);
      expect(existsSync(file)).toBe(false);
    },
  );

  posixIt(
    "removes stale markers without scanning outside the directory",
    async () => {
      const dir = await tempDir("stale");
      await mkdir(dir, { recursive: true });
      const dead = await deadPid();
      writeFileSync(
        markerFile(dir, dead),
        JSON.stringify({
          schemaVersion: 1,
          host: { pid: dead, start: "gone" },
          leader: { pid: dead, start: "gone" },
        }),
      );
      writeFileSync(path.join(dir, "corrupt.json"), "not json");
      await mkdir(path.join(dir, "undeletable.json"));
      writeFileSync(path.join(dir, "keep.txt"), "not a marker");

      reapOrphanedEngineGroups(dir);

      expect(existsSync(markerFile(dir, dead))).toBe(false);
      expect(existsSync(path.join(dir, "corrupt.json"))).toBe(false);
      expect(existsSync(path.join(dir, "undeletable.json"))).toBe(true);
      expect(existsSync(path.join(dir, "keep.txt"))).toBe(true);
    },
  );
});
