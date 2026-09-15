import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type E2eFixture = {
  /** Real-path temp root holding the repo, state dir, and worktree root. */
  root: string;
  /** A real git repository with one commit on `main`. */
  repo: string;
  stateDir: string;
  worktreeRoot: string;
  cleanup: () => Promise<void>;
};

/**
 * Builds an isolated sandbox: a fresh git repo plus empty `state/` and
 * `worktrees/` directories under one temp root.
 */
export async function createE2eFixture(): Promise<E2eFixture> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "sunset-e2e-")),
  );
  const repo = path.join(root, "repo");
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await mkdir(repo);
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "sunset-e2e@example.com"]);
    await git(["config", "user.name", "Sunset E2E"]);
    await writeFile(path.join(repo, "README.md"), "sunset e2e fixture\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "init"]);
    return {
      root,
      repo,
      stateDir: path.join(root, "state"),
      worktreeRoot: path.join(root, "worktrees"),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
