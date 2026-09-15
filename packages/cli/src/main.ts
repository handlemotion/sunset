#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHost } from "@sunset/host";
import { createSunsetServer } from "@sunset/server";
import type { SunsetClient } from "@sunset/api";
import type { AgentMode } from "@sunset/domain";

import { resolveBackend, resolveClient } from "./client.js";
import {
  attachRunNdjson,
  createSession,
  printJson,
  runExitCode,
  sendPrompt,
} from "./commands.js";
import { loadConfig, resolveConfig, type ResolvedConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { announceServer, serverRecordPath } from "./server-discovery.js";
import { withSessionDefaults } from "./session-defaults.js";

const HELP = `sunset — browser development workspace

Usage:
  sunset serve [--port N] [--state-dir DIR] [--worktree-root DIR]
               [--web-dist DIR] [--engine devin|codex] [--model ID]
  sunset open  [same flags as serve] — serve, then open a browser
  sunset doctor [--state-dir DIR]
  sunset projects add <repo-root> [--state-dir DIR]
  sunset projects list [--state-dir DIR]
  sunset workspaces create <project-id> <slug> [--state-dir DIR]
  sunset workspaces list <project-id> [--state-dir DIR]
  sunset capabilities [--state-dir DIR]

Agent commands — require a running \`sunset serve\`; output is JSON:
  sunset sessions create <workspace-id> --prompt TEXT
                         [--engine devin|codex] [--model ID] [--mode agent|plan]
  sunset sessions list <workspace-id>
  sunset send <session-id> <prompt...>
  sunset runs list <session-id>
  sunset runs wait <run-id>
  sunset runs cancel <run-id>
  sunset attach <run-id> [--after N] — stream run events as NDJSON

  sunset help | --help
  sunset --version

Config file:
  ~/.config/sunset/config.json (override with SUNSET_CONFIG)
  Supported keys: port (number), stateDir (string),
  defaultEngine ("devin" | "codex"), defaultModel (string).
  Precedence: config file < environment < CLI flags.

Environment:
  SUNSET_CONFIG          config file path
  SUNSET_STATE_DIR       state root (state dir is $SUNSET_STATE_DIR/state)
                         (default ~/.local/share/sunset)
  SUNSET_PORT            default port for serve/open
  SUNSET_DEFAULT_ENGINE  default engine: devin or codex
  SUNSET_DEFAULT_MODEL   default model id
  SUNSET_WEB_DIST        web build directory (default bundled apps/web/dist)
`;

function printHelp(): void {
  console.log(HELP);
}

function usage(): never {
  console.error(HELP);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`missing value for --${name}`);
    process.exit(2);
  }
  return value;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

let versionPromise: Promise<string> | undefined;

function cliVersion(): Promise<string> {
  versionPromise ??= (async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const text = await readFile(
      path.resolve(here, "..", "package.json"),
      "utf8",
    );
    const pkg = JSON.parse(text) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  })();
  return versionPromise;
}

function webDist(args: string[]): string | undefined {
  const explicit =
    flag(args, "web-dist") ?? process.env.SUNSET_WEB_DIST ?? undefined;
  if (explicit) return explicit;
  // When installed from this repo, the web build lives next to the CLI.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.resolve(here, "../../../apps/web/dist");
  return bundled;
}

async function openBrowser(url: string): Promise<void> {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function serve(
  config: ResolvedConfig,
  args: string[],
  open: boolean,
): Promise<void> {
  const host = withSessionDefaults(
    await createHost({
      stateDir: config.stateDir,
      worktreeRoot: config.worktreeRoot,
    }),
    config,
  );
  const server = await createSunsetServer({
    host,
    webDist: webDist(args),
    ...(config.port !== undefined ? { port: config.port } : {}),
  });
  let removeRecord: (() => Promise<void>) | undefined;
  try {
    removeRecord = await announceServer(config.stateDir, server);
  } catch (error) {
    console.error(
      `warning: could not write ${serverRecordPath(config.stateDir)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const url = `${server.url}/?token=${server.token}`;
  console.log(`sunset is running`);
  console.log(`  url:   ${url}`);
  console.log(`  state: ${config.stateDir}`);
  if (open) await openBrowser(url);

  const shutdown = () => {
    void Promise.resolve(removeRecord?.())
      .then(() => server.close())
      .then(() => host.close())
      .then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Commands that only work against a running `sunset serve`. */
const SERVER_ONLY = new Set(["sessions", "send", "runs", "attach"]);
/** Commands served by the API when live, by a direct host otherwise. */
const SHARED = new Set(["projects", "workspaces", "capabilities"]);

function parseMode(value: string): AgentMode | undefined {
  return value === "agent" || value === "plan" ? value : undefined;
}

function parseAfter(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Dispatches a server-only command. Returns the process exit code. */
async function runServerCommand(
  client: SunsetClient,
  config: ResolvedConfig,
  command: string,
  rest: string[],
  args: string[],
): Promise<number> {
  switch (command) {
    case "sessions": {
      if (args[0] === "create" && args[1]) {
        const prompt = flag(rest, "prompt") ?? args.slice(2).join(" ");
        if (!prompt) {
          console.error("sunset sessions create: --prompt is required");
          return 2;
        }
        const modeFlag = flag(rest, "mode");
        const mode = modeFlag === undefined ? undefined : parseMode(modeFlag);
        if (modeFlag !== undefined && mode === undefined) {
          console.error(
            `invalid --mode "${modeFlag}": expected "agent" or "plan"`,
          );
          return 2;
        }
        printJson(
          await createSession(client, config, {
            workspaceId: args[1],
            prompt,
            ...(mode ? { mode } : {}),
          }),
        );
        return 0;
      }
      if (args[0] === "list" && args[1]) {
        printJson(await client.listSessions(args[1]));
        return 0;
      }
      usage();
    }
    case "send": {
      const sessionId = args[0];
      if (!sessionId) usage();
      const prompt = flag(rest, "prompt") ?? args.slice(1).join(" ");
      if (!prompt) {
        console.error("usage: sunset send <session-id> <prompt>");
        return 2;
      }
      printJson(await sendPrompt(client, sessionId, prompt));
      return 0;
    }
    case "runs": {
      if (args[0] === "list" && args[1]) {
        printJson(await client.listRuns(args[1]));
        return 0;
      }
      if (args[0] === "wait" && args[1]) {
        const result = await client.waitRun(args[1]);
        printJson(result);
        return runExitCode(result.status);
      }
      if (args[0] === "cancel" && args[1]) {
        printJson(await client.cancelRun(args[1]));
        return 0;
      }
      usage();
    }
    case "attach": {
      const runId = args[0];
      if (!runId) usage();
      const afterFlag = flag(rest, "after");
      const after = afterFlag === undefined ? undefined : parseAfter(afterFlag);
      if (afterFlag !== undefined && after === undefined) {
        console.error(
          `invalid --after "${afterFlag}": expected a nonnegative integer`,
        );
        return 2;
      }
      const run = await attachRunNdjson(client, runId, { after }, (line) =>
        console.log(line),
      );
      if (run === null) {
        console.error(`sunset attach: run ${runId} not found`);
        return runExitCode("missing");
      }
      if (run.status !== "finished") {
        console.error(
          `sunset attach: run ${run.id} ended with status "${run.status}"`,
        );
      }
      return runExitCode(run.status);
    }
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "version") {
    console.log(await cliVersion());
    return;
  }
  if (!command) usage();

  const loaded = await loadConfig();
  const resolved = resolveConfig(loaded, process.env, {
    port: flag(rest, "port"),
    stateDir: flag(rest, "state-dir"),
    worktreeRoot: flag(rest, "worktree-root"),
    engine: flag(rest, "engine"),
    model: flag(rest, "model"),
  });
  if (resolved.errors.length > 0) {
    for (const error of resolved.errors) console.error(error);
    usage();
  }

  if (command === "doctor") {
    process.exit(await runDoctor(resolved, await cliVersion()));
  }
  for (const warning of resolved.warnings) {
    console.error(`warning: ${warning}`);
  }
  if (command === "serve") return serve(resolved, rest, false);
  if (command === "open") return serve(resolved, rest, true);

  const args = positional(rest);

  if (SERVER_ONLY.has(command)) {
    const client = await resolveClient(resolved);
    if (!client) {
      console.error(
        `sunset ${command}: requires a running server — start one with \`sunset serve\``,
      );
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runServerCommand(
      client,
      resolved,
      command,
      rest,
      args,
    );
    return;
  }

  if (!SHARED.has(command)) usage();

  const backend = await resolveBackend(resolved);
  try {
    switch (command) {
      case "projects": {
        if (args[0] === "add" && args[1]) {
          printJson(await backend.addProject(args[1]));
        } else if (args[0] === "list") {
          printJson(await backend.listProjects());
        } else usage();
        break;
      }
      case "workspaces": {
        if (args[0] === "create" && args[1] && args[2]) {
          printJson(await backend.createWorkspace(args[1], { slug: args[2] }));
        } else if (args[0] === "list" && args[1]) {
          printJson(await backend.listWorkspaces(args[1]));
        } else usage();
        break;
      }
      case "capabilities": {
        printJson(await backend.capabilities());
        break;
      }
    }
  } finally {
    await backend.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
