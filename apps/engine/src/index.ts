/**
 * Sunset cloud engine — DORMANT.
 *
 * This Worker is the future cloud execution boundary: it will own Upstash Box
 * supervision (@sunset/box), cloud ACP bridging, and draft-PR publication
 * (@sunset/publish) behind explicit activation gates. Nothing here is wired to
 * the local host yet; every route returns 501 until the engine is designed,
 * reviewed, and commissioned.
 */

export type EngineEnv = {
  UPSTASH_BOX_API_KEY?: string;
  SUNSET_BOX_NAME?: string;
  GITHUB_REPOSITORY_READ_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  SUNSET_ENGINE_ENABLED?: string;
};

function dormant(): Response {
  return Response.json(
    {
      error: {
        code: "engine_dormant",
        message:
          "the Sunset cloud engine is not enabled; run agents locally for now",
      },
    },
    { status: 501 },
  );
}

export default {
  async fetch(request: Request, env: EngineEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, engine: "dormant" });
    }
    if (env.SUNSET_ENGINE_ENABLED !== "true") return dormant();
    // Activation is intentionally unreachable until commissioning gates land.
    return dormant();
  },
};
