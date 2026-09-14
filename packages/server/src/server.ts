import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { isSunsetBoundaryError, type Host } from "@sunset/host";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const MAX_BODY_BYTES = 1024 * 1024;

const ALLOWED_ORIGIN_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

class PayloadTooLargeError extends Error {
  constructor() {
    super("request body exceeds 1 MiB");
    this.name = "PayloadTooLargeError";
  }
}

type LogEntry = {
  level: "info" | "error";
  msg: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  err?: string;
};

export type SunsetServerOptions = {
  host: Host;
  webDist?: string;
  token?: string;
  port?: number;
};

export type SunsetServer = {
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof PayloadTooLargeError) {
    json(response, 413, {
      error: { code: "payload_too_large", message: error.message },
    });
    return;
  }
  if (isSunsetBoundaryError(error)) {
    json(response, 400, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  json(response, 500, {
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : "internal error",
    },
  });
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return ALLOWED_ORIGIN_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => ws.terminate(), 1000);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close();
  });
}

async function serveStatic(
  webDist: string,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const resolved = path.resolve(webDist, `.${pathname}`);
  if (!resolved.startsWith(path.resolve(webDist))) {
    json(response, 403, { error: { code: "forbidden", message: "forbidden" } });
    return;
  }
  let file = resolved;
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) {
    file = path.join(webDist, "index.html");
    if (!(await stat(file).catch(() => null))?.isFile()) {
      json(response, 404, {
        error: { code: "not_found", message: "web app is not built" },
      });
      return;
    }
  }
  const content = await readFile(file);
  response.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
  });
  response.end(content);
}

export async function createSunsetServer(
  options: SunsetServerOptions,
): Promise<SunsetServer> {
  const { host } = options;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const webDist = options.webDist;

  function authorized(request: IncomingMessage, url: URL): boolean {
    const header = request.headers.authorization;
    if (header === `Bearer ${token}`) return true;
    return url.searchParams.get("token") === token;
  }

  const logPath = process.env.SUNSET_LOG;
  let logTail: Promise<void> = Promise.resolve();
  function log(entry: LogEntry): void {
    if (!logPath) return;
    const serialized = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    });
    const line = `${token ? serialized.split(token).join("[redacted]") : serialized}\n`;
    logTail = logTail.then(() => appendFile(logPath, line)).catch(() => {});
  }

  const inflight = new Set<Promise<void>>();
  const server: Server = createHttpServer((request, response) => {
    const startedAt = Date.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const pending = handleRequest(request, response, url).catch(
      (error: unknown) => {
        if (!(error instanceof PayloadTooLargeError)) {
          log({
            level: "error",
            msg: "handler_error",
            method,
            path: url.pathname,
            err: errorMessage(error),
          });
        }
        fail(response, error);
      },
    );
    inflight.add(pending);
    void pending.finally(() => {
      inflight.delete(pending);
      log({
        level: "info",
        msg: "request",
        method,
        path: url.pathname,
        status: response.statusCode,
        ms: Date.now() - startedAt,
      });
    });
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;
    const method = request.method ?? "GET";

    if (pathname.startsWith("/api/")) {
      if (!authorized(request, url)) {
        json(response, 401, {
          error: { code: "unauthorized", message: "invalid boot token" },
        });
        return;
      }
      const input = method === "POST" ? fields(await body(request)) : {};
      const parts = pathname.split("/").filter(Boolean).slice(1);
      await route(method, parts, input, response);
      return;
    }

    if (webDist && method === "GET") {
      await serveStatic(webDist, pathname, response);
      return;
    }
    json(response, 404, { error: { code: "not_found", message: "not found" } });
  }

  async function route(
    method: string,
    parts: string[],
    input: Record<string, unknown>,
    response: ServerResponse,
  ): Promise<void> {
    if (method === "GET" && parts[0] === "capabilities") {
      json(response, 200, await host.capabilities());
      return;
    }
    if (parts[0] === "projects") {
      if (method === "GET" && parts.length === 1) {
        json(response, 200, { projects: host.projects.list() });
        return;
      }
      if (method === "POST" && parts.length === 1) {
        const repoRoot = stringField(input.repoRoot);
        if (!repoRoot) throw new Error("repoRoot is required");
        json(response, 200, await host.projects.register(repoRoot));
        return;
      }
      if (parts[1] && parts[2] === "workspaces") {
        if (method === "GET") {
          json(response, 200, {
            workspaces: host.workspaces.list({
              projectId: parts[1],
              includeArchived: input.includeArchived === true,
            }),
          });
          return;
        }
        if (method === "POST") {
          const slug = stringField(input.slug);
          if (!slug) throw new Error("slug is required");
          json(
            response,
            200,
            await host.workspaces.create({
              projectId: parts[1],
              slug,
              branch: stringField(input.branch),
              baseRef: stringField(input.baseRef),
              copyGlobs: Array.isArray(input.copyGlobs)
                ? input.copyGlobs.filter(
                    (value): value is string => typeof value === "string",
                  )
                : undefined,
            }),
          );
          return;
        }
      }
      if (parts[1] && parts[2] === "reconcile" && method === "GET") {
        json(
          response,
          200,
          await host.projects.reconcile({ projectId: parts[1] }),
        );
        return;
      }
    }
    if (parts[0] === "workspaces" && parts[1]) {
      if (method === "GET" && parts.length === 2) {
        json(response, 200, host.workspaces.get(parts[1]) ?? null);
        return;
      }
      if (parts[2] === "archive" && method === "POST") {
        json(
          response,
          200,
          await host.workspaces.archive({
            workspaceId: parts[1],
            keepBranch: input.keepBranch !== false,
          }),
        );
        return;
      }
      if (parts[2] === "sessions") {
        if (method === "GET") {
          json(response, 200, {
            sessions: host.sessions.list({ workspaceId: parts[1] }),
          });
          return;
        }
        if (method === "POST") {
          const prompt = stringField(input.prompt);
          if (!prompt) throw new Error("prompt is required");
          const engine = stringField(input.engine);
          const location = stringField(input.location);
          const mode = stringField(input.mode);
          const model = fields(input.model);
          json(
            response,
            200,
            await host.sessions.create({
              workspaceId: parts[1],
              ...(engine ? { engine: engine as "devin" | "codex" } : {}),
              ...(location ? { location: location as "local" | "cloud" } : {}),
              ...(mode ? { mode: mode as "agent" | "plan" } : {}),
              ...(model.id
                ? {
                    model: {
                      id: model.id as string,
                      params: Array.isArray(model.params)
                        ? (model.params as { id: string; value: string }[])
                        : [],
                    },
                  }
                : {}),
              prompt,
              ...(fields(input.executionPolicy) && input.executionPolicy
                ? {
                    executionPolicy: input.executionPolicy as Parameters<
                      Host["sessions"]["create"]
                    >[0]["executionPolicy"],
                  }
                : {}),
            }),
          );
          return;
        }
      }
    }
    if (parts[0] === "sessions" && parts[1]) {
      if (parts[2] === "runs") {
        if (method === "GET") {
          json(response, 200, {
            runs: host.runs.list({ sessionId: parts[1] }),
          });
          return;
        }
        if (method === "POST") {
          const prompt = stringField(input.prompt);
          if (!prompt) throw new Error("prompt is required");
          json(
            response,
            200,
            await host.sessions.send({ sessionId: parts[1], prompt }),
          );
          return;
        }
      }
    }
    if (parts[0] === "runs" && parts[1]) {
      if (method === "GET" && parts.length === 2) {
        json(response, 200, host.runs.get(parts[1]) ?? null);
        return;
      }
      if (parts[2] === "cancel" && method === "POST") {
        json(response, 200, await host.runs.cancel({ runId: parts[1] }));
        return;
      }
      if (parts[2] === "wait" && method === "GET") {
        json(response, 200, await host.runs.wait({ runId: parts[1] }));
        return;
      }
    }
    if (parts[0] === "diagnostics" && parts[1] === "operations") {
      if (method === "GET" && parts.length === 2) {
        json(response, 200, { operations: host.diagnostics.operations.list() });
        return;
      }
    }
    json(response, 404, { error: { code: "not_found", message: "not found" } });
  }

  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!authorized(request, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!originAllowed(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const match = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      const connectedAt = Date.now();
      log({ level: "info", msg: "ws_connect", path: url.pathname });
      ws.on("close", () => {
        sockets.delete(ws);
        log({
          level: "info",
          msg: "ws_disconnect",
          path: url.pathname,
          ms: Date.now() - connectedAt,
        });
      });
      const runId = match[1]!;
      const after = Number(url.searchParams.get("after") ?? "0");
      const controller = new AbortController();
      ws.on("close", () => controller.abort());
      void (async () => {
        try {
          for await (const event of host.runs.attach({
            runId,
            afterSequence:
              Number.isSafeInteger(after) && after >= 0 ? after : 0,
            signal: controller.signal,
          })) {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify(event));
          }
        } catch (error) {
          log({
            level: "error",
            msg: "ws_error",
            path: url.pathname,
            err: errorMessage(error),
          });
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  error instanceof Error ? error.message : "stream failed",
              }),
            );
          }
        } finally {
          if (ws.readyState === ws.OPEN) ws.close();
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;

  let closing: Promise<void> | undefined;

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    close() {
      if (!closing) {
        closing = (async () => {
          const httpClosed = new Promise<void>((resolve) =>
            server.close(() => resolve()),
          );
          wss.close();
          await Promise.allSettled([...sockets].map(closeSocket));
          await Promise.allSettled([...inflight]);
          await httpClosed;
          await new Promise<void>((resolve) => setImmediate(resolve));
          await logTail;
        })();
      }
      return closing;
    },
  };
}
