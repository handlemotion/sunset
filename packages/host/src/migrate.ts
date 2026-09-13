import type { Database as SqliteDatabase } from "better-sqlite3";

const VERSION = 1;

const V1_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  slug TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_active_slug
  ON workspaces(project_id, slug) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS workspaces_project_history
  ON workspaces(project_id, created_at);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('devin', 'codex')),
  location TEXT NOT NULL CHECK (location IN ('local', 'cloud')),
  provider_session_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('agent', 'plan')),
  model TEXT NOT NULL,
  model_params_json TEXT NOT NULL DEFAULT '[]',
  execution_policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
CREATE INDEX IF NOT EXISTS sessions_workspace_history
  ON sessions(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provider_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'running', 'finished', 'error', 'cancelled')),
  prompt TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result_text TEXT,
  error_message TEXT,
  error_code TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS runs_session_history ON runs(session_id, created_at);
CREATE INDEX IF NOT EXISTS runs_status_queue ON runs(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS runs_session_active
  ON runs(session_id) WHERE status IN ('dispatching', 'running');
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS run_events_history ON run_events(run_id, sequence);
CREATE TABLE IF NOT EXISTS operations (
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('create_workspace', 'archive_workspace')),
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requested_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'intent_recorded', 'git_worktree_created', 'path_verified',
    'workspace_row_committed', 'operation_completed', 'active_runs_handled',
    'git_worktree_removed', 'branch_outcome_recorded', 'workspace_archived'
  )),
  branch_outcome TEXT CHECK (branch_outcome IN ('kept', 'deleted', 'already_absent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_recovery_at INTEGER,
  recovery_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempt_count >= 0),
  terminal_outcome TEXT CHECK (terminal_outcome IN ('succeeded', 'failed', 'needs_attention')),
  terminal_at INTEGER,
  compensation_outcome TEXT NOT NULL DEFAULT 'not_required'
    CHECK (compensation_outcome IN ('not_required', 'succeeded', 'failed', 'unsafe')),
  diagnostic_json TEXT,
  CHECK (
    (type = 'create_workspace' AND phase IN (
      'intent_recorded', 'git_worktree_created', 'path_verified',
      'workspace_row_committed', 'operation_completed'
    )) OR
    (type = 'archive_workspace' AND phase IN (
      'intent_recorded', 'active_runs_handled', 'git_worktree_removed',
      'branch_outcome_recorded', 'workspace_archived'
    ))
  ),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS operations_project_history ON operations(project_id, created_at);
CREATE INDEX IF NOT EXISTS operations_workspace_history ON operations(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS operations_recovery ON operations(updated_at)
  WHERE terminal_outcome IS NULL OR terminal_outcome = 'needs_attention';
CREATE TABLE IF NOT EXISTS capability_cache (
  key TEXT PRIMARY KEY CHECK (key IN ('devin_models', 'codex_models')),
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

export function migrate(database: SqliteDatabase): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  const current = database.pragma("user_version", { simple: true });
  if (
    typeof current !== "number" ||
    !Number.isInteger(current) ||
    current < 0 ||
    current > VERSION
  ) {
    throw new Error(
      `incompatible sunset.sqlite user_version: ${String(current)}`,
    );
  }
  database.transaction(() => {
    if (current < 1) {
      database.exec(V1_DDL);
      const duplicate = database
        .prepare(
          "SELECT worktree_path FROM workspaces WHERE archived_at IS NULL GROUP BY worktree_path HAVING COUNT(*) > 1 LIMIT 1",
        )
        .get() as { worktree_path: string } | undefined;
      if (duplicate) {
        throw new Error(
          `incompatible sunset.sqlite: duplicate active worktree_path ${duplicate.worktree_path}`,
        );
      }
      database.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS workspaces_active_path ON workspaces(worktree_path) WHERE archived_at IS NULL",
      );
    }
    database.pragma(`user_version = ${VERSION}`);
  })();
}
