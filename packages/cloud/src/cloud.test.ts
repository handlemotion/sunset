/**
 * Contract tests for the cloud engine seam. A fake in-process ACP agent runs
 * behind the real bridge: caller `ws` socket → `handleEngineSession` (the
 * worker code path, unmodified) → `openBoxExecSession` over a local
 * WebSocket speaking the Box exec-session protocol → spawned fake agent.
 * The real CLOUD_ENGINE_SPAWNS specs are used: the fake box fakes
 * provisioning by intercepting the fixed bootstrap argv and translating the
 * fixed agent spawn into `node fake-agent.mjs`.
 *
 * No Upstash or other external network calls: global fetch is stubbed to
 * throw (except where a test installs its own fake), and every socket is
 * loopback.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  cfWebSocketUpgrade,
  openBoxExecSession,
  type BoxExecSession,
  type BoxSocket,
  type BoxSocketOpen,
} from "@sunset/box";
import { createEngine, ENGINES, stdioConnector } from "@sunset/acp";
import type { ModelSelection } from "@sunset/domain";
import {
  cloudConnector,
  createCloudEngine,
  wsSocketOpen,
  type CloudEngineOptions,
} from "./index.js";
import worker from "../../../apps/engine/src/index";
import {
  CLOUD_ENGINE_SPAWNS,
  engineSessionGate,
  handleEngineSession,
  type EngineBox,
  type EngineSessionDeps,
  type EngineSocket,
} from "../../../apps/engine/src/session";

const AGENT = fileURLToPath(new URL("../test/fake-agent.mjs", import.meta.url));
const TOKEN = "test-token";
const throwingFetch = (): Promise<never> =>
  Promise.reject(new Error("unexpected_network_call"));

beforeAll(() => {
  vi.stubGlobal("fetch", throwingFetch);
});
afterEach(() => {
  vi.stubGlobal("fetch", throwingFetch);
});

const wsBoxOpen: BoxSocketOpen = ({ url, headers }) =>
  new Promise<BoxSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket as unknown as BoxSocket));
    socket.once("error", reject);
  });

type StartFrame = { argv: string[]; cwd?: string; env?: string[] };
type BoxMode =
  | "normal"
  | "close-on-start"
  | "bad-stdout"
  | "hang-bootstrap"
  | "exit-before-start";

/**
 * Local WebSocket server speaking the Box exec-session protocol. It never
 * runs the worker's bootstrap or real agent argv: the fixed `sunset-bootstrap`
 * script gets a fake success, and the fixed `sunset-devin`/npx spawns are
 * translated to the fake agent — fake provisioning for the contract.
 */
function startFakeBox(options?: {
  agentFlags?: string[];
  mode?: BoxMode;
}): Promise<{
  port: number;
  startFrames: StartFrame[];
  stderrLog: () => string;
  closedSockets: () => number;
  procs: Set<ChildProcess>;
  close: () => Promise<void>;
}> {
  const agentFlags = options?.agentFlags ?? [];
  return new Promise((resolve) => {
    const startFrames: StartFrame[] = [];
    const procs = new Set<ChildProcess>();
    const clients = new Set<WebSocket>();
    const stderrChunks: string[] = [];
    let closedCount = 0;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (sock) => {
      clients.add(sock);
      sock.on("close", () => {
        clients.delete(sock);
        closedCount += 1;
      });
      let proc: ChildProcess | undefined;
      let badFrameSent = false;
      const send = (frame: Record<string, unknown>): void => {
        if (sock.readyState === WebSocket.OPEN)
          sock.send(JSON.stringify(frame));
      };
      sock.on("message", (raw) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (frame.type === "start") {
          if (proc) return;
          const argv = frame.argv as string[];
          startFrames.push({
            argv,
            ...(typeof frame.cwd === "string" ? { cwd: frame.cwd } : {}),
            ...(Array.isArray(frame.env) ? { env: frame.env as string[] } : {}),
          });
          if (options?.mode === "close-on-start") {
            sock.close();
            return;
          }
          if (options?.mode === "exit-before-start") {
            send({ type: "exit", code: 3 });
            return;
          }
          // Fake provisioning: the fixed bootstrap script is not executed.
          if (argv.includes("sunset-bootstrap")) {
            send({ type: "started", pid: 4242, execId: "boot" });
            if (options?.mode === "hang-bootstrap") return; // never exits
            send({ type: "exit", code: 0 });
            return;
          }
          // Translate the fixed agent spawns to the fake agent process.
          let realArgv = argv;
          if (argv[0] === "sh" && argv[3] === "sunset-devin") {
            realArgv = [
              process.execPath,
              AGENT,
              ...(typeof argv[4] === "string" ? ["--model", argv[4]] : []),
              ...agentFlags,
            ];
          } else if (argv[0] === "npx") {
            realArgv = [
              process.execPath,
              AGENT,
              "--codex-models",
              ...agentFlags,
            ];
          }
          const env = { ...process.env };
          for (const entry of (frame.env as string[] | undefined) ?? []) {
            const at = entry.indexOf("=");
            if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
          }
          proc = spawn(realArgv[0]!, realArgv.slice(1), {
            cwd: typeof frame.cwd === "string" ? frame.cwd : "/",
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          procs.add(proc);
          proc.stdout?.on("data", (chunk: Buffer) =>
            send({ type: "stdout", data: chunk.toString("base64") }),
          );
          proc.stderr?.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString("utf8"));
            send({ type: "stderr", data: chunk.toString("base64") });
          });
          proc.once("error", () =>
            send({ type: "error", message: "spawn_failed" }),
          );
          proc.once("exit", (code) => {
            procs.delete(proc!);
            send({ type: "exit", code: code ?? -1 });
          });
          send({ type: "started", pid: proc.pid ?? 1, execId: "fake" });
          return;
        }
        if (frame.type === "stdin") {
          if (options?.mode === "bad-stdout" && !badFrameSent) {
            badFrameSent = true;
            send({ type: "stdout", data: "%%%not-base64%%%" });
            return;
          }
          proc?.stdin?.write(Buffer.from(frame.data as string, "base64"));
        } else if (frame.type === "stdin_close") {
          proc?.stdin?.end();
        } else if (frame.type === "signal") {
          proc?.kill(frame.signal === "KILL" ? "SIGKILL" : "SIGTERM");
        }
      });
      sock.on("close", () => proc?.kill("SIGKILL"));
    });
    wss.on("listening", () =>
      resolve({
        port: (wss.address() as AddressInfo).port,
        startFrames,
        stderrLog: () => stderrChunks.join(""),
        closedSockets: () => closedCount,
        procs,
        close: () =>
          new Promise((done) => {
            for (const p of procs) p.kill("SIGKILL");
            for (const c of clients) c.terminate();
            wss.close(() => done());
          }),
      }),
    );
  });
}

function startBridge(deps: EngineSessionDeps): Promise<{
  port: number;
  sessions: Promise<void>[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const clients = new Set<WebSocket>();
    const sessions: Promise<void>[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      sessions.push(
        handleEngineSession(socket as unknown as EngineSocket, deps),
      );
    });
    wss.on("listening", () =>
      resolve({
        port: (wss.address() as AddressInfo).port,
        sessions,
        close: () =>
          new Promise((done) => {
            for (const c of clients) c.terminate();
            wss.close(() => done());
          }),
      }),
    );
  });
}

type World = Awaited<ReturnType<typeof startWorld>>;

async function startWorld(options?: {
  agentFlags?: string[];
  boxMode?: BoxMode;
  engines?: EngineSessionDeps["engines"];
  bootBox?: (
    box: Awaited<ReturnType<typeof startFakeBox>>,
  ) => Promise<EngineBox>;
  deps?: Partial<EngineSessionDeps>;
}): Promise<{
  box: Awaited<ReturnType<typeof startFakeBox>>;
  bridge: Awaited<ReturnType<typeof startBridge>>;
  state: { deleted: boolean; boots: number; lifecycle: Promise<unknown>[] };
  close: () => Promise<void>;
}> {
  const box = await startFakeBox({
    agentFlags: options?.agentFlags,
    ...(options?.boxMode ? { mode: options.boxMode } : {}),
  });
  const state = {
    deleted: false,
    boots: 0,
    lifecycle: [] as Promise<unknown>[],
  };
  const deps: EngineSessionDeps = {
    engines: options?.engines ?? CLOUD_ENGINE_SPAWNS,
    openSocket: wsBoxOpen,
    lifecycle: (work) => void state.lifecycle.push(work),
    bootBox: options?.bootBox
      ? () => options.bootBox!(box)
      : async () => {
          state.boots += 1;
          return {
            id: "fake-box",
            execSession: (input, o) =>
              openBoxExecSession({
                ...input,
                url: `ws://127.0.0.1:${box.port}/exec-session`,
                headers: {},
                open: o?.open ?? wsBoxOpen,
              }),
            delete: async () => {
              state.deleted = true;
            },
          } satisfies EngineBox;
        },
    ...options?.deps,
  };
  const bridge = await startBridge(deps);
  return {
    box,
    bridge,
    state,
    close: async () => {
      await bridge.close();
      await box.close();
    },
  };
}

const cloud = (
  port: number,
  engine: "devin" | "codex" = "devin",
  extra?: Partial<CloudEngineOptions>,
) =>
  createCloudEngine({
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
    engine,
    handshakeTimeoutMs: 15_000,
    ...extra,
  });

const noModel: ModelSelection = { id: "", params: [] };
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Direct connector call against a scripted socket (bypasses the bridge). */
function cloudConnectorForTest(port: number, onUpdate: (u: unknown) => void) {
  return cloudConnector({
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
    engine: "devin",
    handshakeTimeoutMs: 5_000,
  })({
    cwd: "/",
    onUpdate: (_sessionId, update) => onUpdate(update),
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onClose: () => undefined,
  });
}

async function pollUntil(
  check: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("poll_timeout");
    await sleep(25);
  }
}

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});

describe("cloud engine contract", () => {
  it("bootstraps, runs create → prompt → stream → wait → dispose through the real bridge", async () => {
    const world = await startWorld();
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const session = await engine.create({
      cwd: tmpdir(),
      model: { id: "test-model", params: [] },
    });
    expect(session.providerSessionId).toBe("sess-fake");
    const run = await session.send("hello");
    const events: Array<{ type?: string; text?: string }> = [];
    for await (const event of run.stream()) {
      events.push(event as { type?: string; text?: string });
    }
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(result.result).toContain("echo:hello");
    expect(
      events.some(
        (e) => e.type === "text_delta" && e.text?.includes("echo:hello"),
      ),
    ).toBe(true);
    // Bootstrap ran first with the caller cwd positional, then the agent spawn.
    expect(world.box.startFrames).toHaveLength(2);
    expect(world.box.startFrames[0]?.argv).toContain("sunset-bootstrap");
    expect(world.box.startFrames[0]?.argv?.at(-1)).toBe(tmpdir());
    // The model travelled into the remote spawn (echoed by the fake agent).
    expect(result.result).toContain("model:test-model");
    await session.dispose();
    await pollUntil(() => world.state.deleted);
  });

  it("matches stdio engine behavior with the same agent", async () => {
    const world = await startWorld();
    worlds.push(world);
    const cloudEngine = cloud(world.bridge.port);
    const localEngine = createEngine(ENGINES.devin, {
      connector: stdioConnector({
        command: process.execPath,
        args: [AGENT],
      }),
    });
    const cloudSession = await cloudEngine.create({ cwd: "/", model: noModel });
    const localSession = await localEngine.create({
      cwd: tmpdir(),
      model: noModel,
    });
    const [cloudRun, localRun] = await Promise.all([
      cloudSession.send("ping"),
      localSession.send("ping"),
    ]);
    const [cloudResult, localResult] = await Promise.all([
      cloudRun.wait(),
      localRun.wait(),
    ]);
    expect(cloudResult.status).toBe(localResult.status);
    expect(cloudResult.result).toBe(localResult.result);
    await Promise.all([cloudSession.dispose(), localSession.dispose()]);
  });

  it("runs the codex engine spec and advertises its modes", async () => {
    const world = await startWorld();
    worlds.push(world);
    const engine = cloud(world.bridge.port, "codex");
    expect(engine.supportedModes()).toEqual(["agent", "plan"]);
    const session = await engine.create({ cwd: "/", model: noModel });
    const run = await session.send("hi");
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(result.result).toContain("echo:hi");
    // Codex spawn is the pinned npx package; the bootstrap ran first.
    expect(world.box.startFrames[0]?.argv).toContain("sunset-bootstrap");
    expect(world.box.startFrames[1]?.argv?.slice(0, 3)).toEqual([
      "npx",
      "-y",
      "@agentclientprotocol/codex-acp@1.11.0",
    ]);
    await session.dispose();
  });

  it("delivers a final response queued with the exit frame", async () => {
    const world = await startWorld({ agentFlags: ["--exit-after-prompt"] });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const session = await engine.create({ cwd: "/", model: noModel });
    const run = await session.send("last");
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(result.result).toContain("echo:last");
    await pollUntil(() => world.state.deleted);
  });

  it("settles a dropped socket without unhandled rejection when wait is delayed", async () => {
    const world = await startWorld({
      agentFlags: ["--prompt-delay=2000"],
    });
    worlds.push(world);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let captured: WebSocket | undefined;
      const engine = cloud(world.bridge.port, "devin", {
        openSocket: async (input) => {
          const socket = await wsSocketOpen(input);
          captured = socket as unknown as WebSocket;
          return socket;
        },
      });
      const session = await engine.create({ cwd: "/", model: noModel });
      const run = await session.send("hi");
      captured!.terminate();
      // Fully drain the stream first, then wait — the eager wait wrapper
      // keeps the prompt rejection observed even though wait() attaches late.
      const events = [];
      for await (const event of run.stream()) events.push(event);
      await sleep(150);
      const result = await run.wait();
      expect(result.status).toBe("error");
      await pollUntil(() => world.state.deleted);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("settles the run with status error when the agent dies mid-turn", async () => {
    const world = await startWorld({
      agentFlags: ["--crash-on-prompt"],
    });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const session = await engine.create({ cwd: "/", model: noModel });
    const run = await session.send("die");
    const result = await run.wait();
    expect(result.status).toBe("error");
    await pollUntil(() => world.state.deleted);
  });

  it("rejects unauthorized requests before allocating a box", async () => {
    const ctx = { waitUntil: () => undefined };
    const env = { SUNSET_ENGINE_ENABLED: "true", SUNSET_ENGINE_TOKEN: TOKEN };
    const unauthorized = await worker.fetch(
      new Request("http://engine.test/v1/session", {
        headers: { upgrade: "websocket" },
      }),
      env,
      ctx,
    );
    expect(unauthorized.status).toBe(401);
    const wrong = await worker.fetch(
      new Request("http://engine.test/v1/session", {
        headers: { upgrade: "websocket", authorization: "Bearer wrong" },
      }),
      env,
      ctx,
    );
    expect(wrong.status).toBe(401);
    expect(
      engineSessionGate({
        enabled: true,
        path: "/v1/session",
        upgrade: "websocket",
        authorization: `Bearer ${TOKEN}`,
        token: TOKEN,
      }),
    ).toBeNull();
  });

  it("stays dormant when the gate is disabled", async () => {
    const res = await worker.fetch(
      new Request("http://engine.test/v1/session", {
        headers: { upgrade: "websocket", authorization: `Bearer ${TOKEN}` },
      }),
      { SUNSET_ENGINE_TOKEN: TOKEN },
      { waitUntil: () => undefined },
    );
    expect(res.status).toBe(501);
    const health = await worker.fetch(
      new Request("http://engine.test/healthz"),
      {},
      { waitUntil: () => undefined },
    );
    expect(health.status).toBe(200);
  });

  it("rejects unknown engines before allocating a box", async () => {
    const world = await startWorld();
    worlds.push(world);
    const socket = new WebSocket(`ws://127.0.0.1:${world.bridge.port}`);
    await new Promise((resolve) => socket.once("open", resolve));
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(String(data)));
    socket.send(
      JSON.stringify({ type: "sunset.connect", engine: "evil", cwd: "/" }),
    );
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    expect(await closed).toBe(1008);
    expect(frames.some((f) => f.includes("unsupported_engine"))).toBe(true);
    expect(world.state.boots).toBe(0);
  });

  it("cleans up the box when the caller disconnects after ready", async () => {
    const world = await startWorld();
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const session = await engine.create({ cwd: "/", model: noModel });
    await session.dispose();
    await pollUntil(() => world.state.deleted);
    // The delete ran through the injected lifecycle hook (ctx.waitUntil).
    expect(world.state.lifecycle.length).toBeGreaterThan(0);
    await Promise.all(world.state.lifecycle);
  });

  it("cleans up when forwarding a queued caller frame fails", async () => {
    const messages: Array<(event: { data?: unknown }) => void> = [];
    let closed = false;
    const caller = {
      send: () => undefined,
      close: () => {
        closed = true;
      },
      addEventListener: (
        type: "message" | "close" | "error",
        listener: unknown,
      ) => {
        if (type === "message")
          messages.push(listener as (event: { data?: unknown }) => void);
      },
    } as unknown as EngineSocket;
    const emit = (data: string): void => {
      for (const listener of messages) listener({ data });
    };
    const stream = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>();
    const session = (write: BoxExecSession["write"]): BoxExecSession => ({
      pid: 1,
      execId: "test",
      stdout: stream(),
      stderr: stream(),
      exited: Promise.resolve(0),
      write,
      endStdin: () => undefined,
      kill: () => undefined,
      close: () => undefined,
    });
    const lifecycle: Promise<unknown>[] = [];
    const sessions = [
      session(() => undefined),
      session(() => {
        throw new Error("box_socket_send_failed");
      }),
    ];
    let deleted = false;
    const handled = handleEngineSession(caller, {
      engines: {
        test: { bootstrapArgv: () => ["sh"], argv: () => ["agent"] },
      },
      bootBox: async () => ({
        id: "test-box",
        execSession: async () => sessions.shift()!,
        delete: async () => {
          deleted = true;
        },
      }),
      lifecycle: (work) => lifecycle.push(work),
    });

    emit(JSON.stringify({ type: "sunset.connect", engine: "test", cwd: "/" }));
    emit(JSON.stringify({ jsonrpc: "2.0", method: "queued", id: 1 }));
    await handled;
    await Promise.all(lifecycle);

    expect(closed).toBe(true);
    expect(deleted).toBe(true);
  });

  it("releases a late-acquired box when the caller closes during boot", async () => {
    const world = await startWorld({
      bootBox: () =>
        sleep(200).then(async () => {
          world!.state.boots += 1;
          return {
            id: "late-box",
            execSession: () => Promise.reject(new Error("unreached")),
            delete: async () => {
              world!.state.deleted = true;
            },
          } satisfies EngineBox;
        }),
    });
    worlds.push(world);
    const socket = new WebSocket(`ws://127.0.0.1:${world.bridge.port}`);
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({ type: "sunset.connect", engine: "devin", cwd: "/" }),
    );
    socket.close();
    // The bridge handler resolves rather than hanging, and the box that
    // finishes booting after the close is still deleted.
    await pollUntil(() => world.bridge.sessions.length > 0);
    await world.bridge.sessions[0]!;
    await pollUntil(() => world.state.deleted);
  });

  it("rejects promptly when the exec-session socket closes before started", async () => {
    const world = await startWorld({ boxMode: "close-on-start" });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    await expect(engine.create({ cwd: "/", model: noModel })).rejects.toThrow(
      /start_failed|socket_closed|closed/,
    );
    await pollUntil(() => world.state.deleted);
  });

  it("bounds a stalled box upgrade and still deletes the box", async () => {
    const world = await startWorld({
      deps: {
        startupTimeoutMs: 300,
        openSocket: () => new Promise<BoxSocket>(() => undefined),
      },
    });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    await expect(engine.create({ cwd: "/", model: noModel })).rejects.toThrow();
    await pollUntil(() => world.state.deleted);
  });

  it("fails create when the agent exits during setup", async () => {
    const world = await startWorld({ agentFlags: ["--fail-init"] });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    await expect(engine.create({ cwd: "/", model: noModel })).rejects.toThrow();
    await pollUntil(() => world.state.deleted);
  });

  it("fails cleanly on malformed exec-session output", async () => {
    const world = await startWorld({ boxMode: "bad-stdout" });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    await expect(engine.create({ cwd: "/", model: noModel })).rejects.toThrow();
    await pollUntil(() => world.state.deleted);
  });

  it("forwards the provider session id to session/resume on resume", async () => {
    const world = await startWorld();
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const first = await engine.create({ cwd: "/", model: noModel });
    const providerSessionId = first.providerSessionId;
    await first.dispose();
    const resumed = await engine.resume({
      cwd: "/",
      model: noModel,
      providerSessionId,
    });
    const run = await resumed.send("again");
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(world.box.stderrLog()).toContain(
      `saw:session/resume:${providerSessionId}`,
    );
    await resumed.dispose();
  });

  it("fails resume cleanly when the agent has no record of the session", async () => {
    const world = await startWorld({ agentFlags: ["--reject-resume"] });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    await expect(
      engine.resume({
        cwd: "/",
        model: noModel,
        providerSessionId: "sess-gone",
      }),
    ).rejects.toThrow(/session_resume_failed/);
    // The rejected setup still closed the connection and deleted the box.
    await pollUntil(() => world.state.deleted);
  });

  it("reassembles UTF-8 split across stdout frames", async () => {
    const world = await startWorld({
      agentFlags: ["--fragment", "--emoji"],
    });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const session = await engine.create({ cwd: "/", model: noModel });
    const run = await session.send("utf8");
    const result = await run.wait();
    expect(result.status).toBe("finished");
    expect(result.result).toContain("echo:👋:utf8");
    await session.dispose();
  });

  it("bounds inbound frames by UTF-8 bytes, not characters", async () => {
    const world = await startWorld({ deps: { maxFrameBytes: 40 } });
    worlds.push(world);
    const socket = new WebSocket(`ws://127.0.0.1:${world.bridge.port}`);
    await new Promise((resolve) => socket.once("open", resolve));
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(String(data)));
    socket.send(
      JSON.stringify({ type: "sunset.connect", engine: "devin", cwd: "/" }),
    );
    await pollUntil(() => frames.some((f) => f.includes("sunset.ready")));
    // 28 UTF-16 code units but 48 bytes — passes a char check, fails bytes.
    socket.send(JSON.stringify({ x: "👋".repeat(10) }));
    const code = await new Promise<number>((resolve) =>
      socket.once("close", (c) => resolve(c)),
    );
    expect(code).toBe(1009);
    await pollUntil(() => world.state.deleted);
  });

  it("bounds the boot-phase frame queue", async () => {
    const world = await startWorld({
      bootBox: () =>
        new Promise<EngineBox>((resolve) =>
          setTimeout(
            () =>
              resolve({
                id: "slow-box",
                execSession: () => Promise.reject(new Error("unreached")),
                delete: async () => undefined,
              }),
            300,
          ),
        ),
      deps: { maxQueuedFrames: 2 },
    });
    worlds.push(world);
    const socket = new WebSocket(`ws://127.0.0.1:${world.bridge.port}`);
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({ type: "sunset.connect", engine: "devin", cwd: "/" }),
    );
    for (let i = 0; i < 5; i += 1) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "x", id: i }));
    }
    const code = await new Promise<number>((resolve) =>
      socket.once("close", (c) => resolve(c)),
    );
    expect(code).toBe(1009);
  });

  it("closes idle sessions and releases the box", async () => {
    const world = await startWorld({ deps: { idleTimeoutMs: 150 } });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const session = await engine.create({ cwd: "/", model: noModel });
    expect(session.providerSessionId).toBe("sess-fake");
    await pollUntil(() => world.state.deleted);
  });

  it("lists models through a remote probe without a local spawn", async () => {
    const world = await startWorld();
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    const models = await engine.listModels();
    expect(models.some((m) => m.id === "fake-model")).toBe(true);
    // The probe went through the fake box — not a local CLI.
    expect(world.box.startFrames.length).toBeGreaterThan(0);
    expect(
      world.box.startFrames.some((f) => f.argv.includes("sunset-bootstrap")),
    ).toBe(true);
  });

  it("maps codex probe models to round-trippable selections", async () => {
    const world = await startWorld();
    worlds.push(world);
    const engine = cloud(world.bridge.port, "codex");
    const models = await engine.listModels();
    const slug = models.find((m) => m.id === "codex:fake-slug");
    expect(slug).toBeDefined();
    expect(
      slug!.variants.map((v) => v.params.find((p) => p.id === "effort")?.value),
    ).toEqual(["medium", "high"]);
    // A selected variant round-trips to the upstream `slug[effort]` id at
    // session/set_model.
    const session = await engine.create({
      cwd: "/",
      model: {
        id: "codex:fake-slug",
        params: [{ id: "effort", value: "high" }],
      },
    });
    await pollUntil(() =>
      world.box.stderrLog().includes("saw:session/set_model:fake-slug[high]"),
    );
    await session.dispose();
  });

  it("installs the SDK stream synchronously on ready, keeping batched frames", async () => {
    // Scripted worker: envelope → ready + an agent notification + initialize
    // response in the same synchronous burst. A late-installed stream would
    // drop them.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let sawEnvelope = false;
    wss.on("connection", (sock) => {
      sock.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as {
          type?: string;
          id?: number;
          method?: string;
        };
        if (frame.type === "sunset.connect") {
          sawEnvelope = true;
          sock.send(JSON.stringify({ type: "sunset.ready" }));
          sock.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "early" },
                },
              },
            }),
          );
          return;
        }
        if (frame.method === "initialize") {
          sock.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            }),
          );
          sock.close();
          return;
        }
      });
    });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    try {
      const port = (wss.address() as AddressInfo).port;
      const updates: unknown[] = [];
      const conn = await cloudConnectorForTest(port, (u) => updates.push(u));
      expect(sawEnvelope).toBe(true);
      // The batched notification reached the stream instead of being dropped.
      await pollUntil(() => updates.length === 1);
      // The same-batch close settles requests rather than hanging them.
      const outcome = await Promise.race([
        conn.request("initialize", { protocolVersion: 1 }).then(
          () => "ok" as const,
          () => "err" as const,
        ),
        sleep(3_000).then(() => "timeout" as const),
      ]);
      expect(outcome).not.toBe("timeout");
      conn.close();
    } finally {
      await new Promise<void>((done) => wss.close(() => done()));
    }
  });

  it("cfWebSocketUpgrade sends the upgrade header and accepts the socket", async () => {
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    const fakeSocket = {
      accepted: false,
      accept() {
        this.accepted = true;
      },
      send: () => undefined,
      close: () => undefined,
      addEventListener: () => undefined,
    };
    vi.stubGlobal(
      "fetch",
      async (url: string, init?: { headers?: HeadersInit }) => {
        calls.push({ url, headers: init?.headers });
        return { status: 101, webSocket: fakeSocket };
      },
    );
    try {
      const socket = await cfWebSocketUpgrade({
        url: "https://box.example/v2/box/b1/exec-session",
        headers: { "x-box-api-key": "secret-key" },
      });
      expect(socket).toBe(fakeSocket);
      expect(fakeSocket.accepted).toBe(true);
      expect(calls).toHaveLength(1);
      const headers = calls[0]!.headers as Record<string, string>;
      expect(headers.upgrade).toBe("websocket");
      expect(headers["x-box-api-key"]).toBe("secret-key");
    } finally {
      vi.stubGlobal("fetch", throwingFetch);
    }
  });

  it("closes a stuck bootstrap socket when the startup deadline expires", async () => {
    const world = await startWorld({
      boxMode: "hang-bootstrap",
      deps: { startupTimeoutMs: 300 },
      bootBox: async (fakeBox) => ({
        id: "hang-box",
        execSession: (input, o) =>
          openBoxExecSession({
            ...input,
            url: `ws://127.0.0.1:${fakeBox.port}/exec-session`,
            headers: {},
            open: o?.open ?? wsBoxOpen,
          }),
        // Even with deletion failing, the local socket must be closed.
        delete: () => Promise.reject(new Error("delete_failed")),
      }),
    });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    await expect(engine.create({ cwd: "/", model: noModel })).rejects.toThrow();
    await pollUntil(() => world.box.closedSockets() >= 1);
  });

  it("rejects promptly when exit arrives before started", async () => {
    const world = await startWorld({ boxMode: "exit-before-start" });
    worlds.push(world);
    const engine = cloud(world.bridge.port);
    await expect(engine.create({ cwd: "/", model: noModel })).rejects.toThrow();
    await pollUntil(() => world.state.deleted);
  });

  it("rejects a failed envelope send without an orphan handshake rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let closed = false;
      const connector = cloudConnector({
        url: "http://127.0.0.1:9",
        token: TOKEN,
        engine: "devin",
        openSocket: async () =>
          ({
            send: () => {
              throw new Error("send_broken");
            },
            close: () => {
              closed = true;
            },
            readyState: 1,
            on: () => undefined,
            off: () => undefined,
          }) as never,
      });
      await expect(
        connector({
          cwd: "/",
          onUpdate: () => undefined,
          onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
          onClose: () => undefined,
        }),
      ).rejects.toThrow("send_broken");
      expect(closed).toBe(true);
      await sleep(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps spawn specs fixed with positional-only caller input", () => {
    const devin = CLOUD_ENGINE_SPAWNS.devin!;
    const boot = devin.bootstrapArgv("/ws/dir");
    expect(boot[0]).toBe("sh");
    expect(boot[1]).toBe("-ec");
    expect(boot[2]).toContain("cli.devin.ai/install.sh");
    expect(boot[2]).toContain('mkdir -p -- "$1"');
    expect(boot.at(-1)).toBe("/ws/dir");
    const spawn = devin.argv("m");
    expect(spawn[2]).toContain('exec "$devin" acp');
    expect(spawn.at(-1)).toBe("m");
    expect(CLOUD_ENGINE_SPAWNS.codex!.argv()).toEqual([
      "npx",
      "-y",
      "@agentclientprotocol/codex-acp@1.11.0",
    ]);
    expect(ENGINES.devin.command).toBe("devin");
    expect(ENGINES.codex.command).toBe("codex-acp");
  });
});

/**
 * Executes the REAL fixed bootstrap/spawn scripts (not a fake box that just
 * reports success) against fake executables in a sandboxed PATH/HOME. No real
 * installers, agents, or network: `curl` is a stub that emits a tiny bash
 * installer, `devin`/`npx` are stubs.
 */
describe("bootstrap scripts execute for real", () => {
  /** Minimal env: fake bin dir first, then just the system shells/tools. */
  function sandbox(): {
    root: string;
    bin: string;
    home: string;
    env: NodeJS.ProcessEnv;
  } {
    const root = mkdtempSync(join(tmpdir(), "sunset-boot-"));
    const bin = join(root, "bin");
    const home = join(root, "home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    return {
      root,
      bin,
      home,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    };
  }
  const run = (argv: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(argv[0]!, argv.slice(1), { env, encoding: "utf8" });
  const stub = (bin: string, name: string, body: string): void =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  it.each(["devin", "codex"] as const)(
    "%s bootstrap creates the caller cwd",
    (engine) => {
      const { root, bin, home, env } = sandbox();
      stub(bin, "npx", "exit 0");
      stub(
        bin,
        "curl",
        // Emits a tiny bash installer to stdout — the real script pipes it
        // to `bash` and must redirect its chatter to stderr.
        `cat <<'EOS'
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\nprintf "devin:%%s\\\\n" "$*"\\n' > "$HOME/.local/bin/devin"
chmod +x "$HOME/.local/bin/devin"
echo "installed fake devin"
EOS`,
      );
      const target = join(root, "deep", "workdir");
      const argv = CLOUD_ENGINE_SPAWNS[engine]!.bootstrapArgv(target);
      const res = run(argv, env);
      expect(res.error).toBeUndefined();
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(existsSync(target)).toBe(true);
      if (engine === "devin") {
        // Installer output went to stderr, never stdout (the ACP stream).
        expect(res.stdout).toBe("");
        expect(res.stderr).toContain("installed fake devin");
        expect(existsSync(join(home, ".local/bin/devin"))).toBe(true);
      }
    },
  );

  it("devin bootstrap skips the installer when devin is already installed", () => {
    const { root, bin, env } = sandbox();
    stub(bin, "devin", "printf 'devin:%s\\n' \"$*\"");
    stub(bin, "curl", "echo SHOULD-NOT-RUN >&2; exit 9");
    const argv = CLOUD_ENGINE_SPAWNS.devin!.bootstrapArgv(join(root, "w"));
    const res = run(argv, env);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("SHOULD-NOT-RUN");
  });

  it.each([["model-x"], [undefined]] as const)(
    "devin spawn forwards model=%s positionally",
    (model) => {
      const { bin, home, env } = sandbox();
      stub(bin, "devin", "printf 'devin:%s\\n' \"$*\"");
      const argv = CLOUD_ENGINE_SPAWNS.devin!.argv(model);
      const res = run(argv, env);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe(
        model ? `devin:acp --model ${model}` : "devin:acp",
      );
      // The installed-at-home fallback resolves too.
      mkdirSync(join(home, ".local/bin"), { recursive: true });
      writeFileSync(
        join(home, ".local/bin/devin"),
        "#!/bin/sh\nprintf 'home-devin:%s\\n' \"$*\"\n",
        { mode: 0o755 },
      );
      const res2 = run(argv, { PATH: "/usr/bin:/bin", HOME: home });
      expect(res2.stdout.trim()).toBe(
        model ? `home-devin:acp --model ${model}` : "home-devin:acp",
      );
    },
  );

  it("codex bootstrap fails cleanly without npx", () => {
    const { root, env } = sandbox();
    const argv = CLOUD_ENGINE_SPAWNS.codex!.bootstrapArgv(join(root, "w"));
    const res = run(argv, env);
    expect(res.status).not.toBe(0);
  });
});
