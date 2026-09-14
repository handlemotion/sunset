#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHost, type Host } from "@sunset/host";
import { createSunsetServer } from "@sunset/server";

import { loadConfig, resolveConfig, type ResolvedConfig } from "./config.js";
import { runDoctor } from "./doctor.js";

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

/**
 * Apply configured default engine/model to session creation when the caller
 * (e.g. the web UI) leaves them unset.
 */
function withSessionDefaults(host: Host, config: ResolvedConfig): Host {
  const engine = config.defaultEngine;
  const model = config.defaultModel;
  if (!engine && !model) return host;
  const create = host.sessions.create;
  return {
    ...host,
    sessions: {
      ...host.sessions,
      create: (input) =>
        create({
          ...input,
          ...(input.engine === undefined && engine ? { engine } : {}),
          ...(input.model === undefined && model
            ? { model: { id: model, params: [] } }
            : {}),
        }),
    },
  };
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
  const url = `${server.url}/?token=${server.token}`;
  console.log(`sunset is running`);
  console.log(`  url:   ${url}`);
  console.log(`  state: ${config.stateDir}`);
  if (open) await openBrowser(url);

  const shutdown = () => {
    void server
      .close()
      .then(() => host.close())
      .then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
    process.exitCode = await runDoctor(resolved, await cliVersion());
    return;
  }
  for (const warning of resolved.warnings) {
    console.error(`warning: ${warning}`);
  }
  if (command === "serve") return serve(resolved, rest, false);
  if (command === "open") return serve(resolved, rest, true);

  const host = await createHost({
    stateDir: resolved.stateDir,
    worktreeRoot: resolved.worktreeRoot,
  });
  try {
    const args = positional(rest);
    switch (command) {
      case "projects": {
        if (args[0] === "add" && args[1]) {
          console.log(await host.projects.register(args[1]));
        } else if (args[0] === "list") {
          console.log(host.projects.list());
        } else usage();
        break;
      }
      case "workspaces": {
        if (args[0] === "create" && args[1] && args[2]) {
          console.log(
            await host.workspaces.create({
              projectId: args[1],
              slug: args[2],
            }),
          );
        } else if (args[0] === "list" && args[1]) {
          console.log(host.workspaces.list({ projectId: args[1] }));
        } else usage();
        break;
      }
      case "capabilities": {
        console.log(await host.capabilities());
        break;
      }
      default:
        usage();
    }
  } finally {
    await host.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
