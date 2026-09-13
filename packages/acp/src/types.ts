import type {
  AgentEvent,
  AgentMode,
  EngineId,
  ExecutionPolicy,
  ModelCapability,
  ModelSelection,
  RunResult,
} from "@sunset/domain";

export type CreateEngineInput = {
  cwd: string;
  model: ModelSelection;
  mode?: AgentMode;
  executionPolicy?: ExecutionPolicy;
  /** API key for engines that authenticate per ACP process (`meta.api_key`). */
  apiKey?: string;
};

export type ResumeEngineInput = CreateEngineInput & {
  providerSessionId: string;
};

export type EngineRun = {
  runId: string;
  stream: (options?: { signal?: AbortSignal }) => AsyncIterable<AgentEvent>;
  wait: () => Promise<RunResult>;
  cancel: () => Promise<void>;
};

export type EngineSessionHandle = {
  providerSessionId: string;
  send: (
    prompt: string,
    options?: { idempotencyKey?: string },
  ) => Promise<EngineRun>;
  dispose: () => Promise<void>;
};

export type Engine = {
  id: EngineId;
  listModels: () => Promise<ModelCapability[]>;
  supportedModes: () => AgentMode[];
  create: (input: CreateEngineInput) => Promise<EngineSessionHandle>;
  resume: (input: ResumeEngineInput) => Promise<EngineSessionHandle>;
};
