import { GitError } from "./errors.js";
import type { CommitWorktreeInput, WorktreeCommit } from "./types.js";
import { resolveWorkspaceWorktree, type WorktreeContext } from "./worktree.js";

async function hasConfig(
  context: WorktreeContext,
  worktreePath: string,
  key: string,
): Promise<boolean> {
  try {
    const result = await context.git(["config", "--get", key], worktreePath);
    return result.stdout.trim().length > 0;
  } catch (error) {
    if (error instanceof GitError && error.code === "git_failed") {
      return false;
    }
    throw error;
  }
}

export async function commitWorktree(
  context: WorktreeContext,
  input: CommitWorktreeInput,
): Promise<WorktreeCommit> {
  if (input.message.trim().length === 0) {
    throw new GitError("commit message must not be empty", "invalid_options");
  }
  const resolved = await resolveWorkspaceWorktree(context, input);
  const worktreePath = resolved.worktreePath;
  return context.locks.run(resolved.repositoryIdentity, () =>
    context.leases.run(
      resolved.repositoryIdentity,
      "commit_worktree",
      async () => {
        const status = await context.git(
          ["status", "--porcelain"],
          worktreePath,
        );
        if (status.stdout.trim().length === 0) {
          throw new GitError("nothing to commit", "nothing_to_commit");
        }
        await context.git(["add", "-A", "--", "."], worktreePath);
        const overrides: string[] = [];
        if (!(await hasConfig(context, worktreePath, "user.name"))) {
          overrides.push("-c", "user.name=Sunset");
        }
        if (!(await hasConfig(context, worktreePath, "user.email"))) {
          overrides.push("-c", "user.email=sunset@localhost");
        }
        await context.git(
          [...overrides, "commit", "-m", input.message],
          worktreePath,
        );
        const commit = (
          await context.git(["rev-parse", "HEAD"], worktreePath)
        ).stdout.trim();
        const summary = (
          await context.git(
            ["show", "--stat", "--format=%s", commit],
            worktreePath,
          )
        ).stdout.trim();
        return { commit, summary };
      },
    ),
  );
}
