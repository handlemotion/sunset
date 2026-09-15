import { GitError } from "./errors.js";
import type { DiffWorktreeInput, WorktreeDiff } from "./types.js";
import { resolveWorkspaceWorktree, type WorktreeContext } from "./worktree.js";

async function resolveBase(
  context: WorktreeContext,
  worktreePath: string,
  baseRef: string,
  head: string,
): Promise<string> {
  if (baseRef.startsWith("-")) {
    throw new GitError(`invalid baseRef: ${baseRef}`, "invalid_ref");
  }
  const resolved = await context.git(
    ["rev-parse", "--verify", `${baseRef}^{commit}`],
    worktreePath,
  );
  const base = resolved.stdout.trim();
  if (!base) {
    throw new GitError("could not resolve baseRef", "git_failed");
  }
  // Diff from the fork point so commits landing on the base ref after the
  // worktree branched do not appear as reverse changes.
  try {
    const mergeBase = await context.git(
      ["merge-base", base, head],
      worktreePath,
    );
    return mergeBase.stdout.trim() || base;
  } catch (error) {
    if (error instanceof GitError && error.code === "git_failed") {
      return base;
    }
    throw error;
  }
}

export async function diffWorktree(
  context: WorktreeContext,
  input: DiffWorktreeInput,
): Promise<WorktreeDiff> {
  const resolved = await resolveWorkspaceWorktree(context, input);
  const worktreePath = resolved.worktreePath;
  return context.locks.run(resolved.repositoryIdentity, () =>
    context.leases.run(
      resolved.repositoryIdentity,
      "diff_worktree",
      async () => {
        const head = (
          await context.git(["rev-parse", "HEAD"], worktreePath)
        ).stdout.trim();
        const base =
          input.baseRef === undefined
            ? head
            : await resolveBase(context, worktreePath, input.baseRef, head);
        // Intent-to-add lets untracked files appear in the diff without
        // staging their contents.
        await context.git(["add", "-N", "--", "."], worktreePath);
        const [patch, stat] = await Promise.all([
          context.git(["diff", base], worktreePath),
          context.git(["diff", "--stat", base], worktreePath),
        ]);
        return {
          worktreePath,
          head,
          diff: patch.stdout,
          stat: stat.stdout.trim(),
        };
      },
    ),
  );
}
