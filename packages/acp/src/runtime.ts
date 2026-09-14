import { randomUUID } from "node:crypto";

import type {
  AgentMode,
  ModelCapability,
  ModelSelection,
} from "@sunset/domain";
import { resolveExecutionPolicy } from "@sunset/domain";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
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
    ? parsed
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
  private active: AgentEventQueue | null = null;

  constructor(private readonly cwd: string) {}

  handleUpdate(sessionId: string, update: SessionUpdate): void {
    if (sessionId !== this.providerSessionId) return;
    for (const event of mapSessionUpdate(update)) this.active?.push(event);
  }

  async send(prompt: string): Promise<EngineRun> {
    if (this.active && !this.active.done) throw new Error("turn_in_progress");
    const runId = randomUUID();
    const queue = new AgentEventQueue();
    this.active = queue;
    const promptPromise = this.conn
      .request("session/prompt", {
        sessionId: this.providerSessionId,
        prompt: [{ type: "text", text: prompt }],
      })
      .then((response) => {
        const usage = promptUsage(response);
        if (usage) queue.push({ type: "usage", ...usage });
        return response;
      })
      .finally(() => queue.finish());
    const conn = this.conn;
    const providerSessionId = this.providerSessionId;
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
): Promise<void> {
  if (!mode || mode === "agent") return;
  const available = modes?.availableModes?.map((entry) => entry.id) ?? [];
  const target = PLAN_MODE_CANDIDATES.find((candidate) =>
    available.includes(candidate),
  );
  if (!target) return;
  try {
    await controlRequest(conn, "session/set_mode", {
      sessionId,
      modeId: target,
    });
  } catch (error) {
    // set_mode is best-effort, but a timeout already closed the connection —
    // the session must not come back looking usable.
    if (isTimeoutError(error)) throw error;
  }
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
      onClose: () => undefined,
    });
  }

  async function openSession(
    input: CreateEngineInput,
    providerSessionId?: string,
  ): Promise<EngineSessionHandle> {
    // The connector needs a session reference for update routing; conn is
    // assigned before any agent traffic can arrive.
    const session = new AcpSession(input.cwd);
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
      try {
        await controlRequest(conn, "session/resume", {
          sessionId: providerSessionId,
          cwd: input.cwd,
          mcpServers: [],
        });
      } catch (resumeError) {
        if (isAuthError(resumeError)) {
          await authenticate();
          try {
            await controlRequest(conn, "session/resume", {
              sessionId: providerSessionId,
              cwd: input.cwd,
              mcpServers: [],
            });
            if (definition.modelViaSetModel) {
              await applyModel(conn, providerSessionId, input.model);
            }
            return session;
          } catch (retryError) {
            if (isTimeoutError(retryError)) throw retryError;
            // fall through to session/load
          }
        }
        if (isTimeoutError(resumeError)) throw resumeError;
        try {
          await controlRequest(conn, "session/load", {
            sessionId: providerSessionId,
            cwd: input.cwd,
            mcpServers: [],
          });
          if (definition.modelViaSetModel) {
            await applyModel(conn, providerSessionId, input.model);
          }
        } catch (error) {
          if (isAuthError(error)) {
            await authenticate();
            try {
              await controlRequest(conn, "session/load", {
                sessionId: providerSessionId,
                cwd: input.cwd,
                mcpServers: [],
              });
              if (definition.modelViaSetModel) {
                await applyModel(conn, providerSessionId, input.model);
              }
              return session;
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
      }
      if (definition.modelViaSetModel) {
        await applyModel(conn, providerSessionId, input.model);
      }
      return session;
    }

    let created: { sessionId: string; modes?: SessionModeState };
    try {
      created = (await controlRequest(conn, "session/new", {
        cwd: input.cwd,
        mcpServers: [],
      })) as { sessionId: string; modes?: SessionModeState };
    } catch (error) {
      if (!isAuthError(error)) throw error;
      // Engines like `devin acp` keep credentials per-process: authenticate
      // once on this connection, then retry session creation.
      await authenticate();
      created = (await controlRequest(conn, "session/new", {
        cwd: input.cwd,
        mcpServers: [],
      })) as { sessionId: string; modes?: SessionModeState };
    }
    session.providerSessionId = created.sessionId;
    if (definition.modelViaSetModel) {
      await applyModel(conn, created.sessionId, input.model);
    }
    await applyMode(conn, created.sessionId, input.mode, created.modes ?? null);
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
