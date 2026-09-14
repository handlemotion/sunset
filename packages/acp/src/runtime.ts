import { randomUUID } from "node:crypto";

import type {
  AgentMode,
  ExecutionPolicy,
  ModelCapability,
  ModelSelection,
} from "@sunset/domain";
import { resolveExecutionPolicy } from "@sunset/domain";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import {
  stdioConnector,
  type AcpConnectionHandle,
  type AcpConnector,
} from "./client.js";
import { resolveEngineSpawn, type EngineDefinition } from "./engines.js";
import { codexModelId, listModels, upstreamModelId } from "./catalog.js";
import { mapSessionUpdate } from "./map.js";
import type {
  CreateEngineInput,
  Engine,
  EngineRun,
  EngineSessionHandle,
  ResumeEngineInput,
} from "./types.js";

const PLAN_MODE_CANDIDATES = ["plan", "read-only", "read_only"];
const SESSION_CLOSE_TIMEOUT_MS = 2_000;

function isAuthError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /not authenticated|authenticate|unauthorized|401/i.test(error.message)
  );
}

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Rejects a control-plane request that outlives its deadline. */
export class AcpRequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`acp_request_timeout:${method} after ${timeoutMs}ms`);
    this.name = "AcpRequestTimeoutError";
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof AcpRequestTimeoutError;
}

function controlTimeoutMs(): number {
  const parsed = Number(process.env.SUNSET_ACP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_TIMER_DELAY_MS)
    : DEFAULT_CONTROL_TIMEOUT_MS;
}

/**
 * Bounded `conn.request` for control-plane methods: a wedged agent must not
 * hang session setup forever. On timeout the connection is closed so a
 * half-initialized session can't linger. `session/prompt` stays unbounded —
 * cancellation is its escape hatch.
 */
function controlRequest(
  conn: AcpConnectionHandle,
  method: string,
  params: unknown,
): Promise<unknown> {
  const timeoutMs = controlTimeoutMs();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.close();
      reject(new AcpRequestTimeoutError(method, timeoutMs));
    }, timeoutMs);
    conn.request(method, params).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Pull a `{used, size}` usage payload off a `session/prompt` response —
 * adapters report it via `usage` or `_meta.quota`.
 */
function promptUsage(response: unknown): { used: number; size: number } | null {
  if (typeof response !== "object" || response === null) return null;
  const record = response as Record<string, unknown>;
  const meta =
    typeof record._meta === "object" && record._meta !== null
      ? (record._meta as Record<string, unknown>)
      : null;
  for (const candidate of [record.usage, meta?.quota]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const usage = candidate as Record<string, unknown>;
    if (typeof usage.used === "number" && typeof usage.size === "number") {
      return { used: usage.used, size: usage.size };
    }
  }
  return null;
}

type Turn = {
  events: AgentEventQueue;
};

class AgentEventQueue {
  events: import("@sunset/domain").AgentEvent[] = [];
  text = "";
  done = false;
  private waiters: Array<() => void> = [];

  push(event: import("@sunset/domain").AgentEvent): void {
    if (event.type === "text_delta") this.text += event.text;
    this.events.push(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  finish(): void {
    this.done = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *drain(
    signal?: AbortSignal,
  ): AsyncIterable<import("@sunset/domain").AgentEvent> {
    let index = 0;
    while (true) {
      if (signal?.aborted) return;
      while (index < this.events.length) {
        yield this.events[index]!;
        index += 1;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

class AcpSession implements EngineSessionHandle {
  providerSessionId = "";
  conn!: AcpConnectionHandle;
  /** Set by the connector's onClose; gates session/prompt retries. */
  closed = false;
  private active: AgentEventQueue | null = null;

  constructor(
    private readonly cwd: string,
    private readonly retryPrompts: boolean,
  ) {}

  handleUpdate(sessionId: string, update: SessionUpdate): void {
    if (sessionId !== this.providerSessionId) return;
    for (const event of mapSessionUpdate(update)) this.active?.push(event);
  }

  async send(prompt: string): Promise<EngineRun> {
    if (this.active && !this.active.done) throw new Error("turn_in_progress");
    const runId = randomUUID();
    const queue = new AgentEventQueue();
    this.active = queue;
    const conn = this.conn;
    const providerSessionId = this.providerSessionId;
    const turn = { cancelled: false };
    const promptOnce = () =>
      conn
        .request("session/prompt", {
          sessionId: providerSessionId,
          prompt: [{ type: "text", text: prompt }],
        })
        .then((response) => {
          const usage = promptUsage(response);
          if (usage) queue.push({ type: "usage", ...usage });
          return response;
        });
    // agentRetries: one same-session retry of a rejected session/prompt while
    // the agent connection is still live. A cancelled turn — resolved with
    // stopReason "cancelled" or rejected after run.cancel() — never retries,
    // and neither do control-plane requests.
    const promptPromise = promptOnce()
      .catch((error: unknown) => {
        if (turn.cancelled || this.closed || !this.retryPrompts) throw error;
        return promptOnce();
      })
      .finally(() => queue.finish());
    const run: EngineRun = {
      runId,
      stream: (options) => queue.drain(options?.signal),
      async wait() {
        try {
          const response = (await promptPromise) as { stopReason?: string };
          return {
            runId,
            status:
              response.stopReason === "cancelled" ? "cancelled" : "finished",
            ...(queue.text ? { result: queue.text } : {}),
          };
        } catch (error) {
          return {
            runId,
            status: "error" as const,
            error: {
              message: error instanceof Error ? error.message : "prompt_failed",
            },
          };
        }
      },
      async cancel() {
        turn.cancelled = true;
        await conn
          .notify("session/cancel", { sessionId: providerSessionId })
          .catch(() => undefined);
      },
    };
    return run;
  }

  async dispose(): Promise<void> {
    const sessionId = this.providerSessionId;
    if (sessionId) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.conn.request("session/close", { sessionId }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SESSION_CLOSE_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
      } catch {
        // Unsupported or rejected session/close still falls through to
        // transport close and process-group teardown.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.conn.close();
  }
}

function pickPermission(
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const options = params.options ?? [];
  const allow =
    options.find((option) => option.kind === "allow_always") ??
    options.find((option) => option.kind === "allow_once");
  if (allow)
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  const reject = options.find((option) => option.kind?.startsWith("reject"));
  if (reject)
    return { outcome: { outcome: "selected", optionId: reject.optionId } };
  return { outcome: { outcome: "cancelled" } };
}

function deniedPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

async function applyModel(
  conn: AcpConnectionHandle,
  sessionId: string,
  model: ModelSelection,
): Promise<void> {
  if (!model.id) return;
  try {
    await controlRequest(conn, "session/set_model", {
      sessionId,
      modelId: codexModelId(model),
    });
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    // Older adapters without set_model keep their spawn-time default.
    if (
      error instanceof Error &&
      /method not found|unknown method|-32601/i.test(error.message)
    ) {
      return;
    }
    throw error;
  }
}

async function applyMode(
  conn: AcpConnectionHandle,
  sessionId: string,
  mode: AgentMode | undefined,
  modes: SessionModeState | null,
): Promise<boolean> {
  if (!mode || mode === "agent") return false;
  const available = modes?.availableModes?.map((entry) => entry.id) ?? [];
  const target = PLAN_MODE_CANDIDATES.find((candidate) =>
    available.includes(candidate),
  );
  if (!target) return false;
  try {
    await controlRequest(conn, "session/set_mode", {
      sessionId,
      modeId: target,
    });
  } catch (error) {
    // set_mode is best-effort, but a timeout already closed the connection —
    // the session must not come back looking usable.
    if (isTimeoutError(error)) throw error;
    return false;
  }
  return true;
}

/**
 * The mode/config surfaces a session response advertises. `session/new`,
 * `session/resume`, and `session/load` all carry `modes` and
 * `configOptions`.
 */
type SessionSurface = {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
};

/** Codex's select config option carrying the session mode. */
const MODE_CONFIG_ID = "mode";

/**
 * ExecutionPolicy → engine mode, strictest-first: `sandbox.enabled` maps to
 * `read-only`; otherwise `autoReview` maps to `agent`; otherwise
 * `agent-full-access`. Sandbox wins over autoReview because a sandboxed run
 * must never inherit the unsandboxed tier just because review automation was
 * requested. These ids are the codex-acp 1.11.0 mode surface: `read-only` is
 * on-request approvals under a workspace-write sandbox with no writable
 * roots, `agent` is the default auto-review/workspace-write tier, and
 * `agent-full-access` drops approvals entirely (danger-full-access).
 */
function policyModeId(policy: ExecutionPolicy): string {
  if (policy.sandbox.enabled) return "read-only";
  if (policy.autoReview) return "agent";
  return "agent-full-access";
}

/** Advertised value ids of a `select` config option, flattening groups. */
function selectOptionValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  const values: string[] = [];
  for (const entry of option.options) {
    if ("value" in entry) values.push(entry.value);
    else for (const grouped of entry.options) values.push(grouped.value);
  }
  return values;
}

/**
 * Apply the execution policy's mode to a created or resumed session.
 *
 * An explicit `mode: "plan"` request keeps its existing behavior first; the
 * policy mode is only consulted when no plan-capable mode was advertised,
 * and then clamped to at most `agent` so an unhonored plan request can never
 * land the session in `agent-full-access`.
 *
 * The codex adapter (codex-acp 1.11.0) advertises a `select` config option
 * id "mode" over `read-only`/`agent`/`agent-full-access`; it is applied via
 * `session/set_config_option` only when that option and the desired value
 * are both advertised. Adapters without the config option, or adapters that
 * reject the write, fall back to `session/set_mode` when the target mode id
 * is advertised. Absent, unknown, or non-select options are skipped; no
 * `_meta` keys are guessed.
 *
 * When the target is advertised but every surface rejects it, the session
 * fails closed — the connection is closed and creation throws rather than
 * silently running at the adapter's weaker default. When no surface
 * advertises the target at all, application is skipped silently so
 * adapters without the control keep working best-effort.
 */
async function applySessionMode(
  conn: AcpConnectionHandle,
  sessionId: string,
  requested: AgentMode | undefined,
  policy: ExecutionPolicy,
  surface: SessionSurface,
): Promise<void> {
  let target = policyModeId(policy);
  if (requested === "plan") {
    if (await applyMode(conn, sessionId, requested, surface.modes ?? null)) {
      return;
    }
    // An unhonored plan request must not end up in agent-full-access.
    if (target === "agent-full-access") target = "agent";
  }
  const option = surface.configOptions?.find(
    (entry) => entry.id === MODE_CONFIG_ID && entry.type === "select",
  );
  const configId =
    option && selectOptionValues(option).includes(target) ? option.id : null;
  const viaModes =
    surface.modes?.availableModes?.some((entry) => entry.id === target) ??
    false;
  if (configId === null && !viaModes) return;
  if (configId !== null) {
    try {
      await controlRequest(conn, "session/set_config_option", {
        sessionId,
        configId,
        value: target,
      });
      return;
    } catch (error) {
      if (isTimeoutError(error)) throw error;
      // Rejected write: fall through to the advertised set_mode surface.
    }
  }
  if (viaModes) {
    try {
      await controlRequest(conn, "session/set_mode", {
        sessionId,
        modeId: target,
      });
      return;
    } catch (error) {
      if (isTimeoutError(error)) throw error;
    }
  }
  conn.close();
  throw new Error(`policy_mode_unapplied:${target}`);
}

export function createEngine(
  definition: EngineDefinition,
  options?: { connector?: AcpConnector; engineGroupDir?: string },
): Engine {
  async function connectorFor(input: CreateEngineInput, session: AcpSession) {
    const model = input.model.id
      ? upstreamModelId(definition.id, input.model.id)
      : undefined;
    const connector =
      options?.connector ??
      (await (async (): Promise<AcpConnector> => {
        const spawn =
          definition.id === "codex" ? await resolveEngineSpawn("codex") : null;
        const modelInput = model ? { model } : {};
        return stdioConnector({
          command: spawn ? spawn.command : definition.command,
          args: [...(spawn?.args ?? []), ...definition.args(modelInput)],
          ...(definition.env ? { env: definition.env(modelInput) } : {}),
          ...(options?.engineGroupDir
            ? { engineGroupDir: options.engineGroupDir }
            : {}),
        });
      })());
    return connector({
      cwd: input.cwd,
      onUpdate: (sessionId, update) => session.handleUpdate(sessionId, update),
      onPermission: async (params: RequestPermissionRequest) => {
        const policy = resolveExecutionPolicy(input.executionPolicy);
        const name = params.toolCall?.name ?? params.toolCall?.title ?? "";
        if (policy.toolDenylist.includes(name)) return deniedPermission();
        if (policy.toolAllowlist && !policy.toolAllowlist.includes(name)) {
          return deniedPermission();
        }
        return pickPermission(params);
      },
      onClose: () => {
        session.closed = true;
      },
    });
  }

  async function openSession(
    input: CreateEngineInput,
    providerSessionId?: string,
  ): Promise<EngineSessionHandle> {
    // The connector needs a session reference for update routing; conn is
    // assigned before any agent traffic can arrive.
    const policy = resolveExecutionPolicy(input.executionPolicy);
    const session = new AcpSession(input.cwd, policy.agentRetries);
    const conn = await connectorFor(input, session);
    session.conn = conn;

    const init = (await controlRequest(conn, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "sunset", title: "Sunset", version: "0.0.1" },
    })) as {
      agentCapabilities?: {
        loadSession?: boolean;
        sessionCapabilities?: { resume?: boolean };
      };
      authMethods?: Array<{ id: string }>;
    };

    async function authenticate(): Promise<void> {
      const method = init.authMethods?.[0]?.id;
      if (!method) {
        throw new Error(
          "engine requires authentication but advertises no methods",
        );
      }
      await controlRequest(conn, "authenticate", {
        methodId: method,
        ...(input.apiKey ? { _meta: { api_key: input.apiKey } } : {}),
      });
    }

    if (providerSessionId) {
      session.providerSessionId = providerSessionId;
      const canResume =
        init.agentCapabilities?.loadSession === true ||
        init.agentCapabilities?.sessionCapabilities?.resume === true;
      if (!canResume) {
        conn.close();
        throw new Error("session_resume_unsupported");
      }
      // Resume ladder: session/resume, one re-auth retry, then session/load
      // with the same retry. The winning response supplies the mode/config
      // surface the execution policy is applied against below.
      const attach = (method: "session/resume" | "session/load") =>
        controlRequest(conn, method, {
          sessionId: providerSessionId,
          cwd: input.cwd,
          mcpServers: [],
        }) as Promise<SessionSurface>;
      const loadSession = async (): Promise<SessionSurface> => {
        try {
          return await attach("session/load");
        } catch (error) {
          if (isAuthError(error)) {
            await authenticate();
            try {
              return await attach("session/load");
            } catch (retry) {
              if (isTimeoutError(retry)) throw retry;
              conn.close();
              throw new Error(
                `session_resume_failed:${retry instanceof Error ? retry.message : "unknown"}`,
              );
            }
          }
          if (isTimeoutError(error)) throw error;
          conn.close();
          throw new Error(
            `session_resume_failed:${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      };
      let attached: SessionSurface;
      try {
        attached = await attach("session/resume");
      } catch (resumeError) {
        if (isAuthError(resumeError)) {
          await authenticate();
          try {
            attached = await attach("session/resume");
          } catch (retryError) {
            if (isTimeoutError(retryError)) throw retryError;
            // fall through to session/load
            attached = await loadSession();
          }
        } else {
          if (isTimeoutError(resumeError)) throw resumeError;
          attached = await loadSession();
        }
      }
      if (definition.modelViaSetModel) {
        await applyModel(conn, providerSessionId, input.model);
      }
      await applySessionMode(
        conn,
        providerSessionId,
        input.mode,
        policy,
        attached,
      );
      return session;
    }

    let created: { sessionId: string } & SessionSurface;
    try {
      created = (await controlRequest(conn, "session/new", {
        cwd: input.cwd,
        mcpServers: [],
      })) as { sessionId: string } & SessionSurface;
    } catch (error) {
      if (!isAuthError(error)) throw error;
      // Engines like `devin acp` keep credentials per-process: authenticate
      // once on this connection, then retry session creation.
      await authenticate();
      created = (await controlRequest(conn, "session/new", {
        cwd: input.cwd,
        mcpServers: [],
      })) as { sessionId: string } & SessionSurface;
    }
    session.providerSessionId = created.sessionId;
    if (definition.modelViaSetModel) {
      await applyModel(conn, created.sessionId, input.model);
    }
    await applySessionMode(
      conn,
      created.sessionId,
      input.mode,
      policy,
      created,
    );
    return session;
  }

  return {
    id: definition.id,
    listModels: (): Promise<ModelCapability[]> => listModels(definition.id),
    supportedModes: () =>
      definition.id === "codex" ? ["agent", "plan"] : ["agent"],
    create: (input) => openSession(input),
    resume: (input) => openSession(input, input.providerSessionId),
  };
}
