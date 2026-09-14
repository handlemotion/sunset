import type {
  AgentMode,
  EngineId,
  ExecutionPolicyInput,
  HostCapabilities,
  ModelParameterValue,
  Project,
  Run,
  RunResult,
  Session,
  SessionLocation,
  Workspace,
} from "@sunset/domain";

// ---------------------------------------------------------------------------
// Wire-only types
//
// These shapes cross the HTTP boundary but are not part of @sunset/domain.
// They are declared here (mirroring @sunset/host and @sunset/git) so this
// package has no dependency on either.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const routes = {
  capabilities: { method: "GET", path: "/api/capabilities" },
  listProjects: { method: "GET", path: "/api/projects" },
  addProject: { method: "POST", path: "/api/projects" },
  listWorkspaces: {
    method: "GET",
    path: "/api/projects/:projectId/workspaces",
  },
  createWorkspace: {
    method: "POST",
    path: "/api/projects/:projectId/workspaces",
  },
  reconcileProject: {
    method: "GET",
    path: "/api/projects/:projectId/reconcile",
  },
  getWorkspace: { method: "GET", path: "/api/workspaces/:workspaceId" },
  archiveWorkspace: {
    method: "POST",
    path: "/api/workspaces/:workspaceId/archive",
  },
  listSessions: {
    method: "GET",
    path: "/api/workspaces/:workspaceId/sessions",
  },
  createSession: {
    method: "POST",
    path: "/api/workspaces/:workspaceId/sessions",
  },
  listRuns: { method: "GET", path: "/api/sessions/:sessionId/runs" },
  send: { method: "POST", path: "/api/sessions/:sessionId/runs" },
  getRun: { method: "GET", path: "/api/runs/:runId" },
  cancelRun: { method: "POST", path: "/api/runs/:runId/cancel" },
  waitRun: { method: "GET", path: "/api/runs/:runId/wait" },
  listOperations: { method: "GET", path: "/api/diagnostics/operations" },
  runEvents: { method: "WS", path: "/api/runs/:runId/events" },
} as const;

export type RouteName = keyof typeof routes;

// ---------------------------------------------------------------------------
// Request/response envelopes (mirror packages/server/src/server.ts exactly)
// ---------------------------------------------------------------------------

export type CapabilitiesResponse = HostCapabilities;

export type ListProjectsResponse = { projects: Project[] };
export type AddProjectRequest = { repoRoot: string };
export type AddProjectResponse = Project;

export type ListWorkspacesResponse = { workspaces: Workspace[] };
export type CreateWorkspaceRequest = {
  slug: string;
  branch?: string;
  baseRef?: string;
  copyGlobs?: string[];
};
export type CreateWorkspaceResponse = Workspace;

export type ReconcileProjectResponse = ProjectReconciliation;

export type GetWorkspaceResponse = Workspace | null;
export type ArchiveWorkspaceRequest = { keepBranch?: boolean };
export type ArchiveWorkspaceResponse = Workspace;

export type ListSessionsResponse = { sessions: Session[] };
export type CreateSessionRequest = {
  prompt: string;
  engine?: EngineId;
  location?: SessionLocation;
  mode?: AgentMode;
  model?: { id: string; params?: ModelParameterValue[] };
  executionPolicy?: ExecutionPolicyInput;
};
export type CreateSessionResponse = { session: Session; run: Run };

export type ListRunsResponse = { runs: Run[] };
export type SendRequest = { prompt: string };
export type SendResponse = { session: Session; run: Run };

export type GetRunResponse = Run | null;
export type CancelRunResponse = RunResult;
export type WaitRunResponse = RunResult;

export type ListOperationsResponse = { operations: WorkspaceOperation[] };

export type ErrorResponse = { error: { code: string; message: string } };
