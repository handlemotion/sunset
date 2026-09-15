import type { Engine } from "@sunset/acp";
import type {
  AgentEvent,
  AgentMode,
  EngineCapabilities,
  EngineId,
  ExecutionPolicy,
  ExecutionPolicyInput,
  HostCapabilities,
  ModelCapability,
  ModelCatalogState,
  ModelSelection,
  Project,
  Run,
  RunError,
  RunResult,
  RunStatus,
  Session,
  SessionLocation,
  Workspace,
} from "@sunset/domain";
import type {
  GitService,
  GitWorktree,
  WorktreeCommit,
  WorktreeDiff,
} from "@sunset/git";

export type {
  AgentEvent,
  AgentMode,
  EngineCapabilities,
  EngineId,
  ExecutionPolicy,
  ExecutionPolicyInput,
  HostCapabilities,
  ModelCapability,
  ModelCatalogState,
  ModelSelection,
  Project,
  Run,
  RunError,
  RunResult,
  RunStatus,
  Session,
  SessionLocation,
  Workspace,
};

export type { WorktreeCommit, WorktreeDiff };

export type HostEvent = AgentEvent & {
  workspaceId: string;
  sessionId: string;
  runId: string;
  sequence: number;
};

export type ExecutionPolicyControl =
  "autoReview" | "sandbox" | "agentRetries" | "toolAllowlist" | "toolDenylist";

export type WorkspaceOperationType = "create_workspace" | "archive_workspace";
export type CreateWorkspaceOperationPhase =
  | "intent_recorded"
  | "git_worktree_created"
  | "path_verified"
  | "workspace_row_committed"
  | "operation_completed";
export type ArchiveWorkspaceOperationPhase =
  | "intent_recorded"
  | "active_runs_handled"
  | "git_worktree_removed"
  | "branch_outcome_recorded"
  | "workspace_archived";
export type WorkspaceOperationPhase =
  CreateWorkspaceOperationPhase | ArchiveWorkspaceOperationPhase;
export type WorkspaceOperationTerminalOutcome =
  "succeeded" | "failed" | "needs_attention";
export type WorkspaceOperationCompensationOutcome =
  "not_required" | "succeeded" | "failed" | "unsafe";
export type WorkspaceOperationBranchOutcome =
  "kept" | "deleted" | "already_absent";
export type WorkspaceOperationDiagnostic = {
  code: string;
  message: string;
  observed?: Readonly<Record<string, unknown>>;
};

export type CreateWorkspaceOperationInputs = {
  slug: string;
  branch: string;
  baseRef: string;
  worktreePath: string;
  copyGlobs: string[];
};

export type ArchiveWorkspaceOperationInputs = {
  branch: string;
  worktreePath: string;
  keepBranch: boolean;
  expectedHead: string | null;
};

type WorkspaceOperationBase = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  lastRecoveryAt: number | null;
  recoveryAttemptCount: number;
  terminalOutcome: WorkspaceOperationTerminalOutcome | null;
  terminalAt: number | null;
  compensationOutcome: WorkspaceOperationCompensationOutcome;
  diagnostic: WorkspaceOperationDiagnostic | null;
  branchOutcome: WorkspaceOperationBranchOutcome | null;
};

export type WorkspaceOperation =
  | (WorkspaceOperationBase & {
      type: "create_workspace";
      phase: CreateWorkspaceOperationPhase;
      requestedInputs: CreateWorkspaceOperationInputs;
    })
  | (WorkspaceOperationBase & {
      type: "archive_workspace";
      phase: ArchiveWorkspaceOperationPhase;
      requestedInputs: ArchiveWorkspaceOperationInputs;
    });

export type ReconciliationEntry =
  | { state: "healthy"; workspace: Workspace; worktree: GitWorktree }
  | { state: "missing"; workspace: Workspace }
  | {
      state: "branch_mismatch";
      workspace: Workspace;
      worktree: GitWorktree;
    }
  | { state: "untracked_worktree"; worktree: GitWorktree }
  | {
      state: "repository_unavailable";
      project: Project;
      error: { code: string; message: string };
    }
  | {
      state: "ambiguous";
      reason:
        | "branch_at_other_path"
        | "duplicate_canonical_path"
        | "path_exists_outside_snapshot"
        | "unsupported_bare_worktree";
      workspace?: Workspace;
      worktrees: GitWorktree[];
    };

export type ProjectReconciliation = {
  project: Project;
  repositoryIdentity: string | null;
  inspectedAt: number;
  entries: ReconciliationEntry[];
};

export type CreateHostOptions = {
  stateDir: string;
  worktreeRoot: string;
  leaseTimeoutMs?: number;
  engineIdleTtlMs?: number;
  maxEnginesPerWorkspace?: number;
  git?: GitService;
  engines?: Partial<Record<EngineId, Engine>>;
  executionPolicy?: ExecutionPolicyInput;
};

export type Host = {
  capabilities: () => Promise<HostCapabilities>;
  close: () => Promise<void>;
  suspend: () => Promise<void>;
  projects: {
    register: (repoRoot: string) => Promise<Project>;
    get: (id: string) => Project | undefined;
    list: () => Project[];
    reconcile: (input: { projectId: string }) => Promise<ProjectReconciliation>;
  };
  workspaces: {
    create: (input: {
      projectId: string;
      slug: string;
      branch?: string;
      baseRef?: string;
      copyGlobs?: string[];
    }) => Promise<Workspace>;
    list: (input: {
      projectId: string;
      includeArchived?: boolean;
    }) => Workspace[];
    get: (id: string) => Workspace | undefined;
    archive: (input: {
      workspaceId: string;
      keepBranch?: boolean;
    }) => Promise<Workspace>;
    /**
     * Patch of the workspace worktree against `baseRef` (defaults to the
     * workspace's recorded base ref), covering committed and uncommitted
     * changes. Reads git state directly; not a durable workspace operation.
     */
    diff: (input: {
      workspaceId: string;
      baseRef?: string;
    }) => Promise<WorktreeDiff>;
    /**
     * Stages all changes in the workspace worktree and commits them on the
     * workspace branch. Recorded in git only; not a durable workspace
     * operation, so it does not appear in diagnostics.operations.
     */
    commit: (input: {
      workspaceId: string;
      message: string;
    }) => Promise<WorktreeCommit>;
  };
  sessions: {
    create: (input: {
      workspaceId: string;
      engine?: EngineId;
      location?: SessionLocation;
      model?: ModelSelection;
      mode?: AgentMode;
      prompt: string;
      executionPolicy?: ExecutionPolicyInput;
    }) => Promise<{ session: Session; run: Run }>;
    send: (input: { sessionId: string; prompt: string }) => Promise<{
      session: Session;
      run: Run;
    }>;
    get: (id: string) => Session | undefined;
    list: (input: { workspaceId: string }) => Session[];
  };
  runs: {
    get: (id: string) => Run | undefined;
    list: (input: { sessionId: string }) => Run[];
    wait: (input: { runId: string }) => Promise<RunResult>;
    cancel: (input: { runId: string }) => Promise<RunResult>;
    attach: (input: {
      runId: string;
      afterSequence?: number;
      signal?: AbortSignal;
    }) => AsyncIterable<HostEvent>;
  };
  diagnostics: {
    operations: {
      get: (input: { operationId: string }) => WorkspaceOperation | undefined;
      list: (input?: {
        projectId?: string;
        workspaceId?: string;
        includeCompleted?: boolean;
      }) => WorkspaceOperation[];
    };
  };
};
