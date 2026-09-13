import { access } from "node:fs/promises";
import path from "node:path";

import {
  isGitError,
  type GitWorktree,
  type RepositorySnapshot,
} from "@sunset/git";

import type {
  Project,
  ProjectReconciliation,
  ReconciliationEntry,
  Workspace,
} from "./types.js";

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function unavailable(project: Project, error: unknown): ProjectReconciliation {
  return {
    project,
    repositoryIdentity: null,
    inspectedAt: Date.now(),
    entries: [
      {
        state: "repository_unavailable",
        project,
        error: {
          code: isGitError(error) ? error.code : "inspection_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    ],
  };
}

export async function reconcileProject(
  project: Project,
  workspaces: Workspace[],
  inspect: () => Promise<RepositorySnapshot>,
): Promise<ProjectReconciliation> {
  let snapshot: RepositorySnapshot;
  try {
    snapshot = await inspect();
  } catch (error) {
    return unavailable(project, error);
  }

  const entries: ReconciliationEntry[] = [];
  const used = new Set<GitWorktree>();
  const expectedPaths = new Set(
    workspaces.map((workspace) => path.resolve(workspace.worktreePath)),
  );

  for (const workspace of workspaces) {
    const exact = snapshot.worktrees.filter((worktree) =>
      samePath(worktree.path, workspace.worktreePath),
    );
    if (exact.length > 1) {
      exact.forEach((worktree) => used.add(worktree));
      entries.push({
        state: "ambiguous",
        reason: "duplicate_canonical_path",
        workspace,
        worktrees: exact,
      });
      continue;
    }
    const matched = exact[0];
    if (matched) {
      used.add(matched);
      if (matched.bare) {
        entries.push({
          state: "ambiguous",
          reason: "unsupported_bare_worktree",
          workspace,
          worktrees: [matched],
        });
      } else if (!matched.pathExists || matched.prunable !== null) {
        entries.push({ state: "missing", workspace });
      } else if (matched.branch !== workspace.branch) {
        entries.push({
          state: "branch_mismatch",
          workspace,
          worktree: matched,
        });
      } else {
        entries.push({ state: "healthy", workspace, worktree: matched });
      }
      continue;
    }

    const branchMatches = snapshot.worktrees.filter(
      (worktree) =>
        worktree.branch === workspace.branch &&
        !samePath(worktree.path, snapshot.repoRoot),
    );
    if (branchMatches.length > 0) {
      for (const worktree of branchMatches) {
        if (!expectedPaths.has(path.resolve(worktree.path))) {
          used.add(worktree);
        }
      }
      entries.push({
        state: "ambiguous",
        reason: "branch_at_other_path",
        workspace,
        worktrees: branchMatches,
      });
    } else if (await exists(workspace.worktreePath)) {
      entries.push({
        state: "ambiguous",
        reason: "path_exists_outside_snapshot",
        workspace,
        worktrees: [],
      });
    } else {
      entries.push({ state: "missing", workspace });
    }
  }

  const remainingByPath = new Map<string, GitWorktree[]>();
  for (const worktree of snapshot.worktrees) {
    if (used.has(worktree) || samePath(worktree.path, snapshot.repoRoot)) {
      continue;
    }
    const key = path.resolve(worktree.path);
    const group = remainingByPath.get(key) ?? [];
    group.push(worktree);
    remainingByPath.set(key, group);
  }
  for (const worktrees of remainingByPath.values()) {
    if (worktrees.length > 1) {
      entries.push({
        state: "ambiguous",
        reason: "duplicate_canonical_path",
        worktrees,
      });
      continue;
    }
    const worktree = worktrees[0];
    if (!worktree) continue;
    entries.push(
      worktree.bare
        ? {
            state: "ambiguous",
            reason: "unsupported_bare_worktree",
            worktrees: [worktree],
          }
        : { state: "untracked_worktree", worktree },
    );
  }

  return {
    project,
    repositoryIdentity: snapshot.repositoryIdentity,
    inspectedAt: snapshot.inspectedAt,
    entries,
  };
}
