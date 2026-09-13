import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

type ChildMessage = {
  type: "entered" | "complete" | "error";
  slug: string;
  code?: string;
  details?: { owner?: { leaseId?: string; pid?: number } };
};

const fixture = path.join(import.meta.dirname, "fixtures", "lease-child.mjs");
const temps: string[] = [];
const children = new Set<ChildProcess>();

async function initRepo(
  label: string,
): Promise<{ repo: string; parent: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), `sunset-process-${label}-`));
  temps.push(parent);
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
  return { repo, parent };
}

function spawnMutation(input: {
  repoRoot: string;
  parent: string;
  slug: string;
  leaseTimeoutMs?: number;
}): ChildProcess {
  const child = fork(
    fixture,
    [
      JSON.stringify({
        repoRoot: input.repoRoot,
        worktreePath: path.join(input.parent, `wt-${input.slug}`),
        slug: input.slug,
        branch: `sunset/${input.slug}`,
        leaseTimeoutMs: input.leaseTimeoutMs,
      }),
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function nextMessage(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for child message"));
    }, timeoutMs);
    const onMessage = (value: unknown) => {
      cleanup();
      resolve(value as ChildMessage);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited before message: ${String(code)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("exit", onExit);
  });
}

async function noMessage(child: ChildProcess, timeoutMs = 200): Promise<void> {
  await expect(nextMessage(child, timeoutMs)).rejects.toThrow(
    "timed out waiting for child message",
  );
}

async function finish(child: ChildProcess): Promise<void> {
  child.send("release");
  await expect(nextMessage(child)).resolves.toMatchObject({ type: "complete" });
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(
    temps
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("cross-process repository lease", () => {
  it("serializes the same repository and linked-worktree identities", async () => {
    const { repo, parent } = await initRepo("same");
    const linked = path.join(parent, "linked-source");
    await execa(
      "git",
      ["worktree", "add", "-b", "source/linked", linked, "HEAD"],
      { cwd: repo },
    );
    const first = spawnMutation({ repoRoot: repo, parent, slug: "first" });
    expect(await nextMessage(first)).toMatchObject({ type: "entered" });
    const second = spawnMutation({
      repoRoot: linked,
      parent,
      slug: "second",
      leaseTimeoutMs: 2_000,
    });
    await noMessage(second);
    await finish(first);
    expect(await nextMessage(second)).toMatchObject({ type: "entered" });
    await finish(second);
  });

  it("keeps different repositories concurrent", async () => {
    const firstRepo = await initRepo("one");
    const secondRepo = await initRepo("two");
    const first = spawnMutation({
      ...firstRepo,
      repoRoot: firstRepo.repo,
      slug: "one",
    });
    const second = spawnMutation({
      ...secondRepo,
      repoRoot: secondRepo.repo,
      slug: "two",
    });
    await expect(
      Promise.all([nextMessage(first), nextMessage(second)]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "entered", slug: "one" }),
        expect.objectContaining({ type: "entered", slug: "two" }),
      ]),
    );
    await Promise.all([finish(first), finish(second)]);
  });

  it("returns repo_busy for a live owner with diagnostic metadata", async () => {
    const { repo, parent } = await initRepo("busy");
    const owner = spawnMutation({ repoRoot: repo, parent, slug: "owner" });
    expect(await nextMessage(owner)).toMatchObject({ type: "entered" });
    const contender = spawnMutation({
      repoRoot: repo,
      parent,
      slug: "contender",
      leaseTimeoutMs: 100,
    });
    const failure = await nextMessage(contender);
    expect(failure).toMatchObject({
      type: "error",
      code: "repo_busy",
      details: { owner: { pid: owner.pid } },
    });
    await finish(owner);
  });

  it("recovers a crashed owner and serializes concurrent reclaimers", async () => {
    const { repo, parent } = await initRepo("crash");
    const crashed = spawnMutation({ repoRoot: repo, parent, slug: "crashed" });
    expect(await nextMessage(crashed)).toMatchObject({ type: "entered" });
    crashed.kill("SIGKILL");
    await new Promise((resolve) => crashed.once("exit", resolve));

    const first = spawnMutation({
      repoRoot: repo,
      parent,
      slug: "reclaim-one",
    });
    const second = spawnMutation({
      repoRoot: repo,
      parent,
      slug: "reclaim-two",
      leaseTimeoutMs: 2_000,
    });
    const firstMessage = await Promise.race([
      nextMessage(first).then((message) => ({ child: first, message })),
      nextMessage(second).then((message) => ({ child: second, message })),
    ]);
    expect(firstMessage.message.type).toBe("entered");
    const waiting = firstMessage.child === first ? second : first;
    await noMessage(waiting);
    await finish(firstMessage.child);
    expect(await nextMessage(waiting)).toMatchObject({ type: "entered" });
    await finish(waiting);
  });
});
