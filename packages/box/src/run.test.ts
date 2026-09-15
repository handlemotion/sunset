import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { BoxClient } from "./box.js";
import { codexTaskScript } from "./codex.js";
import { findRun, inspectRun, launchRun, terminateRun } from "./run.js";
import { supervisorScript } from "./supervisor.js";

const runId = "11111111-1111-1111-1111-111111111111";

afterEach(() => vi.restoreAllMocks());

it("writes trusted completion and includes a new regression file in the real Git patch", async () => {
  const root = mkdtempSync(join(tmpdir(), "sunset-run-"));
  try {
    const task = `${root}/tasks/${runId}`;
    mkdirSync(`${task}/repo`, { recursive: true });
    mkdirSync(`${root}/trusted`, { recursive: true });
    mkdirSync(`${root}/bin`);
    for (const [name, script] of Object.entries({
      flock: "exit 0",
      setsid: 'exec "$@"',
      timeout: 'shift 2; exec "$@"',
      codex:
        "test ! -e /dev/fd/9 || exit 88; mkdir -p repo/test; echo regression > repo/test/new.test.ts; exit 0",
    }))
      writeFileSync(`${root}/bin/${name}`, `#!/bin/bash\n${script}\n`, {
        mode: 0o755,
      });
    writeFileSync(`${root}/trusted/model`, "test");
    writeFileSync(`${root}/trusted/prompt.txt`, "test");
    writeFileSync(`${task}/task.sh`, codexTaskScript());
    writeFileSync(`${task}/repo/source.ts`, "before\n");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", `${task}/repo`, ...args]);
    git("init", "-q");
    git("add", "-A");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "base",
    );
    writeFileSync(`${root}/supervisor.sh`, supervisorScript(root));
    execFileSync(
      "bash",
      [
        `${root}/supervisor.sh`,
        runId,
        String(Math.floor(Date.now() / 1000) + 60),
      ],
      { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` } },
    );
    await vi.waitFor(() =>
      expect(existsSync(`${root}/trusted/${runId}/status.json`)).toBe(true),
    );
    expect(
      JSON.parse(readFileSync(`${root}/trusted/${runId}/status.json`, "utf8"))
        .exitCode,
    ).toBe(0);
    const patch = readFileSync(`${root}/trusted/${runId}/patch.diff`, "utf8");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("+regression");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["authentication token expired", "authentication"],
  ["subscription quota exhausted", "quota"],
  ["segfault", "agent_failed"],
])(
  "classifies %s without trusting a task-directory status",
  async (stderr, failureCode) => {
    vi.spyOn(BoxClient.prototype, "read").mockImplementation(async (path) => {
      if (path.endsWith(`run-${runId}.json`))
        return JSON.stringify({ runId, pid: 123 });
      expect(path).toContain(`/trusted/${runId}/`);
      if (path.endsWith("status.json")) return '{"exitCode":1}';
      if (path.endsWith("agent.stderr")) return stderr;
      return null;
    });
    vi.spyOn(BoxClient.prototype, "exec").mockResolvedValue({
      exitCode: 0,
      output: "",
      error: "",
    });
    const box = new BoxClient("test", "box");
    await expect(
      inspectRun(box, runId, {
        artifacts: ["agent.stderr"],
        stderrArtifact: "agent.stderr",
      }),
    ).resolves.toMatchObject({ status: "finished", failureCode });
  },
);

it("keeps completed artifacts pending while the supervisor process lock is held", async () => {
  vi.spyOn(BoxClient.prototype, "read").mockImplementation(async (path) =>
    path.endsWith("status.json")
      ? '{"exitCode":0}'
      : JSON.stringify({ runId, pid: 123 }),
  );
  vi.spyOn(BoxClient.prototype, "exec").mockResolvedValue({
    exitCode: 1,
    output: "",
    error: "",
  });
  const box = new BoxClient("test", "box");
  await expect(inspectRun(box, runId)).resolves.toEqual({
    status: "running",
    processId: 123,
  });
});

it("reports a run with no marker as lost", async () => {
  vi.spyOn(BoxClient.prototype, "read").mockResolvedValue(null);
  const box = new BoxClient("test", "box");
  await expect(inspectRun(box, runId)).resolves.toEqual({ status: "lost" });
  await expect(findRun(box, runId)).resolves.toBeNull();
});

it("returns the recorded pid when the run marker already exists", async () => {
  const exec = vi.spyOn(BoxClient.prototype, "exec");
  vi.spyOn(BoxClient.prototype, "read").mockResolvedValue(
    JSON.stringify({ runId, pid: 123, startedAt: 1 }),
  );
  const box = new BoxClient("test", "box");
  await expect(
    launchRun(box, {
      runId,
      deadlineAt: Date.now() + 60_000,
      task: "echo hi",
    }),
  ).resolves.toEqual({ boxId: "box", processId: 123 });
  expect(exec).not.toHaveBeenCalled();
});

it("writes supervisor, task body, and scoped files before launch", async () => {
  const writes: string[] = [];
  const box = {
    id: "box",
    read: async () => null,
    write: async (path: string) => {
      writes.push(path);
    },
    exec: async (command: string[]) => ({
      exitCode: 0,
      output: command.some((arg) => arg.includes("supervisor.sh"))
        ? JSON.stringify({ runId, pid: 42 })
        : "",
      error: "",
    }),
    delete: async () => undefined,
  } as unknown as BoxClient;
  const handle = await launchRun(box, {
    runId,
    deadlineAt: Date.now() + 60_000,
    task: "echo hi",
    files: [
      { path: "trusted/model", content: "m" },
      { path: "task/repo.tgz", content: "x", encoding: "base64" },
    ],
  });
  expect(handle).toEqual({ boxId: "box", processId: 42 });
  expect(writes).toEqual(
    expect.arrayContaining([
      "/workspace/home/sunset/trusted/supervisor.sh",
      `/workspace/home/sunset/tasks/${runId}/task.sh`,
      "/workspace/home/sunset/trusted/model",
      `/workspace/home/sunset/tasks/${runId}/repo.tgz`,
    ]),
  );
});

it("rejects run ids and file paths that escape the run layout", async () => {
  const box = new BoxClient("test", "box");
  const read = vi.spyOn(BoxClient.prototype, "read").mockResolvedValue(null);
  await expect(
    launchRun(box, {
      runId: "../escape",
      deadlineAt: Date.now() + 60_000,
      task: "x",
    }),
  ).rejects.toThrow("invalid_run_id");
  await expect(inspectRun(box, "../escape")).rejects.toThrow("invalid_run_id");
  await expect(
    launchRun(box, {
      runId,
      deadlineAt: Date.now() + 60_000,
      task: "x",
      files: [{ path: "etc/passwd", content: "x" }],
    }),
  ).rejects.toThrow("run_file_scope_invalid");
  expect(read).not.toHaveBeenCalledWith(expect.stringContaining("passwd"));
});

it("escalates to KILL when the process group survives TERM", async () => {
  const calls: string[][] = [];
  vi.spyOn(BoxClient.prototype, "exec").mockImplementation(async (command) => {
    calls.push(command);
    if (command[0] === "ps")
      return { exitCode: 0, output: " 123\n", error: "" };
    return { exitCode: 0, output: "", error: "" };
  });
  const box = new BoxClient("test", "box");
  await expect(terminateRun(box, 123)).resolves.toBe(false);
  expect(calls[0]).toEqual(["kill", "-TERM", "-123"]);
  expect(calls[2]).toEqual(["kill", "-KILL", "-123"]);
});

it("stops after TERM when the process group is gone", async () => {
  const calls: string[][] = [];
  vi.spyOn(BoxClient.prototype, "exec").mockImplementation(async (command) => {
    calls.push(command);
    if (command[0] === "ps")
      return { exitCode: 0, output: " 999\n", error: "" };
    return { exitCode: 0, output: "", error: "" };
  });
  const box = new BoxClient("test", "box");
  await expect(terminateRun(box, 123)).resolves.toBe(true);
  expect(calls).toHaveLength(2);
});
