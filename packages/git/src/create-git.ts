import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import pLimit from "p-limit";

import { commitWorktree } from "./commit.js";
import { loadWorktreeConfig } from "./config.js";
import { assertCopyGlobs, copyGlobs } from "./copy.js";
import { diffWorktree } from "./diff.js";
import { GitError } from "./errors.js";
import { RepositoryLease } from "./lease.js";
import { RepoLock } from "./lock.js";
import {
  assertAbsolutePath,
  isPathInside,
  resolveExistingPrefix,
  resolveRepoRoot,
} from "./paths.js";
import { parseWorktreePorcelain } from "./porcelain.js";
import { runSetupCommand } from "./setup.js";
import { defaultGitSpawn } from "./spawn.js";
import type { WorktreeContext } from "./worktree.js";
import type {
  ArchiveWorktreeInput,
  CreateGitOptions,
  CreateWorktreeInput,
  CreatedWorktree,
  GitService,
  GitSpawn,
  GitWorktree,
  RepositorySnapshot,
  WorkspaceOperationStepInput,
  WorkspaceOperationStepResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LEASE_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const OPERATION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type OperationMarker = {
  schemaVersion: 1;
  operationId: string;
  type: "create_workspace" | "archive_workspace";
  repositoryIdentity: string;
  worktreePath: string;
  branch: string;
  expectedHead: string | null;
  branchOutcome?: "kept" | "deleted" | "already_absent";
  phase:
    | "intent_recorded"
    | "git_worktree_created"
    | "create_compensated"
    | "git_worktree_removed"
    | "branch_outcome_recorded";
};

function isTimeout(error: unknown): boolean {
  return error instanceof GitError && error.code === "timeout";
}

function isOperationMarker(value: unknown): value is OperationMarker {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Partial<OperationMarker>;
  return (
    marker.schemaVersion === 1 &&
    typeof marker.operationId === "string" &&
    (marker.type === "create_workspace" ||
      marker.type === "archive_workspace") &&
    typeof marker.repositoryIdentity === "string" &&
    typeof marker.worktreePath === "string" &&
    typeof marker.branch === "string" &&
    (marker.expectedHead === null || typeof marker.expectedHead === "string") &&
    (marker.branchOutcome === undefined ||
      marker.branchOutcome === "kept" ||
      marker.branchOutcome === "deleted" ||
      marker.branchOutcome === "already_absent") &&
    (marker.phase === "intent_recorded" ||
      marker.phase === "git_worktree_created" ||
      marker.phase === "create_compensated" ||
      marker.phase === "git_worktree_removed" ||
      marker.phase === "branch_outcome_recorded")
  );
}

export function createGit(options: CreateGitOptions = {}): GitService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new GitError("leaseTimeoutMs must be positive", "invalid_options");
  }
  const spawn: GitSpawn = options.spawn ?? defaultGitSpawn;
  const limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  const locks = new RepoLock();
  const leases = new RepositoryLease(leaseTimeoutMs);

  const git = (args: string[], cwd: string, timeout = timeoutMs) =>
    limit(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        return await spawn(args, {
          cwd,
          timeoutMs: timeout,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted && !isTimeout(error)) {
          throw new GitError(`git ${args.join(" ")} timed out`, "timeout", {
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });

  async function resolveRepository(repoRoot: string): Promise<{
    repoRoot: string;
    repositoryIdentity: string;
  }> {
    const requestedRoot = await resolveRepoRoot(repoRoot);
    const result = await git(
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      requestedRoot,
    );
    const [commonDirectory, topLevel] = result.stdout.split("\n");
    if (!commonDirectory || !topLevel) {
      throw new GitError("could not resolve repository identity", "git_failed");
    }
    try {
      return {
        repoRoot: await realpath(topLevel),
        repositoryIdentity: await realpath(commonDirectory),
      };
    } catch (cause) {
      throw new GitError(
        "could not canonicalize repository identity",
        "git_failed",
        {
          cause,
        },
      );
    }
  }

  async function listWorktreesUnlocked(
    repoRoot: string,
  ): Promise<GitWorktree[]> {
    const result = await git(["worktree", "list", "--porcelain"], repoRoot);
    return Promise.all(
      parseWorktreePorcelain(result.stdout).map(async (worktree) => {
        try {
          return {
            ...worktree,
            path: await realpath(worktree.path),
            pathExists: true,
          };
        } catch {
          return {
            ...worktree,
            path: await resolveExistingPrefix(path.resolve(worktree.path)),
            pathExists: false,
          };
        }
      }),
    );
  }

  async function inspectRepository(
    repoRoot: string,
  ): Promise<RepositorySnapshot> {
    const repository = await resolveRepository(repoRoot);
    return {
      ...repository,
      inspectedAt: Date.now(),
      worktrees: await listWorktreesUnlocked(repository.repoRoot),
    };
  }

  async function branchExists(
    repoRoot: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await git(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        repoRoot,
      );
      return true;
    } catch (error) {
      if (error instanceof GitError && error.code === "git_failed") {
        return false;
      }
      throw error;
    }
  }

  async function branchHead(
    repoRoot: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const result = await git(
        ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
        repoRoot,
      );
      return result.stdout.trim() || null;
    } catch (error) {
      if (error instanceof GitError && error.code === "git_failed") return null;
      throw error;
    }
  }

  function markerPath(repositoryIdentity: string, operationId: string): string {
    if (!OPERATION_ID.test(operationId)) {
      throw new GitError("invalid workspace operation ID", "invalid_options");
    }
    return path.join(
      repositoryIdentity,
      "sunset-operations",
      `${operationId}.json`,
    );
  }

  async function readMarker(
    repositoryIdentity: string,
    operationId: string,
  ): Promise<OperationMarker | "invalid" | undefined> {
    try {
      const value: unknown = JSON.parse(
        await readFile(markerPath(repositoryIdentity, operationId), "utf8"),
      );
      return isOperationMarker(value) ? value : "invalid";
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        return error instanceof SyntaxError ? "invalid" : undefined;
      }
      throw error;
    }
  }

  async function writeMarker(marker: OperationMarker): Promise<void> {
    const target = markerPath(marker.repositoryIdentity, marker.operationId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async function targetExists(target: string): Promise<boolean> {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  async function validateCreateInput(
    repoRoot: string,
    input: CreateWorktreeInput,
  ): Promise<string> {
    if (input.branch.startsWith("-")) {
      throw new GitError(`invalid branch: ${input.branch}`, "invalid_ref");
    }
    await git(["check-ref-format", `refs/heads/${input.branch}`], repoRoot);
    if (input.baseRef.startsWith("-")) {
      throw new GitError(`invalid baseRef: ${input.baseRef}`, "invalid_ref");
    }
    const resolved = await git(
      ["rev-parse", "--verify", `${input.baseRef}^{commit}`],
      repoRoot,
    );
    const expectedHead = resolved.stdout.trim();
    if (!expectedHead) {
      throw new GitError("could not resolve baseRef", "git_failed");
    }
    return expectedHead;
  }

  async function createWorktreeUnlocked(
    repository: { repoRoot: string; repositoryIdentity: string },
    input: CreateWorktreeInput,
    worktreePath: string,
    existingMarker?: OperationMarker,
  ): Promise<CreatedWorktree> {
    const repoRoot = repository.repoRoot;
    const config = await loadWorktreeConfig(repoRoot, input.copyGlobs);
    assertCopyGlobs(config.copy);
    const expectedHead = await validateCreateInput(repoRoot, input);
    if (await branchExists(repoRoot, input.branch)) {
      throw new GitError(
        `branch already exists: ${input.branch}`,
        "branch_exists",
      );
    }
    let marker = existingMarker;
    if (input.operationId) {
      marker = {
        schemaVersion: 1,
        operationId: input.operationId,
        type: "create_workspace",
        repositoryIdentity: repository.repositoryIdentity,
        worktreePath,
        branch: input.branch,
        expectedHead,
        phase: "intent_recorded",
      };
      await writeMarker(marker);
    }
    await git(
      ["worktree", "add", "-b", input.branch, worktreePath, input.baseRef],
      repoRoot,
    );
    try {
      const copied = await copyGlobs(repoRoot, worktreePath, config.copy);
      let setupRan = false;
      if (config.commands.length > 0) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SETUP_TIMEOUT_MS);
        try {
          for (const command of config.commands) {
            await runSetupCommand(
              command.cursorScript
                ? path.join(worktreePath, command.command)
                : command.command,
              {
                cwd: worktreePath,
                timeoutMs: SETUP_TIMEOUT_MS,
                env: { ROOT_WORKTREE_PATH: repoRoot },
                signal: controller.signal,
              },
            );
          }
        } finally {
          clearTimeout(timer);
        }
        setupRan = true;
      }
      if (marker) {
        await writeMarker({ ...marker, phase: "git_worktree_created" });
      }
      return {
        worktreePath,
        branch: input.branch,
        slug: input.slug,
        copied,
        setupRan,
      };
    } catch (error) {
      await rollbackCreate(repoRoot, worktreePath, input.branch);
      throw error;
    }
  }

  async function rollbackCreate(
    repoRoot: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    try {
      await git(["worktree", "remove", "--force", worktreePath], repoRoot);
    } catch {
      // worktree may not have been registered
    }
    try {
      if (await branchExists(repoRoot, branch)) {
        await git(["branch", "-D", "--", branch], repoRoot);
      }
    } catch {
      // best-effort cleanup
    }
  }

  function needsAttention(
    repositoryIdentity: string,
    reason: Extract<
      WorkspaceOperationStepResult,
      { state: "needs_attention" }
    >["reason"],
    observed?: Readonly<Record<string, unknown>>,
  ): WorkspaceOperationStepResult {
    const result: WorkspaceOperationStepResult = {
      state: "needs_attention",
      reason,
      repositoryIdentity,
    };
    if (observed !== undefined) result.observed = observed;
    return result;
  }

  function markerMatches(
    marker: OperationMarker,
    input: WorkspaceOperationStepInput,
    repositoryIdentity: string,
    worktreePath: string,
  ): boolean {
    return (
      marker.operationId === input.operationId &&
      marker.type === input.type &&
      marker.repositoryIdentity === repositoryIdentity &&
      path.resolve(marker.worktreePath) === path.resolve(worktreePath) &&
      marker.branch === input.branch
    );
  }

  async function advanceWorkspaceOperationUnlocked(
    repository: { repoRoot: string; repositoryIdentity: string },
    input: WorkspaceOperationStepInput,
    worktreePath: string,
  ): Promise<WorkspaceOperationStepResult> {
    const repoRoot = repository.repoRoot;
    let marker = await readMarker(
      repository.repositoryIdentity,
      input.operationId,
    );
    if (marker === "invalid") {
      return needsAttention(
        repository.repositoryIdentity,
        "operation_marker_invalid",
      );
    }
    const listed = await listWorktreesUnlocked(repoRoot);
    const exact = listed.filter(
      (row) => path.resolve(row.path) === path.resolve(worktreePath),
    );
    if (exact.length > 1) {
      return needsAttention(
        repository.repositoryIdentity,
        "duplicate_canonical_path",
        { count: exact.length, worktreePath },
      );
    }

    if (input.type === "create_workspace") {
      if (!marker) {
        const branch = await branchHead(repoRoot, input.branch);
        if (
          exact.length > 0 ||
          branch !== null ||
          (await targetExists(worktreePath))
        ) {
          return needsAttention(
            repository.repositoryIdentity,
            "operation_marker_missing",
            {
              branchExists: branch !== null,
              pathExists: await targetExists(worktreePath),
            },
          );
        }
        await createWorktreeUnlocked(
          repository,
          { ...input, operationId: input.operationId },
          worktreePath,
        );
        marker = await readMarker(
          repository.repositoryIdentity,
          input.operationId,
        );
      } else if (
        !markerMatches(
          marker,
          input,
          repository.repositoryIdentity,
          worktreePath,
        )
      ) {
        return needsAttention(
          repository.repositoryIdentity,
          "operation_identity_mismatch",
        );
      } else if (marker.phase === "intent_recorded") {
        if (
          exact.length > 0 ||
          (await branchHead(repoRoot, input.branch)) !== null
        ) {
          return needsAttention(
            repository.repositoryIdentity,
            "worktree_mismatch",
            { markerPhase: marker.phase },
          );
        }
        await createWorktreeUnlocked(
          repository,
          { ...input, operationId: input.operationId },
          worktreePath,
          marker,
        );
        marker = await readMarker(
          repository.repositoryIdentity,
          input.operationId,
        );
      }
      if (!marker || marker === "invalid") {
        return needsAttention(
          repository.repositoryIdentity,
          "operation_marker_missing",
        );
      }
      if (input.target === "create_compensated") {
        if (marker.phase === "create_compensated") {
          return {
            state: "advanced",
            repositoryIdentity: repository.repositoryIdentity,
            worktreePath,
            expectedHead: marker.expectedHead,
          };
        }
        if (marker.phase !== "git_worktree_created") {
          return needsAttention(
            repository.repositoryIdentity,
            "operation_identity_mismatch",
            { markerPhase: marker.phase },
          );
        }
        const current = (await listWorktreesUnlocked(repoRoot)).filter(
          (row) => path.resolve(row.path) === path.resolve(worktreePath),
        );
        if (current.length !== 1) {
          return needsAttention(
            repository.repositoryIdentity,
            current.length > 1
              ? "duplicate_canonical_path"
              : "worktree_missing",
          );
        }
        const worktree = current[0];
        if (
          !worktree ||
          worktree.bare ||
          !worktree.pathExists ||
          worktree.branch !== input.branch ||
          worktree.head !== marker.expectedHead
        ) {
          return needsAttention(
            repository.repositoryIdentity,
            "worktree_mismatch",
          );
        }
        await git(["worktree", "remove", "--force", worktreePath], repoRoot);
        const currentHead = await branchHead(repoRoot, input.branch);
        if (currentHead !== null) {
          if (
            marker.expectedHead === null ||
            currentHead !== marker.expectedHead
          ) {
            return needsAttention(
              repository.repositoryIdentity,
              "branch_changed",
              { expectedHead: marker.expectedHead, currentHead },
            );
          }
          await git(
            [
              "update-ref",
              "-d",
              `refs/heads/${input.branch}`,
              marker.expectedHead,
            ],
            repoRoot,
          );
        }
        await writeMarker({ ...marker, phase: "create_compensated" });
        return {
          state: "advanced",
          repositoryIdentity: repository.repositoryIdentity,
          worktreePath,
          expectedHead: marker.expectedHead,
        };
      }
      if (marker.phase !== "git_worktree_created") {
        return needsAttention(
          repository.repositoryIdentity,
          "operation_identity_mismatch",
          { markerPhase: marker.phase },
        );
      }
      const current = (await listWorktreesUnlocked(repoRoot)).filter(
        (row) => path.resolve(row.path) === path.resolve(worktreePath),
      );
      if (current.length !== 1) {
        return needsAttention(
          repository.repositoryIdentity,
          current.length > 1 ? "duplicate_canonical_path" : "worktree_missing",
        );
      }
      const worktree = current[0];
      if (!worktree) {
        return needsAttention(
          repository.repositoryIdentity,
          "worktree_missing",
        );
      }
      if (worktree.bare) {
        return needsAttention(
          repository.repositoryIdentity,
          "unsupported_bare_worktree",
        );
      }
      if (
        !worktree.pathExists ||
        worktree.branch !== input.branch ||
        worktree.head !== marker.expectedHead
      ) {
        return needsAttention(
          repository.repositoryIdentity,
          "worktree_mismatch",
          {
            pathExists: worktree.pathExists,
            branch: worktree.branch,
            head: worktree.head,
          },
        );
      }
      return {
        state: "advanced",
        repositoryIdentity: repository.repositoryIdentity,
        worktreePath: worktree.path,
        expectedHead: marker.expectedHead,
      };
    }

    if (!marker) {
      const worktree = exact[0];
      if (worktree?.bare) {
        return needsAttention(
          repository.repositoryIdentity,
          "unsupported_bare_worktree",
        );
      }
      if (
        worktree &&
        (!worktree.pathExists || worktree.branch !== input.branch)
      ) {
        return needsAttention(
          repository.repositoryIdentity,
          "worktree_mismatch",
          { pathExists: worktree.pathExists, branch: worktree.branch },
        );
      }
      const observedHead =
        worktree?.head ?? (await branchHead(repoRoot, input.branch));
      if (
        input.expectedHead !== undefined &&
        input.expectedHead !== null &&
        observedHead !== null &&
        observedHead !== input.expectedHead
      ) {
        return needsAttention(repository.repositoryIdentity, "branch_changed", {
          expectedHead: input.expectedHead,
          currentHead: observedHead,
        });
      }
      if (
        input.expectedHead === null &&
        !worktree &&
        !input.keepBranch &&
        observedHead !== null
      ) {
        return needsAttention(repository.repositoryIdentity, "branch_changed", {
          expectedHead: input.expectedHead,
          currentHead: observedHead,
        });
      }
      const expectedHead =
        input.expectedHead === undefined ||
        (input.expectedHead === null && (worktree || input.keepBranch))
          ? observedHead
          : input.expectedHead;
      marker = {
        schemaVersion: 1,
        operationId: input.operationId,
        type: input.type,
        repositoryIdentity: repository.repositoryIdentity,
        worktreePath,
        branch: input.branch,
        expectedHead,
        phase: "intent_recorded",
      };
      await writeMarker(marker);
    } else if (
      !markerMatches(marker, input, repository.repositoryIdentity, worktreePath)
    ) {
      return needsAttention(
        repository.repositoryIdentity,
        "operation_identity_mismatch",
      );
    }

    if (input.target === "git_worktree_removed") {
      if (
        marker.phase === "git_worktree_removed" ||
        marker.phase === "branch_outcome_recorded"
      ) {
        return {
          state: "advanced",
          repositoryIdentity: repository.repositoryIdentity,
          worktreePath,
          expectedHead: marker.expectedHead,
        };
      }
      const worktree = exact[0];
      if (worktree) {
        if (
          worktree.bare ||
          !worktree.pathExists ||
          worktree.branch !== input.branch ||
          (marker.expectedHead !== null &&
            worktree.head !== marker.expectedHead)
        ) {
          return needsAttention(
            repository.repositoryIdentity,
            worktree.bare ? "unsupported_bare_worktree" : "worktree_mismatch",
            { branch: worktree.branch, head: worktree.head },
          );
        }
        await git(["worktree", "remove", "--force", worktreePath], repoRoot);
      } else if (await targetExists(worktreePath)) {
        return needsAttention(
          repository.repositoryIdentity,
          "path_exists_outside_snapshot",
          { worktreePath },
        );
      }
      marker = { ...marker, phase: "git_worktree_removed" };
      await writeMarker(marker);
      return {
        state: "advanced",
        repositoryIdentity: repository.repositoryIdentity,
        worktreePath,
        expectedHead: marker.expectedHead,
      };
    }

    if (
      marker.phase !== "git_worktree_removed" &&
      marker.phase !== "branch_outcome_recorded"
    ) {
      return needsAttention(
        repository.repositoryIdentity,
        "operation_identity_mismatch",
        { markerPhase: marker.phase },
      );
    }
    if (marker.phase === "branch_outcome_recorded" && marker.branchOutcome) {
      return {
        state: "advanced",
        repositoryIdentity: repository.repositoryIdentity,
        worktreePath,
        expectedHead: marker.expectedHead,
        branchOutcome: marker.branchOutcome,
      };
    }
    const currentHead = await branchHead(repoRoot, input.branch);
    let branchOutcome: "kept" | "deleted" | "already_absent";
    if (input.keepBranch) {
      branchOutcome = currentHead === null ? "already_absent" : "kept";
    } else if (currentHead === null) {
      branchOutcome = "already_absent";
    } else if (
      marker.expectedHead === null ||
      currentHead !== marker.expectedHead
    ) {
      return needsAttention(repository.repositoryIdentity, "branch_changed", {
        expectedHead: marker.expectedHead,
        currentHead,
      });
    } else {
      await git(
        ["update-ref", "-d", `refs/heads/${input.branch}`, marker.expectedHead],
        repoRoot,
      );
      branchOutcome = "deleted";
    }
    marker = {
      ...marker,
      phase: "branch_outcome_recorded",
      branchOutcome,
    };
    await writeMarker(marker);
    return {
      state: "advanced",
      repositoryIdentity: repository.repositoryIdentity,
      worktreePath,
      expectedHead: marker.expectedHead,
      branchOutcome,
    };
  }

  async function advanceWorkspaceOperation(
    input: WorkspaceOperationStepInput,
  ): Promise<WorkspaceOperationStepResult> {
    const repository = await resolveRepository(input.repoRoot);
    const worktreePath = await resolveExistingPrefix(
      assertAbsolutePath("worktreePath", input.worktreePath),
    );
    if (isPathInside(repository.repoRoot, worktreePath)) {
      throw new GitError(
        "worktreePath must not be inside the source repo",
        "nested_worktree",
      );
    }
    return locks.run(repository.repositoryIdentity, () =>
      leases.run(
        repository.repositoryIdentity,
        "recover_workspace_operation",
        () =>
          advanceWorkspaceOperationUnlocked(repository, input, worktreePath),
        input.operationId,
      ),
    );
  }

  const worktreeContext: WorktreeContext = {
    git,
    locks,
    leases,
    resolveRepository,
  };

  return {
    inspectRepository,
    advanceWorkspaceOperation,
    diffWorktree: (input) => diffWorktree(worktreeContext, input),
    commitWorktree: (input) => commitWorktree(worktreeContext, input),

    async listWorktrees(repoRoot) {
      return (await inspectRepository(repoRoot)).worktrees;
    },

    async createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
      const repository = await resolveRepository(input.repoRoot);
      const repoRoot = repository.repoRoot;
      const worktreePath = await resolveExistingPrefix(
        assertAbsolutePath("worktreePath", input.worktreePath),
      );
      if (isPathInside(repoRoot, worktreePath)) {
        throw new GitError(
          "worktreePath must not be inside the source repo",
          "nested_worktree",
        );
      }
      return locks.run(repository.repositoryIdentity, () =>
        leases.run(
          repository.repositoryIdentity,
          "create_worktree",
          () => createWorktreeUnlocked(repository, input, worktreePath),
          input.operationId,
        ),
      );
    },

    async archiveWorktree(input: ArchiveWorktreeInput): Promise<void> {
      if (input.operationId) {
        const common = {
          operationId: input.operationId,
          type: "archive_workspace" as const,
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          branch: input.branch,
          keepBranch: input.keepBranch ?? true,
        };
        const removed = await advanceWorkspaceOperation({
          ...common,
          target: "git_worktree_removed",
        });
        if (removed.state === "needs_attention") {
          throw new GitError(
            `archive operation needs attention: ${removed.reason}`,
            "operation_needs_attention",
            { details: removed.observed },
          );
        }
        const branch = await advanceWorkspaceOperation({
          ...common,
          target: "branch_outcome_recorded",
        });
        if (branch.state === "needs_attention") {
          throw new GitError(
            `archive operation needs attention: ${branch.reason}`,
            "operation_needs_attention",
            { details: branch.observed },
          );
        }
        return;
      }
      const repository = await resolveRepository(input.repoRoot);
      const repoRoot = repository.repoRoot;
      const worktreePath = await resolveExistingPrefix(
        assertAbsolutePath("worktreePath", input.worktreePath),
      );
      const keepBranch = input.keepBranch ?? true;
      await locks.run(repository.repositoryIdentity, () =>
        leases.run(
          repository.repositoryIdentity,
          "archive_worktree",
          async () => {
            const listed = await listWorktreesUnlocked(repoRoot);
            const present = listed.some(
              (row) => path.resolve(row.path) === path.resolve(worktreePath),
            );
            if (present) {
              await git(
                ["worktree", "remove", "--force", worktreePath],
                repoRoot,
              );
            }
            if (!keepBranch && (await branchExists(repoRoot, input.branch))) {
              await git(["branch", "-D", "--", input.branch], repoRoot);
            }
          },
        ),
      );
    },
  };
}
