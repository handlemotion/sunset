import type { Database as SqliteDatabase } from "better-sqlite3";

import { parseExecutionPolicy, parseModelParameters } from "./capabilities.js";

import type {
  Project,
  Run,
  RunResult,
  Session,
  Workspace,
  WorkspaceOperation,
  WorkspaceOperationBranchOutcome,
  WorkspaceOperationCompensationOutcome,
  WorkspaceOperationDiagnostic,
  WorkspaceOperationPhase,
  WorkspaceOperationTerminalOutcome,
} from "./types.js";

type ProjectRow = { id: string; repo_root: string; created_at: number };
type WorkspaceRow = {
  id: string;
  project_id: string;
  worktree_path: string;
  branch: string;
  slug: string;
  base_ref: string;
  created_at: number;
  archived_at: number | null;
};
type SessionRow = {
  id: string;
  workspace_id: string;
  engine: string;
  location: string;
  provider_session_id: string;
  mode: string;
  model: string;
  model_params_json: string;
  execution_policy_json: string;
  created_at: number;
};
type RunRow = {
  id: string;
  session_id: string;
  provider_run_id: string | null;
  status:
    "queued" | "dispatching" | "running" | "finished" | "error" | "cancelled";
  prompt: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result_text: string | null;
  error_message: string | null;
  error_code: string | null;
  duration_ms: number | null;
};
type RunEventRow = { sequence: number; event_json: string };
type CapabilityCacheRow = { payload_json: string; fetched_at: number };
type OperationRow = {
  schema_version: 1;
  id: string;
  type: "create_workspace" | "archive_workspace";
  project_id: string;
  workspace_id: string;
  requested_json: string;
  phase: WorkspaceOperationPhase;
  branch_outcome: WorkspaceOperationBranchOutcome | null;
  created_at: number;
  updated_at: number;
  last_recovery_at: number | null;
  recovery_attempt_count: number;
  terminal_outcome: WorkspaceOperationTerminalOutcome | null;
  terminal_at: number | null;
  compensation_outcome: WorkspaceOperationCompensationOutcome;
  diagnostic_json: string | null;
};

export type StoredRun = {
  value: Run;
  internalStatus: RunRow["status"];
  providerRunId: string | null;
  prompt: string | null;
  result: RunResult | null;
};

function project(row: ProjectRow): Project {
  return { id: row.id, repoRoot: row.repo_root };
}

function workspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    branch: row.branch,
    slug: row.slug,
    baseRef: row.base_ref,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function session(row: SessionRow): Session {
  if (row.mode !== "agent" && row.mode !== "plan") {
    throw new Error(`invalid persisted session mode: ${row.mode}`);
  }
  if (row.engine !== "devin" && row.engine !== "codex") {
    throw new Error(`invalid persisted session engine: ${row.engine}`);
  }
  if (row.location !== "local" && row.location !== "cloud") {
    throw new Error(`invalid persisted session location: ${row.location}`);
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    engine: row.engine,
    location: row.location,
    providerSessionId: row.provider_session_id,
    mode: row.mode,
    model: {
      id: row.model,
      params: parseModelParameters(parseJson(row.model_params_json)),
    },
    executionPolicy: parseExecutionPolicy(parseJson(row.execution_policy_json)),
    createdAt: row.created_at,
  };
}

function storedRun(row: RunRow): StoredRun {
  const status = row.status === "dispatching" ? "queued" : row.status;
  const value: Run = {
    id: row.id,
    sessionId: row.session_id,
    status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
  let result: RunResult | null = null;
  if (
    row.status === "finished" ||
    row.status === "error" ||
    row.status === "cancelled"
  ) {
    result = { runId: row.id, status: row.status };
    if (row.result_text !== null) result.result = row.result_text;
    if (row.error_message !== null) {
      result.error = { message: row.error_message };
      if (row.error_code !== null) result.error.code = row.error_code;
    }
    if (row.duration_ms !== null) result.durationMs = row.duration_ms;
  }
  return {
    value,
    internalStatus: row.status,
    providerRunId: row.provider_run_id,
    prompt: row.prompt,
    result,
  };
}

function parseJson(encoded: string): unknown {
  return JSON.parse(encoded) as unknown;
}

function operation(row: OperationRow): WorkspaceOperation {
  const common = {
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecoveryAt: row.last_recovery_at,
    recoveryAttemptCount: row.recovery_attempt_count,
    terminalOutcome: row.terminal_outcome,
    terminalAt: row.terminal_at,
    compensationOutcome: row.compensation_outcome,
    diagnostic:
      row.diagnostic_json === null
        ? null
        : (parseJson(row.diagnostic_json) as WorkspaceOperationDiagnostic),
    branchOutcome: row.branch_outcome,
  };
  if (row.type === "create_workspace") {
    return {
      ...common,
      type: row.type,
      phase: row.phase,
      requestedInputs: parseJson(row.requested_json),
    } as WorkspaceOperation;
  }
  return {
    ...common,
    type: row.type,
    phase: row.phase,
    requestedInputs: parseJson(row.requested_json),
  } as WorkspaceOperation;
}

const RUN_COLUMNS =
  "id, session_id, provider_run_id, status, prompt, created_at, started_at, finished_at, result_text, error_message, error_code, duration_ms";
const OPERATION_COLUMNS =
  "schema_version, id, type, project_id, workspace_id, requested_json, phase, branch_outcome, created_at, updated_at, last_recovery_at, recovery_attempt_count, terminal_outcome, terminal_at, compensation_outcome, diagnostic_json";

/** The one SQLite-specific persistence boundary used by the host workflow. */
export function createState(database: SqliteDatabase) {
  const statements = {
    projectById: database.prepare(
      "SELECT id, repo_root, created_at FROM projects WHERE id = ?",
    ),
    projectByRoot: database.prepare(
      "SELECT id, repo_root, created_at FROM projects WHERE repo_root = ?",
    ),
    projects: database.prepare(
      "SELECT id, repo_root, created_at FROM projects ORDER BY created_at",
    ),
    insertProject: database.prepare(
      "INSERT INTO projects (id, repo_root, created_at) VALUES (?, ?, ?)",
    ),
    workspaceById: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE id = ?",
    ),
    activeWorkspaceBySlug: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE project_id = ? AND slug = ? AND archived_at IS NULL",
    ),
    activeWorkspaceByPath: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE worktree_path = ? AND archived_at IS NULL",
    ),
    workspacesForProject: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE project_id = ? ORDER BY created_at",
    ),
    activeWorkspacesForProject: database.prepare(
      "SELECT id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at FROM workspaces WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at",
    ),
    insertWorkspace: database.prepare(
      "INSERT INTO workspaces (id, project_id, worktree_path, branch, slug, base_ref, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    ),
    archiveWorkspace: database.prepare(
      "UPDATE workspaces SET archived_at = ? WHERE id = ?",
    ),
    sessionById: database.prepare(
      "SELECT id, workspace_id, engine, location, provider_session_id, mode, model, model_params_json, execution_policy_json, created_at FROM sessions WHERE id = ?",
    ),
    sessionsForWorkspace: database.prepare(
      "SELECT id, workspace_id, engine, location, provider_session_id, mode, model, model_params_json, execution_policy_json, created_at FROM sessions WHERE workspace_id = ? ORDER BY created_at",
    ),
    insertSession: database.prepare(
      "INSERT INTO sessions (id, workspace_id, engine, location, provider_session_id, mode, model, model_params_json, execution_policy_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    updateSessionProviderSessionId: database.prepare(
      "UPDATE sessions SET provider_session_id = ? WHERE id = ?",
    ),
    runById: database.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`),
    runsForSession: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? ORDER BY created_at, rowid`,
    ),
    nextQueuedRun: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1`,
    ),
    activeRunForSession: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? AND status IN ('dispatching', 'running') ORDER BY created_at, rowid LIMIT 1`,
    ),
    nonterminalRuns: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status IN ('queued', 'dispatching', 'running') ORDER BY created_at, rowid`,
    ),
    nonterminalRunsForWorkspace: database.prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?) AND status IN ('queued', 'dispatching', 'running') ORDER BY created_at, rowid`,
    ),
    insertRun: database.prepare(
      "INSERT INTO runs (id, session_id, provider_run_id, status, prompt, created_at, started_at, finished_at, result_text, error_message, error_code, duration_ms) VALUES (?, ?, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
    ),
    markRunDispatching: database.prepare(
      "UPDATE runs SET status = 'dispatching', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'",
    ),
    markRunRunning: database.prepare(
      "UPDATE runs SET status = 'running', provider_run_id = ?, prompt = NULL, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'dispatching'",
    ),
    finishRun: database.prepare(
      "UPDATE runs SET status = ?, prompt = NULL, finished_at = ?, result_text = ?, error_message = ?, error_code = ?, duration_ms = ? WHERE id = ? AND status IN ('queued', 'dispatching', 'running')",
    ),
    clearRunEvents: database.prepare("DELETE FROM run_events WHERE run_id = ?"),
    insertRunEvent: database.prepare(
      "INSERT INTO run_events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)",
    ),
    pruneRunEvents: database.prepare(
      `DELETE FROM run_events WHERE run_id IN (
        SELECT id FROM runs
        WHERE status IN ('finished', 'error', 'cancelled')
          AND finished_at IS NOT NULL
          AND finished_at < ?
      )`,
    ),
    runEventsAfter: database.prepare(
      "SELECT sequence, event_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence",
    ),
    capabilityCache: database.prepare(
      "SELECT payload_json, fetched_at FROM capability_cache WHERE key = ?",
    ),
    upsertCapabilityCache: database.prepare(
      "INSERT INTO capability_cache (key, payload_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at",
    ),
    operationById: database.prepare(
      `SELECT ${OPERATION_COLUMNS} FROM operations WHERE id = ?`,
    ),
    operations: database.prepare(
      `SELECT ${OPERATION_COLUMNS} FROM operations
       WHERE (? IS NULL OR project_id = ?)
         AND (? IS NULL OR workspace_id = ?)
         AND (? = 1 OR terminal_outcome IS NULL OR terminal_outcome = 'needs_attention')
       ORDER BY created_at, rowid`,
    ),
    recoverableOperations: database.prepare(
      `SELECT ${OPERATION_COLUMNS} FROM operations
       WHERE terminal_outcome IS NULL OR terminal_outcome = 'needs_attention'
       ORDER BY created_at, rowid`,
    ),
    insertOperation: database.prepare(
      `INSERT INTO operations (
        schema_version, id, type, project_id, workspace_id, requested_json, phase,
        branch_outcome, created_at, updated_at, last_recovery_at,
        recovery_attempt_count, terminal_outcome, terminal_at,
        compensation_outcome, diagnostic_json
      ) VALUES (1, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, NULL, NULL, 'not_required', NULL)`,
    ),
    updateOperationInputs: database.prepare(
      "UPDATE operations SET requested_json = ?, updated_at = ? WHERE id = ? AND terminal_outcome IS NULL",
    ),
    advanceOperation: database.prepare(
      `UPDATE operations SET phase = ?, branch_outcome = COALESCE(?, branch_outcome),
        updated_at = ?, terminal_outcome = NULL, terminal_at = NULL, diagnostic_json = NULL
       WHERE id = ? AND phase = ?`,
    ),
    recordRecoveryAttempt: database.prepare(
      `UPDATE operations SET recovery_attempt_count = recovery_attempt_count + 1,
        last_recovery_at = ?, updated_at = ? WHERE id = ?`,
    ),
    finishOperation: database.prepare(
      `UPDATE operations SET terminal_outcome = ?, terminal_at = ?, updated_at = ?,
        compensation_outcome = ?, diagnostic_json = ? WHERE id = ?`,
    ),
  };

  const insertSessionAndRun = database.transaction(
    (sessionValue: Session, runValue: Run, prompt: string) => {
      statements.insertSession.run(
        sessionValue.id,
        sessionValue.workspaceId,
        sessionValue.engine,
        sessionValue.location,
        sessionValue.providerSessionId,
        sessionValue.mode,
        sessionValue.model.id,
        JSON.stringify(sessionValue.model.params),
        JSON.stringify(sessionValue.executionPolicy),
        sessionValue.createdAt,
      );
      statements.insertRun.run(
        runValue.id,
        runValue.sessionId,
        prompt,
        runValue.createdAt,
      );
    },
  );

  const insertWorkspaceAndAdvanceOperation = database.transaction(
    (
      value: Workspace,
      operationId: string,
      expectedPhase: WorkspaceOperationPhase,
      nextPhase: WorkspaceOperationPhase,
      updatedAt: number,
    ) => {
      statements.insertWorkspace.run(
        value.id,
        value.projectId,
        value.worktreePath,
        value.branch,
        value.slug,
        value.baseRef,
        value.createdAt,
      );
      const result = statements.advanceOperation.run(
        nextPhase,
        null,
        updatedAt,
        operationId,
        expectedPhase,
      );
      if (result.changes !== 1) throw new Error("operation phase conflict");
    },
  );

  const archiveWorkspaceAndAdvanceOperation = database.transaction(
    (
      workspaceId: string,
      archivedAt: number,
      operationId: string,
      expectedPhase: WorkspaceOperationPhase,
      nextPhase: WorkspaceOperationPhase,
    ) => {
      statements.archiveWorkspace.run(archivedAt, workspaceId);
      const result = statements.advanceOperation.run(
        nextPhase,
        null,
        archivedAt,
        operationId,
        expectedPhase,
      );
      if (result.changes !== 1) throw new Error("operation phase conflict");
    },
  );

  return {
    getProject(id: string): Project | undefined {
      const row = statements.projectById.get(id) as ProjectRow | undefined;
      return row && project(row);
    },
    getProjectByRoot(repoRoot: string): Project | undefined {
      const row = statements.projectByRoot.get(repoRoot) as
        ProjectRow | undefined;
      return row && project(row);
    },
    listProjects(): Project[] {
      return (statements.projects.all() as ProjectRow[]).map(project);
    },
    insertProject(value: Project & { createdAt: number }): void {
      statements.insertProject.run(value.id, value.repoRoot, value.createdAt);
    },
    getWorkspace(id: string): Workspace | undefined {
      const row = statements.workspaceById.get(id) as WorkspaceRow | undefined;
      return row && workspace(row);
    },
    getActiveWorkspaceBySlug(
      projectId: string,
      slug: string,
    ): Workspace | undefined {
      const row = statements.activeWorkspaceBySlug.get(projectId, slug) as
        WorkspaceRow | undefined;
      return row && workspace(row);
    },
    getActiveWorkspaceByPath(worktreePath: string): Workspace | undefined {
      const row = statements.activeWorkspaceByPath.get(worktreePath) as
        WorkspaceRow | undefined;
      return row && workspace(row);
    },
    listWorkspaces(projectId: string, includeArchived: boolean): Workspace[] {
      const rows = (
        includeArchived
          ? statements.workspacesForProject.all(projectId)
          : statements.activeWorkspacesForProject.all(projectId)
      ) as WorkspaceRow[];
      return rows.map(workspace);
    },
    insertWorkspace(value: Workspace): void {
      statements.insertWorkspace.run(
        value.id,
        value.projectId,
        value.worktreePath,
        value.branch,
        value.slug,
        value.baseRef,
        value.createdAt,
      );
    },
    archiveWorkspace(id: string, archivedAt: number): void {
      statements.archiveWorkspace.run(archivedAt, id);
    },
    getSession(id: string): Session | undefined {
      const row = statements.sessionById.get(id) as SessionRow | undefined;
      return row && session(row);
    },
    listSessions(workspaceId: string): Session[] {
      return (
        statements.sessionsForWorkspace.all(workspaceId) as SessionRow[]
      ).map(session);
    },
    insertSession(value: Session): void {
      statements.insertSession.run(
        value.id,
        value.workspaceId,
        value.engine,
        value.location,
        value.providerSessionId,
        value.mode,
        value.model.id,
        JSON.stringify(value.model.params),
        JSON.stringify(value.executionPolicy),
        value.createdAt,
      );
    },
    updateSessionProviderSessionId(
      id: string,
      providerSessionId: string,
    ): void {
      statements.updateSessionProviderSessionId.run(providerSessionId, id);
    },
    insertSessionAndRun(
      sessionValue: Session,
      runValue: Run,
      prompt: string,
    ): void {
      insertSessionAndRun(sessionValue, runValue, prompt);
    },
    getRun(id: string): StoredRun | undefined {
      const row = statements.runById.get(id) as RunRow | undefined;
      return row && storedRun(row);
    },
    listRuns(sessionId: string): Run[] {
      return (statements.runsForSession.all(sessionId) as RunRow[]).map(
        (row) => storedRun(row).value,
      );
    },
    insertRun(value: Run, prompt: string): void {
      statements.insertRun.run(
        value.id,
        value.sessionId,
        prompt,
        value.createdAt,
      );
    },
    getNextQueuedRun(sessionId: string): StoredRun | undefined {
      const row = statements.nextQueuedRun.get(sessionId) as RunRow | undefined;
      return row && storedRun(row);
    },
    getActiveRun(sessionId: string): StoredRun | undefined {
      const row = statements.activeRunForSession.get(sessionId) as
        RunRow | undefined;
      return row && storedRun(row);
    },
    listNonterminalRuns(): StoredRun[] {
      return (statements.nonterminalRuns.all() as RunRow[]).map(storedRun);
    },
    listNonterminalRunsForWorkspace(workspaceId: string): StoredRun[] {
      return (
        statements.nonterminalRunsForWorkspace.all(workspaceId) as RunRow[]
      ).map(storedRun);
    },
    markRunDispatching(id: string, startedAt: number): boolean {
      return statements.markRunDispatching.run(startedAt, id).changes === 1;
    },
    markRunRunning(
      id: string,
      providerRunId: string,
      startedAt: number,
    ): boolean {
      return (
        statements.markRunRunning.run(providerRunId, startedAt, id).changes ===
        1
      );
    },
    finishRun(id: string, result: RunResult, finishedAt: number): boolean {
      return (
        statements.finishRun.run(
          result.status,
          finishedAt,
          result.result ?? null,
          result.error?.message ?? null,
          result.error?.code ?? null,
          result.durationMs ?? null,
          id,
        ).changes === 1
      );
    },
    clearRunEvents(id: string): void {
      statements.clearRunEvents.run(id);
    },
    insertRunEvent(
      runId: string,
      sequence: number,
      eventJson: string,
      createdAt: number,
    ): void {
      statements.insertRunEvent.run(runId, sequence, eventJson, createdAt);
    },
    pruneRunEvents(finishedBefore: number): number {
      return statements.pruneRunEvents.run(finishedBefore).changes;
    },
    listRunEventsAfter(runId: string, sequence: number): RunEventRow[] {
      return statements.runEventsAfter.all(runId, sequence) as RunEventRow[];
    },
    getCapabilityCache(
      key: "devin_models" | "codex_models" = "devin_models",
    ): { payloadJson: string; fetchedAt: number } | undefined {
      const row = statements.capabilityCache.get(key) as
        CapabilityCacheRow | undefined;
      return (
        row && { payloadJson: row.payload_json, fetchedAt: row.fetched_at }
      );
    },
    putCapabilityCache(
      models: unknown,
      fetchedAt: number,
      key: "devin_models" | "codex_models" = "devin_models",
    ): void {
      statements.upsertCapabilityCache.run(
        key,
        JSON.stringify(models),
        fetchedAt,
      );
    },
    getOperation(id: string): WorkspaceOperation | undefined {
      const row = statements.operationById.get(id) as OperationRow | undefined;
      return row && operation(row);
    },
    listOperations(input: {
      projectId?: string;
      workspaceId?: string;
      includeCompleted?: boolean;
    }): WorkspaceOperation[] {
      const projectId = input.projectId ?? null;
      const workspaceId = input.workspaceId ?? null;
      return (
        statements.operations.all(
          projectId,
          projectId,
          workspaceId,
          workspaceId,
          input.includeCompleted ? 1 : 0,
        ) as OperationRow[]
      ).map(operation);
    },
    listRecoverableOperations(): WorkspaceOperation[] {
      return (statements.recoverableOperations.all() as OperationRow[]).map(
        operation,
      );
    },
    insertOperation(value: WorkspaceOperation): void {
      statements.insertOperation.run(
        value.id,
        value.type,
        value.projectId,
        value.workspaceId,
        JSON.stringify(value.requestedInputs),
        value.phase,
        value.createdAt,
        value.updatedAt,
      );
    },
    updateOperationInputs(
      id: string,
      requestedInputs: WorkspaceOperation["requestedInputs"],
      updatedAt: number,
    ): boolean {
      return (
        statements.updateOperationInputs.run(
          JSON.stringify(requestedInputs),
          updatedAt,
          id,
        ).changes === 1
      );
    },
    advanceOperation(
      id: string,
      expectedPhase: WorkspaceOperationPhase,
      nextPhase: WorkspaceOperationPhase,
      updatedAt: number,
      branchOutcome?: WorkspaceOperationBranchOutcome,
    ): boolean {
      return (
        statements.advanceOperation.run(
          nextPhase,
          branchOutcome ?? null,
          updatedAt,
          id,
          expectedPhase,
        ).changes === 1
      );
    },
    insertWorkspaceAndAdvanceOperation(
      value: Workspace,
      operationId: string,
      expectedPhase: WorkspaceOperationPhase,
      nextPhase: WorkspaceOperationPhase,
      updatedAt: number,
    ): void {
      insertWorkspaceAndAdvanceOperation(
        value,
        operationId,
        expectedPhase,
        nextPhase,
        updatedAt,
      );
    },
    archiveWorkspaceAndAdvanceOperation(
      workspaceId: string,
      archivedAt: number,
      operationId: string,
      expectedPhase: WorkspaceOperationPhase,
      nextPhase: WorkspaceOperationPhase,
    ): void {
      archiveWorkspaceAndAdvanceOperation(
        workspaceId,
        archivedAt,
        operationId,
        expectedPhase,
        nextPhase,
      );
    },
    recordRecoveryAttempt(id: string, attemptedAt: number): void {
      statements.recordRecoveryAttempt.run(attemptedAt, attemptedAt, id);
    },
    finishOperation(
      id: string,
      outcome: WorkspaceOperationTerminalOutcome,
      compensation: WorkspaceOperationCompensationOutcome,
      diagnostic: WorkspaceOperationDiagnostic | null,
      finishedAt: number,
    ): void {
      statements.finishOperation.run(
        outcome,
        finishedAt,
        finishedAt,
        compensation,
        diagnostic === null ? null : JSON.stringify(diagnostic),
        id,
      );
    },
  };
}
