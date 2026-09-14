import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  createEngine,
  ENGINES,
  reapOrphanedEngineGroups,
  type Engine,
  type EngineRun,
  type EngineSessionHandle,
} from "@sunset/acp";
import {
  resolveExecutionPolicy,
  type EngineId,
  type ExecutionPolicy,
  type RunResult,
  type SessionLocation,
} from "@sunset/domain";
import {
  createGit,
  isGitError,
  isPathInside,
  type GitService,
  type WorkspaceOperationStepResult,
} from "@sunset/git";
import Database from "better-sqlite3";
import { ulid } from "ulid";

import { HostError, isUniqueConstraint } from "./errors.js";
import {
  parseModelCatalog,
  resolveModelSelection,
  sanitizedCatalogError,
} from "./capabilities.js";
import { acquireHostLease } from "./lease.js";
import { migrate } from "./migrate.js";
import { reconcileProject } from "./reconcile.js";
import { assertSlug } from "./slug.js";
import { createState, type StoredRun } from "./state.js";
import type {
  CreateHostOptions,
  EngineCapabilities,
  ExecutionPolicyControl,
  Host,
  HostEvent,
  HostCapabilities,
  Project,
  Run,
  Session,
  Workspace,
  WorkspaceOperation,
  WorkspaceOperationDiagnostic,
} from "./types.js";

function now(): number {
  return Date.now();
}

const DEFAULT_LEASE_TIMEOUT_MS = 5_000;
const DEFAULT_ENGINE_IDLE_TTL_MS = 600_000;
const DEFAULT_MAX_ENGINES_PER_WORKSPACE = 5;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type EnginePoolEntry = {
  sessionId: string;
  workspaceId: string;
  handle: EngineSessionHandle;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
};

type CapacityWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown host run failure";
}

function failure(runId: string, code: string, error: unknown): RunResult {
  return {
    runId,
    status: "error",
    error: { message: errorMessage(error), code },
  };
}

function safeOperationDiagnostic(
  code: string,
  message: string,
  observed?: Readonly<Record<string, unknown>>,
): WorkspaceOperationDiagnostic {
  const diagnostic: WorkspaceOperationDiagnostic = {
    code: code.slice(0, 128),
    message: message.slice(0, 512),
  };
  if (observed !== undefined) {
    const encoded = JSON.stringify(observed);
    if (encoded.length <= 2_048) diagnostic.observed = observed;
  }
  return diagnostic;
}

function operationFailure(error: unknown): WorkspaceOperationDiagnostic {
  if (isGitError(error)) {
    return safeOperationDiagnostic(error.code, "Git operation failed");
  }
  if (error instanceof HostError) {
    return safeOperationDiagnostic(error.code, error.message);
  }
  return safeOperationDiagnostic(
    "operation_failed",
    error instanceof Error ? error.name : "Workspace operation failed",
  );
}

export async function createHost(options: CreateHostOptions): Promise<Host> {
  const leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new HostError("leaseTimeoutMs must be positive", "invalid_options");
  }
  const engineIdleTtlMs = options.engineIdleTtlMs ?? DEFAULT_ENGINE_IDLE_TTL_MS;
  if (
    !Number.isFinite(engineIdleTtlMs) ||
    engineIdleTtlMs <= 0 ||
    engineIdleTtlMs > MAX_TIMER_DELAY_MS
  ) {
    throw new HostError(
      `engineIdleTtlMs must be between 1 and ${MAX_TIMER_DELAY_MS}`,
      "invalid_options",
    );
  }
  const maxEnginesPerWorkspace =
    options.maxEnginesPerWorkspace ?? DEFAULT_MAX_ENGINES_PER_WORKSPACE;
  if (
    !Number.isInteger(maxEnginesPerWorkspace) ||
    maxEnginesPerWorkspace <= 0
  ) {
    throw new HostError(
      "maxEnginesPerWorkspace must be a positive integer",
      "invalid_options",
    );
  }
  let defaultExecutionPolicy: ExecutionPolicy;
  try {
    defaultExecutionPolicy = resolveExecutionPolicy(options.executionPolicy);
  } catch (error) {
    throw new HostError(errorMessage(error), "invalid_options", {
      cause: error,
    });
  }
  await mkdir(options.stateDir, { recursive: true });
  await mkdir(options.worktreeRoot, { recursive: true });
  const stateDir = await realpath(options.stateDir);
  const worktreeRoot = await realpath(options.worktreeRoot);
  const hostLease = await acquireHostLease(stateDir, leaseTimeoutMs);
  const engineGroupDir = path.join(stateDir, "engine-groups");
  try {
    reapOrphanedEngineGroups(engineGroupDir);
  } catch (error) {
    await hostLease.release();
    throw error;
  }
  const sqlitePath = path.join(stateDir, "sunset.sqlite");
  let database: InstanceType<typeof Database>;
  try {
    database = new Database(sqlitePath);
  } catch (error) {
    await hostLease.release();
    throw error;
  }
  let state: ReturnType<typeof createState>;
  try {
    migrate(database);
    state = createState(database);
  } catch (error) {
    database.close();
    await hostLease.release();
    throw error;
  }
  const git: GitService = options.git ?? createGit();
  const engines: Record<EngineId, Engine> = {
    devin:
      options.engines?.devin ?? createEngine(ENGINES.devin, { engineGroupDir }),
    codex:
      options.engines?.codex ?? createEngine(ENGINES.codex, { engineGroupDir }),
  };

  const ENGINE_POLICY_CONTROLS: ExecutionPolicyControl[] = [
    "toolAllowlist",
    "toolDenylist",
  ];

  let closing = false;
  let closed = false;
  let suspending = false;
  let shutdownPromise: Promise<void> | undefined;
  const schedulers = new Map<string, Promise<void>>();
  const enginePool = new Map<string, EnginePoolEntry>();
  const engineClaims = new Map<string, number>();
  const retiringEngineDisposals = new Map<string, Set<Promise<void>>>();
  const pendingEngineCreations = new Set<Promise<unknown>>();
  const capacityWaiters = new Map<string, CapacityWaiter[]>();
  const capacityWaiterCancellers = new Map<string, () => void>();
  const activeRuns = new Map<string, EngineRun>();
  const activeRunControllers = new Map<string, AbortController>();
  const cancelRequested = new Set<string>();
  const suspendCancelledRuns = new Set<string>();
  const runVersions = new Map<string, number>();
  const runWaiters = new Map<string, Set<() => void>>();
  const catalogValidatedRuns = new Set<string>();
  let catalogRequest: Promise<HostCapabilities> | undefined;

  function assertOpen(): void {
    if (closing || closed) {
      throw new HostError("host is closed", "host_closed");
    }
  }

  function engineFor(id: EngineId): Engine {
    return engines[id];
  }

  function parseEngine(value: string | undefined): EngineId {
    if (value === undefined || value === "devin") return "devin";
    if (value === "codex") return "codex";
    throw new HostError(
      `invalid engine: ${value}; expected devin or codex`,
      "invalid_engine",
    );
  }

  function parseLocation(value: string | undefined): SessionLocation {
    if (value === undefined || value === "local") return "local";
    if (value === "cloud") {
      throw new HostError(
        "cloud engine is not available yet",
        "cloud_unavailable",
      );
    }
    throw new HostError(
      `invalid location: ${value}; expected local or cloud`,
      "invalid_location",
    );
  }

  async function discoverEngine(
    id: EngineId,
    engine: Engine,
    cacheKey: "devin_models" | "codex_models",
  ): Promise<EngineCapabilities> {
    const policy = {
      defaults: defaultExecutionPolicy,
      controls: ENGINE_POLICY_CONTROLS,
    };
    try {
      const models = parseModelCatalog(await engine.listModels());
      const fetchedAt = now();
      state.putCapabilityCache(models, fetchedAt, cacheKey);
      return {
        id,
        modes: engine.supportedModes(),
        models,
        modelCatalog: { status: "live", fetchedAt },
        executionPolicy: policy,
      };
    } catch (error) {
      const catalogError = sanitizedCatalogError(error);
      const cached = state.getCapabilityCache(cacheKey);
      if (cached) {
        try {
          return {
            id,
            modes: engine.supportedModes(),
            models: parseModelCatalog(
              JSON.parse(cached.payloadJson) as unknown,
            ),
            modelCatalog: {
              status: "cached",
              fetchedAt: cached.fetchedAt,
              error: catalogError,
            },
            executionPolicy: policy,
          };
        } catch {
          // A corrupt cache is unavailable rather than trusted as capability data.
        }
      }
      return {
        id,
        modes: engine.supportedModes(),
        models: [],
        modelCatalog: {
          status: "unavailable",
          fetchedAt: null,
          error: catalogError,
        },
        executionPolicy: policy,
      };
    }
  }

  async function discoverCapabilities(): Promise<HostCapabilities> {
    const [devin, codex] = await Promise.all([
      discoverEngine("devin", engines.devin, "devin_models"),
      discoverEngine("codex", engines.codex, "codex_models"),
    ]);
    return { engines: [devin, codex] };
  }

  function capabilities(): Promise<HostCapabilities> {
    catalogRequest ??= discoverCapabilities().finally(() => {
      catalogRequest = undefined;
    });
    return catalogRequest;
  }

  async function availableModels(engine: EngineId = "devin") {
    const value = await capabilities();
    const entry = value.engines.find((item) => item.id === engine);
    if (!entry || entry.modelCatalog.status === "unavailable") {
      const catalogError =
        entry?.modelCatalog.status === "unavailable"
          ? entry.modelCatalog.error
          : { message: "model catalog is unavailable" };
      throw new HostError(
        catalogError.message,
        catalogError.code === "codex_auth_unavailable"
          ? "codex_auth_unavailable"
          : "model_catalog_unavailable",
      );
    }
    return entry.models;
  }

  function requireProject(id: string): Project {
    const value = state.getProject(id);
    if (!value) {
      throw new HostError(`unknown project: ${id}`, "unknown_project");
    }
    return value;
  }

  function requireWorkspace(id: string): Workspace {
    const value = state.getWorkspace(id);
    if (!value) {
      throw new HostError(`unknown workspace: ${id}`, "unknown_workspace");
    }
    return value;
  }

  function requireSession(id: string): Session {
    const value = state.getSession(id);
    if (!value) {
      throw new HostError(`unknown session: ${id}`, "unknown_session");
    }
    return value;
  }

  function requireRun(id: string): StoredRun {
    const value = state.getRun(id);
    if (!value) {
      throw new HostError(`unknown run: ${id}`, "unknown_run");
    }
    return value;
  }

  function notifyRun(runId: string): void {
    runVersions.set(runId, (runVersions.get(runId) ?? 0) + 1);
    const waiters = runWaiters.get(runId);
    if (!waiters) return;
    runWaiters.delete(runId);
    for (const resolve of waiters) resolve();
  }

  function waitForRunChange(
    runId: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const waiters = runWaiters.get(runId) ?? new Set<() => void>();
      let settled = false;
      const settle = (changed: boolean) => {
        if (settled) return;
        settled = true;
        waiters.delete(wake);
        if (waiters.size === 0) runWaiters.delete(runId);
        signal?.removeEventListener("abort", abort);
        resolve(changed);
      };
      const wake = () => settle(true);
      const abort = () => settle(false);
      waiters.add(wake);
      runWaiters.set(runId, waiters);
      signal?.addEventListener("abort", abort, { once: true });
      if ((runVersions.get(runId) ?? 0) !== version) {
        settle(true);
      } else if (signal?.aborted) {
        settle(false);
      }
    });
  }

  function signalEngineCapacity(workspaceId: string): void {
    const waiters = capacityWaiters.get(workspaceId);
    const head = waiters?.shift();
    if (waiters && waiters.length === 0) capacityWaiters.delete(workspaceId);
    head?.resolve();
  }

  function claimEngineCapacity(workspaceId: string): void {
    engineClaims.set(workspaceId, (engineClaims.get(workspaceId) ?? 0) + 1);
  }

  function releaseEngineCapacity(workspaceId: string): void {
    const count = (engineClaims.get(workspaceId) ?? 0) - 1;
    if (count <= 0) engineClaims.delete(workspaceId);
    else engineClaims.set(workspaceId, count);
    signalEngineCapacity(workspaceId);
  }

  function liveEngineCount(workspaceId: string): number {
    let count = engineClaims.get(workspaceId) ?? 0;
    for (const entry of enginePool.values()) {
      if (entry.workspaceId === workspaceId) count += 1;
    }
    count += retiringEngineDisposals.get(workspaceId)?.size ?? 0;
    return count;
  }

  function markEngineIdle(sessionId: string): void {
    const entry = enginePool.get(sessionId);
    if (!entry || entry.idleTimer) return;
    entry.lastUsedAt = now();
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      void evictEngineEntry(entry);
    }, engineIdleTtlMs);
    entry.idleTimer.unref();
    signalEngineCapacity(entry.workspaceId);
  }

  async function evictEngineEntry(entry: EnginePoolEntry): Promise<void> {
    if (enginePool.get(entry.sessionId) !== entry) return;
    // A session with queued or running work is busy and cannot be evicted.
    if (schedulers.has(entry.sessionId)) return;
    enginePool.delete(entry.sessionId);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const disposal = Promise.resolve()
      .then(() => entry.handle.dispose())
      .catch(() => undefined);
    const trackedDisposal = disposal.finally(() => {
      const disposals = retiringEngineDisposals.get(entry.workspaceId);
      disposals?.delete(trackedDisposal);
      if (disposals && disposals.size === 0) {
        retiringEngineDisposals.delete(entry.workspaceId);
      }
      signalEngineCapacity(entry.workspaceId);
    });
    const disposals =
      retiringEngineDisposals.get(entry.workspaceId) ??
      new Set<Promise<void>>();
    disposals.add(trackedDisposal);
    retiringEngineDisposals.set(entry.workspaceId, disposals);
    await trackedDisposal;
  }

  async function ensureEngineCapacity(
    workspaceId: string,
    runId?: string,
  ): Promise<boolean> {
    let queued = false;
    for (;;) {
      if (closing) {
        throw new HostError("host is closed", "host_closed");
      }
      if (runId && cancelRequested.has(runId)) {
        signalEngineCapacity(workspaceId);
        return false;
      }
      const waiters = capacityWaiters.get(workspaceId);
      if (!waiters?.length || queued) {
        if (liveEngineCount(workspaceId) < maxEnginesPerWorkspace) {
          claimEngineCapacity(workspaceId);
          return true;
        }
        let lru: EnginePoolEntry | undefined;
        for (const entry of enginePool.values()) {
          if (entry.workspaceId !== workspaceId) continue;
          if (schedulers.has(entry.sessionId)) continue;
          if (!lru || entry.lastUsedAt < lru.lastUsedAt) lru = entry;
        }
        if (lru) {
          claimEngineCapacity(workspaceId);
          await evictEngineEntry(lru);
          return true;
        }
      }
      let cancelWaiter: (() => void) | undefined;
      const wait = new Promise<void>((resolve, reject) => {
        const waiter: CapacityWaiter = { resolve, reject };
        const list = capacityWaiters.get(workspaceId) ?? [];
        if (queued) list.unshift(waiter);
        else list.push(waiter);
        capacityWaiters.set(workspaceId, list);
        if (runId) {
          cancelWaiter = () => {
            const current = capacityWaiters.get(workspaceId);
            const index = current?.indexOf(waiter) ?? -1;
            if (current && index >= 0) {
              current.splice(index, 1);
              if (current.length === 0) capacityWaiters.delete(workspaceId);
            }
            resolve();
          };
          capacityWaiterCancellers.set(runId, cancelWaiter);
        }
      });
      try {
        await wait;
      } finally {
        if (
          runId &&
          cancelWaiter &&
          capacityWaiterCancellers.get(runId) === cancelWaiter
        ) {
          capacityWaiterCancellers.delete(runId);
        }
      }
      if (runId && cancelRequested.has(runId)) return false;
      queued = true;
    }
  }

  function registerEngineEntry(
    sessionId: string,
    workspaceId: string,
    handle: EngineSessionHandle,
  ): void {
    enginePool.set(sessionId, {
      sessionId,
      workspaceId,
      handle,
      lastUsedAt: now(),
      idleTimer: null,
    });
  }

  async function sessionHandle(
    session: Session,
    workspace: Workspace,
    runId?: string,
  ): Promise<EngineSessionHandle | undefined> {
    const existing = enginePool.get(session.id);
    if (existing) {
      existing.lastUsedAt = now();
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      return existing.handle;
    }
    if (!(await ensureEngineCapacity(workspace.id, runId))) return undefined;
    try {
      const handle = await engineFor(session.engine).resume({
        cwd: workspace.worktreePath,
        model: session.model,
        mode: session.mode,
        executionPolicy: session.executionPolicy,
        providerSessionId: session.providerSessionId,
      });
      if (closing) {
        await handle.dispose().catch(() => undefined);
        throw new HostError("host is closed", "host_closed");
      }
      registerEngineEntry(session.id, workspace.id, handle);
      return handle;
    } finally {
      releaseEngineCapacity(workspace.id);
    }
  }

  function finishRun(runId: string, result: RunResult): void {
    state.finishRun(runId, result, now());
    notifyRun(runId);
  }

  function hostResult(runId: string, result: RunResult): RunResult {
    const mapped: RunResult = { runId, status: result.status };
    if (result.result !== undefined) mapped.result = result.result;
    if (result.error !== undefined) mapped.error = { ...result.error };
    if (result.durationMs !== undefined) mapped.durationMs = result.durationMs;
    return mapped;
  }

  function serializeEvent(event: HostEvent): string {
    const encoded = JSON.stringify(event);
    if (encoded === undefined) {
      throw new Error("agent event is not JSON-serializable");
    }
    return encoded;
  }

  function parseEvent(encoded: string): HostEvent {
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch (error) {
      throw new HostError(
        "persisted run event is invalid",
        "run_event_invalid",
        {
          cause: error,
        },
      );
    }
    if (typeof value !== "object" || value === null || !("type" in value)) {
      throw new HostError(
        "persisted run event is invalid",
        "run_event_invalid",
      );
    }
    return value as HostEvent;
  }

  async function suspendRun(
    stored: StoredRun,
    run: EngineRun,
    _controller: AbortController,
  ): Promise<void> {
    // ACP sessions are stdio child processes; they cannot detach and outlive
    // the host, so every active run is cancelled and settled on suspend.
    cancelRequested.add(stored.value.id);
    suspendCancelledRuns.add(stored.value.id);
    await run.cancel().catch(() => undefined);
  }

  async function consumeRun(
    stored: StoredRun,
    run: EngineRun,
    workspace: Workspace,
  ): Promise<void> {
    state.clearRunEvents(stored.value.id);
    activeRuns.set(stored.value.id, run);
    const controller = new AbortController();
    activeRunControllers.set(stored.value.id, controller);
    if (suspending) {
      await suspendRun(stored, run, controller);
    } else if (cancelRequested.has(stored.value.id) || closing) {
      await run.cancel().catch(() => undefined);
    }

    let sequence = 0;
    try {
      for await (const event of run.stream({ signal: controller.signal })) {
        sequence += 1;
        const annotated = {
          ...event,
          workspaceId: workspace.id,
          sessionId: stored.value.sessionId,
          runId: stored.value.id,
          sequence,
        } as HostEvent;
        state.insertRunEvent(
          stored.value.id,
          sequence,
          serializeEvent(annotated),
          now(),
        );
        notifyRun(stored.value.id);
      }
      if (!suspending || suspendCancelledRuns.has(stored.value.id)) {
        finishRun(
          stored.value.id,
          hostResult(stored.value.id, await run.wait()),
        );
      }
    } catch (error) {
      if (suspending) return;
      await run.cancel().catch(() => undefined);
      finishRun(
        stored.value.id,
        failure(stored.value.id, "run_stream_failed", error),
      );
    } finally {
      activeRuns.delete(stored.value.id);
      activeRunControllers.delete(stored.value.id);
      cancelRequested.delete(stored.value.id);
      suspendCancelledRuns.delete(stored.value.id);
    }
  }

  async function processRun(stored: StoredRun): Promise<void> {
    const session = requireSession(stored.value.sessionId);
    const workspace = requireWorkspace(session.workspaceId);
    if (workspace.archivedAt !== null) {
      finishRun(
        stored.value.id,
        failure(stored.value.id, "workspace_archived", "workspace is archived"),
      );
      return;
    }

    try {
      if (stored.providerRunId) {
        // ACP has no way to reacquire an in-flight turn after the engine
        // process died; fail explicitly instead of replaying the prompt.
        finishRun(
          stored.value.id,
          failure(
            stored.value.id,
            "run_recovery_failed",
            "run was in progress when the engine process exited",
          ),
        );
        return;
      }
      if (stored.prompt === null) {
        throw new Error("queued run is missing its prompt");
      }
      if (!catalogValidatedRuns.delete(stored.value.id)) {
        resolveModelSelection(
          session.model,
          await availableModels(session.engine),
        );
      }
      const handle = await sessionHandle(session, workspace, stored.value.id);
      if (!handle) {
        cancelRequested.delete(stored.value.id);
        finishRun(stored.value.id, {
          runId: stored.value.id,
          status: "cancelled",
        });
        return;
      }
      if (cancelRequested.has(stored.value.id)) {
        cancelRequested.delete(stored.value.id);
        finishRun(stored.value.id, {
          runId: stored.value.id,
          status: "cancelled",
        });
        return;
      }
      const started = await handle.send(stored.prompt, {
        idempotencyKey: stored.value.id,
      });
      if (!state.markRunRunning(stored.value.id, started.runId, now())) {
        await started.cancel().catch(() => undefined);
        return;
      }
      notifyRun(stored.value.id);
      await consumeRun(stored, started, workspace);
      const latestHandle = enginePool.get(session.id)?.handle;
      if (
        latestHandle &&
        latestHandle.providerSessionId !== session.providerSessionId
      ) {
        state.updateSessionProviderSessionId(
          session.id,
          latestHandle.providerSessionId,
        );
      }
    } catch (error) {
      if (error instanceof HostError && error.code === "host_closed") {
        // Shutdown interrupted dispatch before the prompt reached an engine;
        // leave the run non-terminal so the next host retries it.
        return;
      }
      finishRun(
        stored.value.id,
        failure(
          stored.value.id,
          stored.providerRunId
            ? "run_recovery_failed"
            : error instanceof HostError &&
                (error.code === "model_catalog_unavailable" ||
                  error.code === "model_unavailable" ||
                  error.code === "unsupported_model_parameter" ||
                  error.code === "mode_unsupported" ||
                  error.code === "cloud_unavailable" ||
                  error.code === "invalid_engine")
              ? error.code
              : "run_dispatch_failed",
          error,
        ),
      );
    }
  }

  async function runSessionQueue(sessionId: string): Promise<void> {
    while (!closing) {
      let next = state.getActiveRun(sessionId);
      if (!next) {
        const queued = state.getNextQueuedRun(sessionId);
        if (!queued) return;
        if (!state.markRunDispatching(queued.value.id, now())) continue;
        notifyRun(queued.value.id);
        next = requireRun(queued.value.id);
      }
      await processRun(next);
    }
  }

  function scheduleSession(sessionId: string): void {
    if (closing || schedulers.has(sessionId)) return;
    const task = runSessionQueue(sessionId)
      .catch((error: unknown) => {
        const active = state.getActiveRun(sessionId);
        if (active) {
          finishRun(
            active.value.id,
            failure(active.value.id, "run_coordinator_failed", error),
          );
        }
      })
      .finally(() => {
        if (schedulers.get(sessionId) !== task) return;
        schedulers.delete(sessionId);
        if (!closing && state.getNextQueuedRun(sessionId)) {
          scheduleSession(sessionId);
          return;
        }
        markEngineIdle(sessionId);
      });
    schedulers.set(sessionId, task);
  }

  async function awaitResult(runId: string): Promise<RunResult> {
    for (;;) {
      if (closing) throw new HostError("host is closed", "host_closed");
      const stored = requireRun(runId);
      if (stored.result) return stored.result;
      const version = runVersions.get(runId) ?? 0;
      const latest = requireRun(runId);
      if (latest.result) return latest.result;
      await waitForRunChange(runId, version);
    }
  }

  async function cancelRun(runId: string): Promise<RunResult> {
    const stored = requireRun(runId);
    if (stored.result) return stored.result;
    if (stored.internalStatus === "queued") {
      finishRun(runId, { runId, status: "cancelled" });
      return requireRun(runId).result ?? { runId, status: "cancelled" };
    }
    cancelRequested.add(runId);
    capacityWaiterCancellers.get(runId)?.();
    await activeRuns
      .get(runId)
      ?.cancel()
      .catch(() => undefined);
    scheduleSession(stored.value.sessionId);
    return awaitResult(runId);
  }

  function transitionOperation(
    operationId: string,
    expected: WorkspaceOperation["phase"],
    next: WorkspaceOperation["phase"],
    branchOutcome?: WorkspaceOperation["branchOutcome"],
  ): void {
    const changed = state.advanceOperation(
      operationId,
      expected,
      next,
      now(),
      branchOutcome ?? undefined,
    );
    if (!changed && state.getOperation(operationId)?.phase !== next) {
      throw new HostError(
        `operation phase conflict: ${operationId}`,
        "operation_phase_conflict",
      );
    }
  }

  function recordAttention(
    operation: WorkspaceOperation,
    result: Extract<WorkspaceOperationStepResult, { state: "needs_attention" }>,
  ): void {
    state.finishOperation(
      operation.id,
      "needs_attention",
      "unsafe",
      safeOperationDiagnostic(
        result.reason,
        "Workspace operation requires manual attention",
        result.observed,
      ),
      now(),
    );
  }

  function createStepInput(
    operation: Extract<WorkspaceOperation, { type: "create_workspace" }>,
    target: "git_worktree_created" | "create_compensated",
  ) {
    return {
      operationId: operation.id,
      type: operation.type,
      target,
      repoRoot: requireProject(operation.projectId).repoRoot,
      ...operation.requestedInputs,
      copyGlobs: operation.requestedInputs.copyGlobs,
    } as const;
  }

  async function recoverCreateOperation(
    initial: Extract<WorkspaceOperation, { type: "create_workspace" }>,
  ): Promise<Workspace | undefined> {
    let operation = state.getOperation(initial.id) as typeof initial;
    let createdResult:
      Extract<WorkspaceOperationStepResult, { state: "advanced" }> | undefined;
    if (operation.phase === "intent_recorded") {
      const result = await git.advanceWorkspaceOperation(
        createStepInput(operation, "git_worktree_created"),
      );
      if (result.state === "needs_attention") {
        recordAttention(operation, result);
        return undefined;
      }
      createdResult = result;
      transitionOperation(
        operation.id,
        "intent_recorded",
        "git_worktree_created",
      );
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "git_worktree_created") {
      const result =
        createdResult ??
        (await git.advanceWorkspaceOperation(
          createStepInput(operation, "git_worktree_created"),
        ));
      if (result.state === "needs_attention") {
        recordAttention(operation, result);
        return undefined;
      }
      createdResult = result;
      transitionOperation(
        operation.id,
        "git_worktree_created",
        "path_verified",
      );
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "path_verified") {
      const result =
        createdResult ??
        (await git.advanceWorkspaceOperation(
          createStepInput(operation, "git_worktree_created"),
        ));
      if (result.state === "needs_attention") {
        recordAttention(operation, result);
        return undefined;
      }
      const resolvedPath = await realpath(
        operation.requestedInputs.worktreePath,
      );
      if (path.resolve(resolvedPath) !== path.resolve(result.worktreePath)) {
        recordAttention(operation, {
          state: "needs_attention",
          reason: "operation_identity_mismatch",
          repositoryIdentity: result.repositoryIdentity,
          observed: { resolvedPath, worktreePath: result.worktreePath },
        });
        return undefined;
      }
      const inputs = operation.requestedInputs;
      const existing = state.getWorkspace(operation.workspaceId);
      if (existing) {
        if (
          existing.projectId !== operation.projectId ||
          existing.slug !== inputs.slug ||
          existing.branch !== inputs.branch ||
          path.resolve(existing.worktreePath) !==
            path.resolve(inputs.worktreePath)
        ) {
          state.finishOperation(
            operation.id,
            "needs_attention",
            "unsafe",
            safeOperationDiagnostic(
              "workspace_row_conflict",
              "Workspace row does not match the operation",
            ),
            now(),
          );
          return undefined;
        }
        transitionOperation(
          operation.id,
          "path_verified",
          "workspace_row_committed",
        );
      } else {
        const slugCollision = state.getActiveWorkspaceBySlug(
          operation.projectId,
          inputs.slug,
        );
        const pathCollision = state.getActiveWorkspaceByPath(
          inputs.worktreePath,
        );
        if (slugCollision || pathCollision) {
          state.finishOperation(
            operation.id,
            "needs_attention",
            "unsafe",
            safeOperationDiagnostic(
              "workspace_row_conflict",
              "An active workspace conflicts with the operation",
            ),
            now(),
          );
          return undefined;
        }
        const createdAt = now();
        state.insertWorkspaceAndAdvanceOperation(
          {
            id: operation.workspaceId,
            projectId: operation.projectId,
            worktreePath: await realpath(inputs.worktreePath),
            branch: inputs.branch,
            slug: inputs.slug,
            baseRef: inputs.baseRef,
            createdAt,
            archivedAt: null,
          },
          operation.id,
          "path_verified",
          "workspace_row_committed",
          createdAt,
        );
      }
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "workspace_row_committed") {
      transitionOperation(
        operation.id,
        "workspace_row_committed",
        "operation_completed",
      );
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "operation_completed") {
      state.finishOperation(
        operation.id,
        "succeeded",
        "not_required",
        null,
        now(),
      );
    }
    return state.getWorkspace(operation.workspaceId);
  }

  function archiveStepInput(
    operation: Extract<WorkspaceOperation, { type: "archive_workspace" }>,
    target: "git_worktree_removed" | "branch_outcome_recorded",
  ) {
    return {
      operationId: operation.id,
      type: operation.type,
      target,
      repoRoot: requireProject(operation.projectId).repoRoot,
      worktreePath: operation.requestedInputs.worktreePath,
      branch: operation.requestedInputs.branch,
      keepBranch: operation.requestedInputs.keepBranch,
      expectedHead: operation.requestedInputs.expectedHead,
    } as const;
  }

  async function recoverArchiveOperation(
    initial: Extract<WorkspaceOperation, { type: "archive_workspace" }>,
  ): Promise<Workspace | undefined> {
    let operation = state.getOperation(initial.id) as typeof initial;
    if (operation.phase === "intent_recorded") {
      await Promise.all(
        state
          .listNonterminalRunsForWorkspace(operation.workspaceId)
          .map((run) => cancelRun(run.value.id)),
      );
      transitionOperation(
        operation.id,
        "intent_recorded",
        "active_runs_handled",
      );
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "active_runs_handled") {
      const result = await git.advanceWorkspaceOperation(
        archiveStepInput(operation, "git_worktree_removed"),
      );
      if (result.state === "needs_attention") {
        recordAttention(operation, result);
        return undefined;
      }
      if (operation.requestedInputs.expectedHead !== result.expectedHead) {
        state.updateOperationInputs(
          operation.id,
          { ...operation.requestedInputs, expectedHead: result.expectedHead },
          now(),
        );
      }
      transitionOperation(
        operation.id,
        "active_runs_handled",
        "git_worktree_removed",
      );
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "git_worktree_removed") {
      const result = await git.advanceWorkspaceOperation(
        archiveStepInput(operation, "branch_outcome_recorded"),
      );
      if (result.state === "needs_attention") {
        recordAttention(operation, result);
        return undefined;
      }
      if (!result.branchOutcome) {
        throw new HostError(
          "Git did not report a branch outcome",
          "operation_phase_conflict",
        );
      }
      transitionOperation(
        operation.id,
        "git_worktree_removed",
        "branch_outcome_recorded",
        result.branchOutcome,
      );
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "branch_outcome_recorded") {
      const archivedAt =
        state.getWorkspace(operation.workspaceId)?.archivedAt ?? now();
      state.archiveWorkspaceAndAdvanceOperation(
        operation.workspaceId,
        archivedAt,
        operation.id,
        "branch_outcome_recorded",
        "workspace_archived",
      );
      operation = state.getOperation(operation.id) as typeof initial;
    }
    if (operation.phase === "workspace_archived") {
      state.finishOperation(
        operation.id,
        "succeeded",
        "not_required",
        null,
        now(),
      );
    }
    return state.getWorkspace(operation.workspaceId);
  }

  async function recoverOperation(
    operation: WorkspaceOperation,
  ): Promise<void> {
    state.recordRecoveryAttempt(operation.id, now());
    try {
      if (operation.type === "create_workspace") {
        await recoverCreateOperation(operation);
      } else {
        await recoverArchiveOperation(operation);
      }
    } catch (error) {
      state.finishOperation(
        operation.id,
        "needs_attention",
        "unsafe",
        operationFailure(error),
        now(),
      );
    }
  }

  function shutdown(mode: "close" | "suspend"): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    suspending = mode === "suspend";
    const shutdownError = new HostError("host is closed", "host_closed");
    for (const waiters of capacityWaiters.values()) {
      for (const waiter of waiters) waiter.reject(shutdownError);
    }
    capacityWaiters.clear();
    shutdownPromise = (async () => {
      try {
        if (suspending) {
          const cancellations: Promise<void>[] = [];
          for (const [runId, run] of activeRuns) {
            const stored = state.getRun(runId);
            const controller = activeRunControllers.get(runId);
            if (!stored || !controller) continue;
            cancellations.push(suspendRun(stored, run, controller));
          }
          await Promise.all(cancellations);
        } else {
          for (const stored of state.listNonterminalRuns()) {
            if (stored.internalStatus !== "queued") {
              cancelRequested.add(stored.value.id);
            }
          }
          await Promise.all(
            [...activeRuns.values()].map((run) =>
              run.cancel().catch(() => undefined),
            ),
          );
        }
        await Promise.allSettled([...pendingEngineCreations]);
        await Promise.all([...schedulers.values()]);
        await Promise.all(
          [...enginePool.values()].map((entry) => {
            return evictEngineEntry(entry);
          }),
        );
        enginePool.clear();
        await Promise.all(
          [...retiringEngineDisposals.values()].flatMap((disposals) => [
            ...disposals,
          ]),
        );
        engineClaims.clear();
      } finally {
        for (const runId of runWaiters.keys()) notifyRun(runId);
        try {
          database.close();
        } finally {
          closed = true;
          await hostLease.release();
        }
      }
    })();
    return shutdownPromise;
  }

  const host: Host = {
    async capabilities() {
      assertOpen();
      return capabilities();
    },
    close() {
      return shutdown("close");
    },
    suspend() {
      return shutdown("suspend");
    },
    projects: {
      async register(repoRoot) {
        assertOpen();
        const resolved = await realpath(path.resolve(repoRoot));
        assertOpen();
        const existing = state.getProjectByRoot(resolved);
        if (existing) return existing;
        const row = { id: ulid(), repoRoot: resolved, createdAt: now() };
        try {
          state.insertProject(row);
        } catch (error) {
          if (isUniqueConstraint(error)) {
            const raced = state.getProjectByRoot(resolved);
            if (raced) return raced;
          }
          throw error;
        }
        return { id: row.id, repoRoot: row.repoRoot };
      },
      get(id) {
        assertOpen();
        return state.getProject(id);
      },
      list() {
        assertOpen();
        return state.listProjects();
      },
      async reconcile(input) {
        assertOpen();
        const project = requireProject(input.projectId);
        const workspaces = state.listWorkspaces(project.id, false);
        return reconcileProject(project, workspaces, () =>
          git.inspectRepository(project.repoRoot),
        );
      },
    },
    workspaces: {
      async create(input) {
        assertOpen();
        const project = requireProject(input.projectId);
        const slug = assertSlug(input.slug);
        const branch = input.branch ?? `sunset/${slug}`;
        const baseRef = input.baseRef ?? "HEAD";
        const worktreePath = path.join(worktreeRoot, slug);
        if (
          !isPathInside(worktreeRoot, worktreePath) ||
          path.resolve(worktreePath) === worktreeRoot
        ) {
          throw new HostError(
            `worktree path escapes worktreeRoot: ${slug}`,
            "invalid_slug",
          );
        }
        if (isPathInside(project.repoRoot, worktreePath)) {
          throw new HostError(
            "worktreeRoot must not be inside the source repo",
            "nested_worktree",
          );
        }
        if (state.getActiveWorkspaceBySlug(project.id, slug)) {
          throw new HostError(
            `workspace slug already exists: ${slug}`,
            "slug_exists",
          );
        }
        if (state.getActiveWorkspaceByPath(worktreePath)) {
          throw new HostError(
            `workspace path already exists: ${worktreePath}`,
            "workspace_path_exists",
          );
        }
        const createdAt = now();
        const operation: Extract<
          WorkspaceOperation,
          { type: "create_workspace" }
        > = {
          schemaVersion: 1,
          id: ulid(),
          type: "create_workspace",
          projectId: project.id,
          workspaceId: ulid(),
          requestedInputs: {
            slug,
            branch,
            baseRef,
            worktreePath,
            copyGlobs: [...(input.copyGlobs ?? [])],
          },
          phase: "intent_recorded",
          branchOutcome: null,
          createdAt,
          updatedAt: createdAt,
          lastRecoveryAt: null,
          recoveryAttemptCount: 0,
          terminalOutcome: null,
          terminalAt: null,
          compensationOutcome: "not_required",
          diagnostic: null,
        };
        state.insertOperation(operation);
        try {
          const workspace = await recoverCreateOperation(operation);
          if (!workspace) {
            throw new HostError(
              `workspace operation needs attention: ${operation.id}`,
              "operation_needs_attention",
            );
          }
          return workspace;
        } catch (error) {
          const latest = state.getOperation(operation.id);
          if (latest?.terminalOutcome === "needs_attention") throw error;
          let compensation: "not_required" | "succeeded" | "failed" | "unsafe" =
            "not_required";
          if (
            latest?.type === "create_workspace" &&
            (latest.phase === "git_worktree_created" ||
              latest.phase === "path_verified")
          ) {
            try {
              const result = await git.advanceWorkspaceOperation(
                createStepInput(latest, "create_compensated"),
              );
              compensation =
                result.state === "advanced" ? "succeeded" : "unsafe";
            } catch {
              compensation = "failed";
            }
          }
          state.finishOperation(
            operation.id,
            compensation === "unsafe" ||
              compensation === "failed" ||
              latest?.phase === "workspace_row_committed" ||
              latest?.phase === "operation_completed"
              ? "needs_attention"
              : "failed",
            latest?.phase === "workspace_row_committed" ||
              latest?.phase === "operation_completed"
              ? "unsafe"
              : compensation,
            operationFailure(error),
            now(),
          );
          throw error;
        }
      },
      list(input) {
        assertOpen();
        return state.listWorkspaces(
          input.projectId,
          input.includeArchived ?? false,
        );
      },
      get(id) {
        assertOpen();
        return state.getWorkspace(id);
      },
      async archive(input) {
        assertOpen();
        const workspace = requireWorkspace(input.workspaceId);
        const snapshot = await git.inspectRepository(
          requireProject(workspace.projectId).repoRoot,
        );
        const candidates = snapshot.worktrees.filter(
          (worktree) =>
            path.resolve(worktree.path) ===
            path.resolve(workspace.worktreePath),
        );
        const expectedHead =
          candidates.length === 1 &&
          candidates[0]?.pathExists &&
          !candidates[0].bare &&
          candidates[0].branch === workspace.branch
            ? candidates[0].head
            : null;
        const createdAt = now();
        const operation: Extract<
          WorkspaceOperation,
          { type: "archive_workspace" }
        > = {
          schemaVersion: 1,
          id: ulid(),
          type: "archive_workspace",
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          requestedInputs: {
            branch: workspace.branch,
            worktreePath: workspace.worktreePath,
            keepBranch: input.keepBranch ?? true,
            expectedHead,
          },
          phase: "intent_recorded",
          branchOutcome: null,
          createdAt,
          updatedAt: createdAt,
          lastRecoveryAt: null,
          recoveryAttemptCount: 0,
          terminalOutcome: null,
          terminalAt: null,
          compensationOutcome: "not_required",
          diagnostic: null,
        };
        state.insertOperation(operation);
        try {
          const archived = await recoverArchiveOperation(operation);
          if (!archived) {
            throw new HostError(
              `workspace operation needs attention: ${operation.id}`,
              "operation_needs_attention",
            );
          }
          return archived;
        } catch (error) {
          const latest = state.getOperation(operation.id);
          if (latest?.terminalOutcome !== "needs_attention") {
            state.finishOperation(
              operation.id,
              "needs_attention",
              "unsafe",
              operationFailure(error),
              now(),
            );
          }
          throw error;
        }
      },
    },
    sessions: {
      async create(input) {
        assertOpen();
        const workspace = requireWorkspace(input.workspaceId);
        if (workspace.archivedAt !== null) {
          throw new HostError("workspace is archived", "workspace_archived");
        }
        const engine = parseEngine(input.engine);
        const location = parseLocation(input.location);
        const mode = input.mode ?? "agent";
        if (!engineFor(engine).supportedModes().includes(mode)) {
          throw new HostError(
            `engine ${engine} does not support mode ${mode}`,
            "mode_unsupported",
          );
        }
        const model = resolveModelSelection(
          input.model,
          await availableModels(engine),
        );
        assertOpen();
        const executionPolicy = resolveExecutionPolicy(
          input.executionPolicy,
          defaultExecutionPolicy,
        );
        await ensureEngineCapacity(workspace.id);
        const creation = (async () => {
          const handle = await engineFor(engine).create({
            cwd: workspace.worktreePath,
            model,
            mode,
            executionPolicy,
          });
          if (closing) {
            await handle.dispose().catch(() => undefined);
            throw new HostError("host is closed", "host_closed");
          }
          const session: Session = {
            id: ulid(),
            workspaceId: workspace.id,
            engine,
            location,
            providerSessionId: handle.providerSessionId,
            mode,
            model,
            executionPolicy,
            createdAt: now(),
          };
          const run: Run = {
            id: ulid(),
            sessionId: session.id,
            status: "queued",
            createdAt: now(),
            startedAt: null,
            finishedAt: null,
          };
          state.insertSessionAndRun(session, run, input.prompt);
          catalogValidatedRuns.add(run.id);
          registerEngineEntry(session.id, workspace.id, handle);
          scheduleSession(session.id);
          return { session, run };
        })();
        pendingEngineCreations.add(creation);
        try {
          return await creation;
        } finally {
          pendingEngineCreations.delete(creation);
          releaseEngineCapacity(workspace.id);
        }
      },
      async send(input) {
        assertOpen();
        const session = requireSession(input.sessionId);
        const workspace = requireWorkspace(session.workspaceId);
        if (workspace.archivedAt !== null) {
          throw new HostError("workspace is archived", "workspace_archived");
        }
        resolveModelSelection(
          session.model,
          await availableModels(session.engine),
        );
        assertOpen();
        const run: Run = {
          id: ulid(),
          sessionId: session.id,
          status: "queued",
          createdAt: now(),
          startedAt: null,
          finishedAt: null,
        };
        state.insertRun(run, input.prompt);
        catalogValidatedRuns.add(run.id);
        scheduleSession(session.id);
        return { session, run };
      },
      get(id) {
        assertOpen();
        return state.getSession(id);
      },
      list(input) {
        assertOpen();
        return state.listSessions(input.workspaceId);
      },
    },
    runs: {
      get(id) {
        assertOpen();
        return state.getRun(id)?.value;
      },
      list(input) {
        assertOpen();
        requireSession(input.sessionId);
        return state.listRuns(input.sessionId);
      },
      async wait(input) {
        assertOpen();
        return awaitResult(input.runId);
      },
      async cancel(input) {
        assertOpen();
        return cancelRun(input.runId);
      },
      attach(input) {
        assertOpen();
        requireRun(input.runId);
        const afterSequence = input.afterSequence ?? 0;
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
          throw new HostError(
            "afterSequence must be a non-negative safe integer",
            "invalid_sequence",
          );
        }
        return {
          async *[Symbol.asyncIterator]() {
            let sequence = afterSequence;
            for (;;) {
              if (closing || input.signal?.aborted) return;
              const version = runVersions.get(input.runId) ?? 0;
              const events = state.listRunEventsAfter(input.runId, sequence);
              for (const row of events) {
                if (input.signal?.aborted) return;
                sequence = row.sequence;
                yield parseEvent(row.event_json);
              }
              const stored = requireRun(input.runId);
              if (stored.result) return;
              if (events.length > 0) continue;
              if (
                !(await waitForRunChange(input.runId, version, input.signal))
              ) {
                return;
              }
            }
          },
        };
      },
    },
    diagnostics: {
      operations: {
        get(input) {
          assertOpen();
          return state.getOperation(input.operationId);
        },
        list(input = {}) {
          assertOpen();
          return state.listOperations(input);
        },
      },
    },
  };

  try {
    for (const operation of state.listRecoverableOperations()) {
      await recoverOperation(operation);
    }
  } catch (error) {
    database.close();
    await hostLease.release();
    throw error;
  }
  for (const run of state.listNonterminalRuns()) {
    scheduleSession(run.value.sessionId);
  }

  return host;
}
