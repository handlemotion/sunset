export type GitSpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitSpawn = (
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) => Promise<GitSpawnResult>;

export type GitWorktree = {
  path: string;
  pathExists: boolean;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
};

export type RepositorySnapshot = {
  repositoryIdentity: string;
  repoRoot: string;
  inspectedAt: number;
  worktrees: GitWorktree[];
};

export type RepositoryLeaseOwner = {
  schemaVersion: 1;
  leaseId: string;
  repositoryIdentity: string;
  operation:
    | "create_worktree"
    | "archive_worktree"
    | "recover_workspace_operation"
    | "diff_worktree"
    | "commit_worktree";
  operationId?: string;
  pid: number;
  hostname: string;
  processStartFingerprint: string;
  acquiredAt: number;
};

export type CreatedWorktree = {
  worktreePath: string;
  branch: string;
  slug: string;
  copied: string[];
  setupRan: boolean;
};

export type CreateWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  slug: string;
  branch: string;
  baseRef: string;
  copyGlobs?: string[];
  operationId?: string;
};

export type ArchiveWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  keepBranch?: boolean;
  operationId?: string;
};

export type WorkspaceOperationStepInput =
  | {
      operationId: string;
      type: "create_workspace";
      target: "git_worktree_created" | "create_compensated";
      repoRoot: string;
      worktreePath: string;
      slug: string;
      branch: string;
      baseRef: string;
      copyGlobs?: string[];
    }
  | {
      operationId: string;
      type: "archive_workspace";
      target: "git_worktree_removed" | "branch_outcome_recorded";
      repoRoot: string;
      worktreePath: string;
      branch: string;
      keepBranch: boolean;
      expectedHead?: string | null;
    };

export type WorkspaceOperationAttentionReason =
  | "operation_marker_missing"
  | "operation_marker_invalid"
  | "operation_identity_mismatch"
  | "repository_identity_mismatch"
  | "duplicate_canonical_path"
  | "path_exists_outside_snapshot"
  | "worktree_missing"
  | "worktree_mismatch"
  | "branch_changed"
  | "unsupported_bare_worktree";

export type WorkspaceOperationStepResult =
  | {
      state: "advanced";
      repositoryIdentity: string;
      worktreePath: string;
      expectedHead: string | null;
      branchOutcome?: "kept" | "deleted" | "already_absent";
    }
  | {
      state: "needs_attention";
      reason: WorkspaceOperationAttentionReason;
      repositoryIdentity: string;
      observed?: Readonly<Record<string, unknown>>;
    };

export type SunsetJson = {
  copy?: string[];
  setup?: string | string[];
};

export type DiffWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  baseRef?: string;
};

export type WorktreeDiff = {
  worktreePath: string;
  head: string;
  diff: string;
  stat: string;
};

export type CommitWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  message: string;
};

export type WorktreeCommit = {
  commit: string;
  summary: string;
};

export type GitService = {
  createWorktree: (input: CreateWorktreeInput) => Promise<CreatedWorktree>;
  inspectRepository: (repoRoot: string) => Promise<RepositorySnapshot>;
  listWorktrees: (repoRoot: string) => Promise<GitWorktree[]>;
  archiveWorktree: (input: ArchiveWorktreeInput) => Promise<void>;
  advanceWorkspaceOperation: (
    input: WorkspaceOperationStepInput,
  ) => Promise<WorkspaceOperationStepResult>;
  diffWorktree: (input: DiffWorktreeInput) => Promise<WorktreeDiff>;
  commitWorktree: (input: CommitWorktreeInput) => Promise<WorktreeCommit>;
};

export type CreateGitOptions = {
  timeoutMs?: number;
  leaseTimeoutMs?: number;
  concurrency?: number;
  spawn?: GitSpawn;
};
