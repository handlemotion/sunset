export type EngineId = "devin" | "codex";
export type SessionLocation = "local" | "cloud";
export type AgentMode = "agent" | "plan";

export type ModelParameterValue = { id: string; value: string };
export type ModelSelection = { id: string; params: ModelParameterValue[] };
export type ModelParameterDefinition = {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
};
export type ModelVariant = {
  params: ModelParameterValue[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
};
export type ModelCapability = {
  id: string;
  displayName: string;
  description?: string;
  aliases: string[];
  parameters: ModelParameterDefinition[];
  variants: ModelVariant[];
};

export type ExecutionPolicy = {
  autoReview: boolean;
  sandbox: { enabled: boolean };
  agentRetries: boolean;
  toolAllowlist: string[] | null;
  toolDenylist: string[];
};

export type ExecutionPolicyInput = {
  autoReview?: boolean;
  sandbox?: { enabled?: boolean };
  agentRetries?: boolean;
  toolAllowlist?: string[] | null;
  toolDenylist?: string[];
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  autoReview: false,
  sandbox: { enabled: false },
  agentRetries: true,
  toolAllowlist: null,
  toolDenylist: [],
};

export function resolveExecutionPolicy(
  input?: ExecutionPolicyInput,
  base: ExecutionPolicy = DEFAULT_EXECUTION_POLICY,
): ExecutionPolicy {
  return {
    autoReview: input?.autoReview ?? base.autoReview,
    sandbox: { enabled: input?.sandbox?.enabled ?? base.sandbox.enabled },
    agentRetries: input?.agentRetries ?? base.agentRetries,
    toolAllowlist: input?.toolAllowlist ?? base.toolAllowlist,
    toolDenylist: input?.toolDenylist ?? base.toolDenylist,
  };
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      result: unknown;
      ok: boolean;
    }
  | {
      type: "plan";
      entries: Array<{ content: string; status: string; priority?: string }>;
    }
  | { type: "mode"; modeId: string }
  | { type: "status"; status: string; message?: string }
  | { type: "usage"; used: number; size: number }
  | { type: "session_title"; title: string }
  | {
      type: "commands";
      commands: Array<{ name: string; description?: string }>;
    }
  | { type: "error"; message: string };

export type Project = { id: string; repoRoot: string };

export type Workspace = {
  id: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  slug: string;
  baseRef: string;
  createdAt: number;
  archivedAt: number | null;
};

export type Session = {
  id: string;
  workspaceId: string;
  engine: EngineId;
  location: SessionLocation;
  providerSessionId: string;
  mode: AgentMode;
  model: ModelSelection;
  executionPolicy: ExecutionPolicy;
  createdAt: number;
};

export type RunStatus =
  "queued" | "running" | "finished" | "error" | "cancelled";
export type Run = {
  id: string;
  sessionId: string;
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};
export type RunError = { message: string; code?: string };
export type RunResult = {
  runId: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: RunError;
  durationMs?: number;
};

export type HostEvent = AgentEvent & {
  workspaceId: string;
  sessionId: string;
  runId: string;
  sequence: number;
};

export type ModelCatalogState =
  | { status: "live"; fetchedAt: number }
  | { status: "cached"; fetchedAt: number; error: RunError }
  | { status: "unavailable"; fetchedAt: null; error: RunError };

export type EngineCapabilities = {
  id: EngineId;
  modes: AgentMode[];
  models: ModelCapability[];
  modelCatalog: ModelCatalogState;
  executionPolicy: {
    defaults: ExecutionPolicy;
    controls: Array<
      | "autoReview"
      | "sandbox"
      | "agentRetries"
      | "toolAllowlist"
      | "toolDenylist"
    >;
  };
};

export type HostCapabilities = {
  engines: EngineCapabilities[];
};
