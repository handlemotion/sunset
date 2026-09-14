import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  client as acpClient,
  ndJsonStream,
  type ClientContext,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import { trackEngineGroup } from "./supervision.js";

export type UpdateHandler = (
  sessionId: string,
  update: SessionNotification["update"],
) => void;
export type PermissionHandler = (
  params: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

export type SpawnedProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill: () => void;
  exited: Promise<void>;
};

export type SpawnFn = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  engineGroupDir?: string;
}) => SpawnedProcess;

export function nodeSpawn(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  engineGroupDir?: string;
}): SpawnedProcess {
  const child: ChildProcess = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    // New process group so kill() can signal the whole tree — engines like
    // `devin acp` spawn MCP-server children that would otherwise outlive the
    // agent process.
    detached: process.platform !== "win32",
  });
  if (!child.stdin || !child.stdout) {
    child.kill("SIGKILL");
    throw new Error("spawn_stdio_unavailable");
  }
  const untrack =
    process.platform !== "win32" &&
    input.engineGroupDir !== undefined &&
    child.pid !== undefined
      ? trackEngineGroup(input.engineGroupDir, child.pid)
      : undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      untrack?.();
      resolve();
    });
    child.once("error", () => {
      untrack?.();
      resolve();
    });
  });
  const kill = (): void => {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      child.kill("SIGKILL");
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    ...(child.stderr ? { stderr: child.stderr } : {}),
    kill,
    exited,
  };
}

export type AcpConnectionHandle = {
  request: ClientContext["request"];
  notify: ClientContext["notify"];
  close: () => void;
};

/**
 * A transport to one ACP agent. The default spawns a stdio child; tests inject
 * an in-process agent.
 */
export type AcpConnector = (input: {
  cwd: string;
  onUpdate: UpdateHandler;
  onPermission: PermissionHandler;
  onClose: (error: unknown) => void;
}) => Promise<AcpConnectionHandle>;

export function stdioConnector(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  engineGroupDir?: string;
  spawn?: SpawnFn;
}): AcpConnector {
  return async ({ cwd, onUpdate, onPermission, onClose }) => {
    const spawnFn = input.spawn ?? nodeSpawn;
    const proc = spawnFn({
      command: input.command,
      args: input.args,
      cwd,
      env: {
        ...process.env,
        ...input.env,
        SUNSET_HOST_PID: String(process.pid),
      },
      ...(input.engineGroupDir ? { engineGroupDir: input.engineGroupDir } : {}),
    });
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    // Agents log heavily on stderr; the pipe must be drained or the child
    // blocks once the buffer fills.
    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
    });
    const app = acpClient({ name: "sunset" });
    app.onNotification("session/update", (ctx) => {
      const params = ctx.params as SessionNotification;
      onUpdate(params.sessionId, params.update);
    });
    app.onRequest("session/request_permission", (ctx) =>
      onPermission(ctx.params as RequestPermissionRequest),
    );
    const conn: ClientConnection = app.connect(stream);
    void proc.exited.then(() => {
      const suffix = stderrTail.trim()
        ? `: ${stderrTail.trim().split("\n").pop()}`
        : "";
      conn.close(new Error(`agent_process_exited${suffix}`));
    });
    conn.closed.then(
      () => {
        proc.kill();
        onClose(null);
      },
      () => {
        proc.kill();
        onClose(null);
      },
    );
    return {
      request: conn.agent.request.bind(conn.agent),
      notify: conn.agent.notify.bind(conn.agent),
      close: () => conn.close(),
    };
  };
}
