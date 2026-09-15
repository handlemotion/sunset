import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { createGit } from "./create-git.js";
import { GitError } from "./errors.js";
import type { GitSpawn } from "./types.js";
import { defaultGitSpawn } from "./spawn.js";

async function initRepo(): Promise<{ repo: string; parent: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), "sunset-git-"));
  const repo = path.join(parent, "repo");
  await mkdir(repo);
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "sunset@example.com"], {
    cwd: repo,
  });
  await execa("git", ["config", "user.name", "Sunset"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "sunset\n");
  await writeFile(path.join(repo, ".gitignore"), ".env\n");
  await writeFile(path.join(repo, ".env"), "SECRET=1\n");
  await execa("git", ["add", "README.md", ".gitignore"], { cwd: repo });
  await execa("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, parent };
}

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("createGit", () => {
  it("creates two worktrees, copies gitignored .env, archives and keeps the branch", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    const firstPath = path.join(parent, "wt-one");
    const secondPath = path.join(parent, "wt-two");

    const first = await git.createWorktree({
      repoRoot: repo,
      worktreePath: firstPath,
      slug: "one",
      branch: "sunset/one",
      baseRef: "HEAD",
      copyGlobs: [".env"],
    });
    const second = await git.createWorktree({
      repoRoot: repo,
      worktreePath: secondPath,
      slug: "two",
      branch: "sunset/two",
      baseRef: "HEAD",
      copyGlobs: [".env"],
    });

    expect(first.copied).toContain(".env");
    expect(second.copied).toContain(".env");
    await access(path.join(firstPath, ".env"));
    await access(path.join(secondPath, ".env"));

    const listed = await git.listWorktrees(repo);
    expect(listed.map((row) => row.branch).sort()).toEqual(
      ["main", "sunset/one", "sunset/two"].sort(),
    );

    await git.archiveWorktree({
      repoRoot: repo,
      worktreePath: firstPath,
      branch: "sunset/one",
    });

    await expect(access(firstPath)).rejects.toThrow();
    await execa("git", ["show-ref", "--verify", "refs/heads/sunset/one"], {
      cwd: repo,
    });
  });

  it("inspects one canonical porcelain snapshot and retains prunable state", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    let snapshots = 0;
    const spawn: GitSpawn = async (args, options) => {
      if (args.join(" ") === "worktree list --porcelain") snapshots += 1;
      return defaultGitSpawn(args, options);
    };
    const git = createGit({ spawn });
    const worktreePath = path.join(parent, "inspect");
    await git.createWorktree({
      repoRoot: repo,
      worktreePath,
      slug: "inspect",
      branch: "sunset/inspect",
      baseRef: "HEAD",
    });
    const canonicalWorktreePath = await realpath(worktreePath);

    snapshots = 0;
    const healthy = await git.inspectRepository(repo);
    expect(snapshots).toBe(1);
    expect(healthy.repositoryIdentity).toBe(
      await realpath(path.join(repo, ".git")),
    );
    expect(healthy.worktrees).toContainEqual(
      expect.objectContaining({
        path: canonicalWorktreePath,
        pathExists: true,
        branch: "sunset/inspect",
        detached: false,
        prunable: null,
      }),
    );

    await rm(worktreePath, { recursive: true, force: true });
    snapshots = 0;
    const deleted = await git.inspectRepository(repo);
    expect(snapshots).toBe(1);
    expect(deleted.worktrees).toContainEqual(
      expect.objectContaining({
        path: canonicalWorktreePath,
        pathExists: false,
        prunable: expect.any(String),
      }),
    );
  });

  it("rejects a duplicate branch", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    await git.createWorktree({
      repoRoot: repo,
      worktreePath: path.join(parent, "wt-a"),
      slug: "a",
      branch: "sunset/same",
      baseRef: "HEAD",
    });
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "wt-b"),
        slug: "b",
        branch: "sunset/same",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "branch_exists" });
  });

  it("rejects unsafe branch names and safely deletes existing dash-prefixed refs", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    const worktreePath = path.join(parent, "wt-dash");
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath,
        slug: "dash",
        branch: "-dash",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "invalid_ref" });
    await execa("git", ["update-ref", "refs/heads/-dash", "HEAD"], {
      cwd: repo,
    });

    await git.archiveWorktree({
      repoRoot: repo,
      worktreePath,
      branch: "-dash",
      keepBranch: false,
    });

    await expect(
      execa("git", ["show-ref", "--verify", "refs/heads/-dash"], {
        cwd: repo,
      }),
    ).rejects.toThrow();
  });

  it("serializes mutations on the same repo and times out hung git", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    let inFlight = 0;
    let maxInFlight = 0;
    const spawn: GitSpawn = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "add") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
      }
      return defaultGitSpawn(args, options);
    };
    const git = createGit({ spawn });
    await Promise.all([
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "lock-a"),
        slug: "lock-a",
        branch: "sunset/lock-a",
        baseRef: "HEAD",
      }),
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "lock-b"),
        slug: "lock-b",
        branch: "sunset/lock-b",
        baseRef: "HEAD",
      }),
    ]);
    expect(maxInFlight).toBe(1);

    const hanging: GitSpawn = async (_args, options) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 5_000);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new GitError("hung git aborted", "timeout"));
        });
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const timed = createGit({ spawn: hanging, timeoutMs: 20 });
    await expect(timed.listWorktrees(repo)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("rolls back the worktree when setup fails", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    await writeFile(
      path.join(repo, "sunset.json"),
      JSON.stringify({ setup: "false" }),
    );
    const git = createGit();
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "wt-fail"),
        slug: "fail",
        branch: "sunset/fail",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "setup_failed" });
    const listed = await git.listWorktrees(repo);
    expect(listed.map((row) => row.branch)).toEqual(["main"]);
    await expect(
      execa("git", ["show-ref", "--verify", "refs/heads/sunset/fail"], {
        cwd: repo,
      }),
    ).rejects.toThrow();
  });

  it("rejects copy globs that escape the repo", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    await writeFile(path.join(parent, "secret"), "nope\n");
    const git = createGit();
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(parent, "wt-escape"),
        slug: "escape",
        branch: "sunset/escape",
        baseRef: "HEAD",
        copyGlobs: ["../secret"],
      }),
    ).rejects.toMatchObject({ code: "path_escape" });
  });

  it("rejects a nested worktree path", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    await expect(
      git.createWorktree({
        repoRoot: repo,
        worktreePath: path.join(repo, "nested"),
        slug: "nested",
        branch: "sunset/nested",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "nested_worktree" });
  });

  it.each([
    ["copy must be an array", { copy: ".env" }],
    ["copy members must be strings", { copy: [".env", 1] }],
    ["setup must have a supported type", { setup: 1 }],
    ["setup strings cannot be empty", { setup: "   " }],
    ["setup arrays cannot contain non-strings", { setup: ["echo ok", false] }],
    ["unknown Sunset keys are rejected", { copy: [".env"], extra: true }],
  ])(
    "rejects strict sunset.json: %s before adding a worktree",
    async (_label, config) => {
      const { repo, parent } = await initRepo();
      temps.push(parent);
      await writeFile(path.join(repo, "sunset.json"), JSON.stringify(config));
      const git = createGit();
      await expect(
        git.createWorktree({
          repoRoot: repo,
          worktreePath: path.join(parent, "wt-invalid-config"),
          slug: "invalid-config",
          branch: "sunset/invalid-config",
          baseRef: "HEAD",
        }),
      ).rejects.toMatchObject({ code: "config_invalid" });
      expect((await git.listWorktrees(repo)).map((row) => row.branch)).toEqual([
        "main",
      ]);
    },
  );

  it.each([
    [
      "Unix key wins even when invalid",
      { "setup-worktree-unix": "", "setup-worktree": ["echo fallback"] },
    ],
    [
      "present Unix null does not fall back",
      { "setup-worktree-unix": null, "setup-worktree": ["echo fallback"] },
    ],
    ["absolute script paths", { "setup-worktree": "/tmp/setup.sh" }],
    ["escaping script paths", { "setup-worktree": "../escape.sh" }],
    ["invalid selected command type", { "setup-worktree": 1 }],
    ["empty selected command arrays", { "setup-worktree": ["echo ok", " "] }],
  ])(
    "rejects Cursor configuration: %s before adding a worktree",
    async (_label, config) => {
      const { repo, parent } = await initRepo();
      temps.push(parent);
      await mkdir(path.join(repo, ".cursor"));
      await writeFile(
        path.join(repo, ".cursor", "worktrees.json"),
        JSON.stringify(config),
      );
      const git = createGit();
      await expect(
        git.createWorktree({
          repoRoot: repo,
          worktreePath: path.join(parent, "wt-cursor-invalid"),
          slug: "cursor-invalid",
          branch: "sunset/cursor-invalid",
          baseRef: "HEAD",
        }),
      ).rejects.toMatchObject({ code: "config_invalid" });
      expect((await git.listWorktrees(repo)).map((row) => row.branch)).toEqual([
        "main",
      ]);
    },
  );

  it("allows unrelated Cursor keys and executes a selected relative script in the worktree", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    await mkdir(path.join(repo, ".cursor"));
    await writeFile(
      path.join(repo, ".cursor", "setup.sh"),
      "#!/bin/sh\ntouch cursor-setup-ran\n",
    );
    await chmod(path.join(repo, ".cursor", "setup.sh"), 0o755);
    await execa("git", ["add", ".cursor/setup.sh"], { cwd: repo });
    await execa("git", ["commit", "-m", "add cursor setup"], { cwd: repo });
    await writeFile(
      path.join(repo, ".cursor", "worktrees.json"),
      JSON.stringify({
        unrelated: { allowed: true },
        "setup-worktree": "setup.sh",
      }),
    );

    const worktreePath = path.join(parent, "wt-cursor-valid");
    await createGit().createWorktree({
      repoRoot: repo,
      worktreePath,
      slug: "cursor-valid",
      branch: "sunset/cursor-valid",
      baseRef: "HEAD",
    });
    await access(path.join(worktreePath, "cursor-setup-ran"));
  });

  it("creates an operation-marked worktree idempotently", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    const worktreePath = path.join(parent, "journal-create");
    const input = {
      operationId: "01H00000000000000000000000",
      type: "create_workspace" as const,
      target: "git_worktree_created" as const,
      repoRoot: repo,
      worktreePath,
      slug: "journal-create",
      branch: "sunset/journal-create",
      baseRef: "HEAD",
    };

    const first = await git.advanceWorkspaceOperation(input);
    const repeated = await git.advanceWorkspaceOperation(input);

    expect(first).toMatchObject({
      state: "advanced",
      expectedHead: expect.any(String),
    });
    expect(repeated).toEqual(first);
    expect(
      (await git.listWorktrees(repo)).filter(
        (worktree) => worktree.branch === "sunset/journal-create",
      ),
    ).toHaveLength(1);
    await access(
      path.join(repo, ".git", "sunset-operations", `${input.operationId}.json`),
    );
  });

  it("does not delete a branch that changed after worktree removal", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    const worktreePath = path.join(parent, "journal-archive");
    await git.createWorktree({
      repoRoot: repo,
      worktreePath,
      slug: "journal-archive",
      branch: "sunset/journal-archive",
      baseRef: "HEAD",
    });
    const common = {
      operationId: "01H00000000000000000000001",
      type: "archive_workspace" as const,
      repoRoot: repo,
      worktreePath,
      branch: "sunset/journal-archive",
      keepBranch: false,
    };
    await expect(
      git.advanceWorkspaceOperation({
        ...common,
        target: "git_worktree_removed",
      }),
    ).resolves.toMatchObject({ state: "advanced" });

    await writeFile(path.join(repo, "changed.txt"), "changed\n");
    await execa("git", ["add", "changed.txt"], { cwd: repo });
    await execa("git", ["commit", "-m", "change branch identity"], {
      cwd: repo,
    });
    await execa(
      "git",
      ["update-ref", "refs/heads/sunset/journal-archive", "HEAD"],
      { cwd: repo },
    );

    await expect(
      git.advanceWorkspaceOperation({
        ...common,
        target: "branch_outcome_recorded",
      }),
    ).resolves.toMatchObject({
      state: "needs_attention",
      reason: "branch_changed",
    });
    await execa(
      "git",
      ["show-ref", "--verify", "refs/heads/sunset/journal-archive"],
      { cwd: repo },
    );
  });

  it("archives a missing worktree idempotently while retaining its branch", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    const worktreePath = path.join(parent, "journal-missing-archive");
    await git.createWorktree({
      repoRoot: repo,
      worktreePath,
      slug: "journal-missing-archive",
      branch: "sunset/journal-missing-archive",
      baseRef: "HEAD",
    });
    await execa("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repo,
    });
    const common = {
      operationId: "01H00000000000000000000004",
      type: "archive_workspace" as const,
      repoRoot: repo,
      worktreePath,
      branch: "sunset/journal-missing-archive",
      keepBranch: true,
      expectedHead: null,
    };

    await expect(
      git.advanceWorkspaceOperation({
        ...common,
        target: "git_worktree_removed",
      }),
    ).resolves.toMatchObject({ state: "advanced" });
    await expect(
      git.advanceWorkspaceOperation({
        ...common,
        target: "branch_outcome_recorded",
      }),
    ).resolves.toMatchObject({
      state: "advanced",
      branchOutcome: "kept",
    });
    await execa(
      "git",
      ["show-ref", "--verify", "refs/heads/sunset/journal-missing-archive"],
      { cwd: repo },
    );
  });

  it("marks a crash between worktree creation and provenance advance as ambiguous", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const git = createGit();
    const worktreePath = path.join(parent, "crash-window");
    await git.createWorktree({
      repoRoot: repo,
      worktreePath,
      slug: "crash-window",
      branch: "sunset/crash-window",
      baseRef: "HEAD",
    });
    const operationId = "01H00000000000000000000003";
    const repositoryIdentity = await realpath(path.join(repo, ".git"));
    const expectedHead = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repo })
    ).stdout.trim();
    const operationDirectory = path.join(
      repositoryIdentity,
      "sunset-operations",
    );
    await mkdir(operationDirectory, { recursive: true });
    await writeFile(
      path.join(operationDirectory, `${operationId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        operationId,
        type: "create_workspace",
        repositoryIdentity,
        worktreePath,
        branch: "sunset/crash-window",
        expectedHead,
        phase: "intent_recorded",
      })}\n`,
    );

    await expect(
      git.advanceWorkspaceOperation({
        operationId,
        type: "create_workspace",
        target: "git_worktree_created",
        repoRoot: repo,
        worktreePath,
        slug: "crash-window",
        branch: "sunset/crash-window",
        baseRef: "HEAD",
      }),
    ).resolves.toMatchObject({
      state: "needs_attention",
    });
    await access(worktreePath);
    await execa(
      "git",
      ["show-ref", "--verify", "refs/heads/sunset/crash-window"],
      { cwd: repo },
    );
  });

  it("leaves an uncertain path untouched during archive recovery", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const worktreePath = path.join(parent, "manual-directory");
    await mkdir(worktreePath);
    await writeFile(path.join(worktreePath, "user-data"), "keep\n");

    await expect(
      createGit().advanceWorkspaceOperation({
        operationId: "01H00000000000000000000002",
        type: "archive_workspace",
        target: "git_worktree_removed",
        repoRoot: repo,
        worktreePath,
        branch: "sunset/manual-directory",
        keepBranch: false,
      }),
    ).resolves.toMatchObject({
      state: "needs_attention",
      reason: "path_exists_outside_snapshot",
    });
    await access(path.join(worktreePath, "user-data"));
  });
});

describe("diffWorktree and commitWorktree", () => {
  async function workspaceWorktree(
    repo: string,
    parent: string,
    slug = "change",
  ) {
    const git = createGit();
    const worktreePath = path.join(parent, `wt-${slug}`);
    await git.createWorktree({
      repoRoot: repo,
      worktreePath,
      slug,
      branch: `sunset/${slug}`,
      baseRef: "main",
    });
    return { git, worktreePath };
  }

  it("reports uncommitted and untracked changes against HEAD by default", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const { git, worktreePath } = await workspaceWorktree(repo, parent);
    await writeFile(path.join(worktreePath, "README.md"), "edited\n");
    await writeFile(path.join(worktreePath, "fresh.txt"), "fresh\n");

    const result = await git.diffWorktree({ repoRoot: repo, worktreePath });

    expect(result.worktreePath).toBe(await realpath(worktreePath));
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.diff).toContain("README.md");
    expect(result.diff).toContain("+edited");
    expect(result.diff).toContain("fresh.txt");
    expect(result.diff).toContain("+fresh");
    expect(result.stat).toContain("fresh.txt");
  });

  it("includes committed branch changes and ignores base drift with baseRef", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const { git, worktreePath } = await workspaceWorktree(repo, parent);
    await writeFile(path.join(worktreePath, "feature.txt"), "from branch\n");
    await execa("git", ["add", "feature.txt"], { cwd: worktreePath });
    await execa("git", ["commit", "-m", "branch work"], { cwd: worktreePath });

    const vsHead = await git.diffWorktree({ repoRoot: repo, worktreePath });
    expect(vsHead.diff).toBe("");

    // The base ref moved after the worktree branched; its commits must not
    // appear as reverse changes in the workspace diff.
    await writeFile(path.join(repo, "main-only.txt"), "main moved\n");
    await execa("git", ["add", "main-only.txt"], { cwd: repo });
    await execa("git", ["commit", "-m", "main advances"], { cwd: repo });

    const vsBase = await git.diffWorktree({
      repoRoot: repo,
      worktreePath,
      baseRef: "main",
    });
    expect(vsBase.diff).toContain("feature.txt");
    expect(vsBase.diff).toContain("+from branch");
    expect(vsBase.diff).not.toContain("main-only.txt");
    expect(vsBase.stat).toContain("feature.txt");
  });

  it("stages all changes and commits them on the workspace branch", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const { git, worktreePath } = await workspaceWorktree(repo, parent);
    await writeFile(path.join(worktreePath, "README.md"), "edited\n");
    await writeFile(path.join(worktreePath, "fresh.txt"), "fresh\n");

    const result = await git.commitWorktree({
      repoRoot: repo,
      worktreePath,
      message: "agent edits",
    });

    const head = await execa("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
    });
    expect(result.commit).toBe(head.stdout.trim());
    const subject = await execa("git", ["log", "-1", "--format=%s"], {
      cwd: worktreePath,
    });
    expect(subject.stdout).toBe("agent edits");
    const branch = await execa("git", ["branch", "--show-current"], {
      cwd: worktreePath,
    });
    expect(branch.stdout).toBe("sunset/change");
    expect(result.summary).toContain("agent edits");
    expect(result.summary).toContain("fresh.txt");
    const status = await execa("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    });
    expect(status.stdout).toBe("");
  });

  it("rejects a commit when the worktree is clean or the message is empty", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const { git, worktreePath } = await workspaceWorktree(repo, parent);

    await expect(
      git.commitWorktree({ repoRoot: repo, worktreePath, message: "nope" }),
    ).rejects.toMatchObject({ code: "nothing_to_commit" });
    await expect(
      git.commitWorktree({ repoRoot: repo, worktreePath, message: "  " }),
    ).rejects.toMatchObject({ code: "invalid_options" });
  });

  it("rejects paths that are not worktrees of the repository", async () => {
    const { repo, parent } = await initRepo();
    temps.push(parent);
    const other = await initRepo();
    temps.push(other.parent);
    const git = createGit();
    const stray = path.join(parent, "stray");
    await mkdir(stray);

    await expect(
      git.diffWorktree({ repoRoot: repo, worktreePath: stray }),
    ).rejects.toMatchObject({ code: "worktree_not_found" });
    await expect(
      git.diffWorktree({ repoRoot: repo, worktreePath: repo }),
    ).rejects.toMatchObject({ code: "nested_worktree" });
    await expect(
      git.commitWorktree({
        repoRoot: repo,
        worktreePath: other.repo,
        message: "x",
      }),
    ).rejects.toMatchObject({ code: "worktree_not_found" });
  });
});
