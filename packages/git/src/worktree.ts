import { realpath } from "node:fs/promises";

import { GitError } from "./errors.js";
import type { RepositoryLease } from "./lease.js";
import type { RepoLock } from "./lock.js";
import {
  assertAbsolutePath,
  isPathInside,
  resolveExistingPrefix,
} from "./paths.js";
import type { GitSpawnResult } from "./types.js";

export type GitRun = (
  args: string[],
  cwd: string,
  timeout?: number,
) => Promise<GitSpawnResult>;

export type ResolvedRepository = {
  repoRoot: string;
  repositoryIdentity: string;
};

export type WorktreeContext = {
  git: GitRun;
  locks: RepoLock;
  leases: RepositoryLease;
  resolveRepository: (repoRoot: string) => Promise<ResolvedRepository>;
};

export type ResolvedWorktree = ResolvedRepository & {
  worktreePath: string;
};

export async function resolveWorkspaceWorktree(
  context: WorktreeContext,
  input: { repoRoot: string; worktreePath: string },
): Promise<ResolvedWorktree> {
  const repository = await context.resolveRepository(input.repoRoot);
  const worktreePath = await resolveExistingPrefix(
    assertAbsolutePath("worktreePath", input.worktreePath),
  );
  if (isPathInside(repository.repoRoot, worktreePath)) {
    throw new GitError(
      "worktreePath must not be inside the source repo",
      "nested_worktree",
    );
  }
  let commonDirectory: string | undefined;
  let topLevel: string | undefined;
  try {
    const result = await context.git(
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      worktreePath,
    );
    [commonDirectory, topLevel] = result.stdout.split("\n");
  } catch (cause) {
    throw new GitError(
      `not a git worktree: ${worktreePath}`,
      "worktree_not_found",
      { cause },
    );
  }
  if (!commonDirectory || !topLevel) {
    throw new GitError(
      `not a git worktree: ${worktreePath}`,
      "worktree_not_found",
    );
  }
  const [common, top] = await Promise.all([
    realpath(commonDirectory),
    realpath(topLevel),
  ]);
  if (common !== repository.repositoryIdentity || top !== worktreePath) {
    throw new GitError(
      `worktree does not belong to this repository: ${worktreePath}`,
      "worktree_not_found",
    );
  }
  return { ...repository, worktreePath };
}
