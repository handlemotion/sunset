/**
 * Cloud engine worker — the dormant cloud boundary for Sunset's ACP runtime.
 *
 * Sunset is local-first: the local host spawns ACP CLIs directly, and this
 * worker exists only so that the cloud seam can be turned on deliberately
 * later. The capability below is gated behind `SUNSET_ENGINE_ENABLED`; until
 * then every request except `/healthz` returns 501 and nothing provisions a
 * Box. See docs/workstreams/cloud-engine.md.
 *
 * When enabled, `GET /v1/session` (WebSocket upgrade, bearer auth) bridges one
 * caller to one ephemeral Upstash Box running `devin acp` or `codex-acp` via
 * the Box exec-session WebSocket. Auth and input validation happen before any
 * Box is allocated; publication credentials never enter the sandbox.
 */
import {
  engineSessionDeps,
  engineSessionGate,
  handleEngineSession,
  type EngineEnv,
} from "./session.js";

const json = (body: Record<string, unknown>, status = 200): Response =>
  Response.json(body, { status });

type Env = EngineEnv;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({ ok: true, engine: "dormant" });
    }

    const rejection = engineSessionGate({
      enabled: env.SUNSET_ENGINE_ENABLED === "true",
      path: url.pathname,
      upgrade: request.headers.get("upgrade"),
      authorization: request.headers.get("authorization"),
      token: env.SUNSET_ENGINE_TOKEN,
    });
    if (rejection) return rejection;

    // Both sides must refer to the same socket; response.webSocket is the
    // caller-facing end and stays open for the life of the bridge.
    const pair = new WebSocketPair();
    const [caller, worker] = Object.values(pair) as [WebSocket, WebSocket];
    worker.accept();
    try {
      ctx.waitUntil(
        handleEngineSession(
          worker,
          engineSessionDeps(env, (work) => ctx.waitUntil(work)),
        ).catch(() => {
          worker.close(1011, "engine_unavailable");
        }),
      );
    } catch (error) {
      worker.close(1011, "engine_unavailable");
      return new Response(null, {
        status: 503,
        statusText:
          error instanceof Error ? error.message : "engine_unavailable",
      });
    }
    return new Response(null, { status: 101, webSocket: caller });
  },
};
