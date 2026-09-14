import {
  agent as acpAgent,
  client as acpClient,
  RequestError,
  type AgentApp,
  type AgentCapabilities,
  type AgentConnection,
  type AuthMethod,
  type ClientContext,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";

/** Configurable behavior for the fake's `authenticate` handler. */
export type FakeAcpAuthenticate = {
  /** When set, `authenticate` with any other methodId fails. */
  methodId?: string;
  /** Fail this many `authenticate` calls per connection before succeeding. */
  failTimes?: number;
  /** Error thrown for each failure (default: an auth-required error). */
  error?: Error;
};

/** `session/resume` or `session/load` outcome: success by default. */
export type FakeAcpLoadFailure = {
  /** `"auth"` throws an auth-required error; an Error is thrown as-is. */
  error?: Error | "auth";
};

/** Model state returned in the `session/new` response (codex-style). */
export type FakeAcpModels = {
  availableModels?: Array<{
    modelId: string;
    name?: string;
    description?: string;
  }>;
  currentModelId?: string;
};

/** Scripted `session/prompt` behavior. */
export type FakeAcpPrompt = {
  /** `session/update` payloads emitted in order before the turn ends. */
  updates?: SessionUpdate[];
  /** Stop reason returned when the turn completes (default "end_turn"). */
  stopReason?: StopReason;
  /** Throw this after emitting the updates instead of returning stopReason. */
  error?: Error;
  /** Hold the turn open until `session/cancel`, then answer "cancelled". */
  waitForCancel?: boolean;
};

export type FakeAcpAgentOptions = {
  name?: string;
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  /**
   * When true, session methods fail with an auth-required error until
   * `authenticate` succeeds on that connection — credentials are kept
   * per-connection, like agents that hold them per process.
   */
  requireAuth?: boolean;
  authenticate?: FakeAcpAuthenticate;
  /** Session id returned by `session/new` (default "fake-session-1"). */
  sessionId?: string;
  models?: FakeAcpModels;
  modes?: SessionModeState | null;
  resume?: FakeAcpLoadFailure;
  load?: FakeAcpLoadFailure;
  prompt?: FakeAcpPrompt;
  /** These methods accept the request but never answer it. */
  hangOn?: string[];
  /** These methods are left unregistered; the SDK answers method-not-found. */
  methodNotFound?: string[];
  /**
   * Disconnect the agent mid-conversation. A method name closes the
   * connection right after that method's handler responds. A number kills
   * the agent mid-run: the connection closes after that many `session/update`
   * notifications have been emitted during `session/prompt` (1-based), so the
   * prompt request never resolves normally.
   */
  exitAfter?: string | number;
};

/** One recorded request or notification received by the fake agent. */
export type FakeAcpCall = { method: string; params: unknown };

export type FakeAcpAgent = {
  /**
   * Builds the AgentApp for one connection. Each call returns a fresh app so
   * per-connection state (auth, cancellation) behaves like a new process.
   */
  app: () => AgentApp;
  /** In-process connector usable as `createEngine(ENGINES.x, { connector })`. */
  connector: FakeAcpConnector;
  /** Every request and notification received, across all connections. */
  calls: FakeAcpCall[];
  /** How many connections have been opened so far. */
  connections: number;
};

/**
 * Structural match for `AcpConnector` from `@sunset/acp`, redeclared here so
 * the harness does not need a runtime dependency on it.
 */
export type FakeAcpConnector = (input: {
  cwd: string;
  onUpdate: (sessionId: string, update: SessionUpdate) => void;
  onPermission: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  onClose: (error: unknown) => void;
}) => Promise<{
  request: ClientContext["request"];
  notify: ClientContext["notify"];
  close: () => void;
}>;

const authError = (): RequestError =>
  RequestError.authRequired(undefined, "not authenticated");

// Plain Error messages do not cross the JSON-RPC boundary — the client only
// sees "Internal error". Wrap them so configured failure messages survive.
const asRpcError = (error: Error): RequestError =>
  error instanceof RequestError
    ? error
    : RequestError.internalError(undefined, error.message);

export function fakeAcpAgent(options: FakeAcpAgentOptions = {}): FakeAcpAgent {
  const calls: FakeAcpCall[] = [];
  const fake: FakeAcpAgent = {
    app: build,
    connector: inProcessConnector(build),
    calls,
    connections: 0,
  };

  const skipped = (method: string): boolean =>
    options.methodNotFound?.includes(method) ?? false;

  function build(): AgentApp {
    const app = acpAgent({ name: options.name ?? "fake-acp" });
    const conn = {
      ref: null as AgentConnection | null,
      authenticated: false,
      authenticateCalls: 0,
      exited: false,
      cancelled: new Set<string>(),
      cancelWaiters: new Map<string, Array<() => void>>(),
    };
    app.onConnect((connection) => {
      conn.ref = connection;
      fake.connections += 1;
    });

    const record = (method: string, params: unknown): void => {
      calls.push({ method, params });
    };
    // Answer only when the connection drops, so hung requests release cleanly
    // instead of leaving a pending promise behind after a test.
    const hang = (signal: AbortSignal): Promise<never> =>
      new Promise((resolve) => {
        if (signal.aborted) resolve(undefined as never);
        else
          signal.addEventListener("abort", () => resolve(undefined as never), {
            once: true,
          });
      });
    const hanging = (method: string): boolean =>
      conn.exited || (options.hangOn?.includes(method) ?? false);
    // Mark the connection dead synchronously so later requests stall, then
    // close the transport on the next tick so in-flight writes flush first.
    const exitNow = (): void => {
      conn.exited = true;
      setTimeout(() => conn.ref?.close(new Error("fake_agent_exited")), 0);
    };
    const maybeExit = (method: string): void => {
      if (options.exitAfter === method) exitNow();
    };
    const requireAuth = (): void => {
      if (options.requireAuth && !conn.authenticated) throw authError();
    };
    const failIf = (failure?: FakeAcpLoadFailure): void => {
      if (!failure?.error) return;
      throw failure.error === "auth" ? authError() : asRpcError(failure.error);
    };
    const waitForCancel = (
      sessionId: string,
      signal: AbortSignal,
    ): Promise<void> =>
      new Promise((resolve) => {
        if (conn.cancelled.has(sessionId)) return resolve();
        const waiters = conn.cancelWaiters.get(sessionId) ?? [];
        waiters.push(resolve);
        conn.cancelWaiters.set(sessionId, waiters);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });

    if (!skipped("initialize")) {
      app.onRequest("initialize", (ctx) => {
        record("initialize", ctx.params);
        if (hanging("initialize")) return hang(ctx.signal);
        maybeExit("initialize");
        return {
          protocolVersion: options.protocolVersion ?? 1,
          agentCapabilities: options.agentCapabilities ?? {},
          authMethods: options.authMethods ?? [],
        };
      });
    }

    if (!skipped("authenticate")) {
      app.onRequest("authenticate", (ctx) => {
        record("authenticate", ctx.params);
        if (hanging("authenticate")) return hang(ctx.signal);
        conn.authenticateCalls += 1;
        const required = options.authenticate?.methodId;
        if (required && ctx.params.methodId !== required) {
          throw RequestError.invalidParams(
            ctx.params,
            `unknown auth method: ${ctx.params.methodId}`,
          );
        }
        if (conn.authenticateCalls <= (options.authenticate?.failTimes ?? 0)) {
          const failure = options.authenticate?.error;
          throw failure ? asRpcError(failure) : authError();
        }
        conn.authenticated = true;
        maybeExit("authenticate");
        return {};
      });
    }

    if (!skipped("session/new")) {
      app.onRequest("session/new", (ctx) => {
        record("session/new", ctx.params);
        if (hanging("session/new")) return hang(ctx.signal);
        requireAuth();
        maybeExit("session/new");
        return {
          sessionId: options.sessionId ?? "fake-session-1",
          ...(options.modes !== undefined ? { modes: options.modes } : {}),
          ...(options.models ? { models: options.models } : {}),
        } as NewSessionResponse;
      });
    }

    if (!skipped("session/resume")) {
      app.onRequest("session/resume", (ctx) => {
        record("session/resume", ctx.params);
        if (hanging("session/resume")) return hang(ctx.signal);
        requireAuth();
        failIf(options.resume);
        maybeExit("session/resume");
        return {};
      });
    }

    if (!skipped("session/load")) {
      app.onRequest("session/load", (ctx) => {
        record("session/load", ctx.params);
        if (hanging("session/load")) return hang(ctx.signal);
        requireAuth();
        failIf(options.load);
        maybeExit("session/load");
        return {};
      });
    }

    if (!skipped("session/set_mode")) {
      app.onRequest("session/set_mode", (ctx) => {
        record("session/set_mode", ctx.params);
        if (hanging("session/set_mode")) return hang(ctx.signal);
        maybeExit("session/set_mode");
        return {};
      });
    }

    // Not a schema method in this SDK version; register with a passthrough
    // params parser so the codex-style set_model flow can be exercised.
    if (!skipped("session/set_model")) {
      app.onRequest(
        "session/set_model",
        (params) => params as { sessionId: string; modelId: string },
        (ctx) => {
          record("session/set_model", ctx.params);
          if (hanging("session/set_model")) return hang(ctx.signal);
          maybeExit("session/set_model");
          return {};
        },
      );
    }

    if (!skipped("session/prompt")) {
      app.onRequest("session/prompt", async (ctx) => {
        record("session/prompt", ctx.params);
        if (hanging("session/prompt")) return hang(ctx.signal);
        requireAuth();
        const { sessionId } = ctx.params;
        const script: SessionUpdate[] = options.prompt?.updates ?? [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "fake response" },
          },
        ];
        for (const [index, update] of script.entries()) {
          if (conn.cancelled.has(sessionId)) {
            return { stopReason: "cancelled" };
          }
          await ctx.client.notify("session/update", { sessionId, update });
          if (options.exitAfter === index + 1) {
            // Mid-run disconnect: the emitted update flushes on the next
            // tick, then the transport drops; hold the handler open until the
            // abort lands so no prompt response is ever sent.
            exitNow();
            return hang(ctx.signal);
          }
        }
        if (options.prompt?.waitForCancel) {
          await waitForCancel(sessionId, ctx.signal);
          maybeExit("session/prompt");
          return { stopReason: "cancelled" };
        }
        if (options.prompt?.error) throw asRpcError(options.prompt.error);
        maybeExit("session/prompt");
        return { stopReason: options.prompt?.stopReason ?? "end_turn" };
      });
    }

    if (!skipped("session/cancel")) {
      app.onNotification("session/cancel", (ctx) => {
        record("session/cancel", ctx.params);
        conn.cancelled.add(ctx.params.sessionId);
        for (const wake of conn.cancelWaiters.get(ctx.params.sessionId) ?? []) {
          wake();
        }
        conn.cancelWaiters.delete(ctx.params.sessionId);
        maybeExit("session/cancel");
      });
    }

    return app;
  }

  return fake;
}

/** Mirrors the in-process connector used by `runtime.test.ts`. */
export function inProcessConnector(build: () => AgentApp): FakeAcpConnector {
  return async ({ onUpdate, onPermission, onClose }) => {
    const app = acpClient({ name: "sunset-test" });
    app.onNotification("session/update", (ctx) => {
      onUpdate(ctx.params.sessionId, ctx.params.update);
    });
    app.onRequest("session/request_permission", (ctx) =>
      onPermission(ctx.params),
    );
    const conn = app.connect(build());
    conn.closed.then(
      () => onClose(null),
      () => onClose(null),
    );
    return {
      request: conn.agent.request.bind(conn.agent),
      notify: conn.agent.notify.bind(conn.agent),
      close: () => conn.close(),
    };
  };
}
