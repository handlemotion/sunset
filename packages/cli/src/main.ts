#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHost } from "@sunset/host";
import { createSunsetServer } from "@sunset/server";

const DEFAULT_STATE_ROOT = path.join(
  process.env.SUNSET_STATE_DIR ??
    path.join(homedir(), ".local", "share", "sunset"),
);

function usage(): never {
  console.error(`sunset — browser development workspace

Usage:
  sunset serve [--port N] [--state-dir DIR] [--web-dist DIR]
  sunset open  [--port N] [--state-dir DIR] [--web-dist DIR]
  sunset projects add <repo-root> [--state-dir DIR]
  sunset projects list [--state-dir DIR]
  sunset workspaces create <project-id> <slug> [--state-dir DIR]
  sunset workspaces list <project-id> [--state-dir DIR]
  sunset capabilities [--state-dir DIR]

Environment:
  SUNSET_STATE_DIR   default state root (default ~/.local/share/sunset)
  SUNSET_WEB_DIST    web build directory (default bundled apps/web/dist)
`);
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

function stateDir(args: string[]): string {
  return flag(args, "state-dir") ?? path.join(DEFAULT_STATE_ROOT, "state");
}

function worktreeRoot(args: string[]): string {
  return (
    flag(args, "worktree-root") ?? path.join(DEFAULT_STATE_ROOT, "worktrees")
  );
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

async function serve(args: string[], open: boolean): Promise<void> {
  const host = await createHost({
    stateDir: stateDir(args),
    worktreeRoot: worktreeRoot(args),
  });
  const port = flag(args, "port");
  const server = await createSunsetServer({
    host,
    webDist: webDist(args),
    ...(port ? { port: Number(port) } : {}),
  });
  const url = `${server.url}/?token=${server.token}`;
  console.log(`sunset is running`);
  console.log(`  url:   ${url}`);
  console.log(`  state: ${stateDir(args)}`);
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
  if (!command) usage();

  if (command === "serve") return serve(rest, false);
  if (command === "open") return serve(rest, true);

  const host = await createHost({
    stateDir: stateDir(rest),
    worktreeRoot: worktreeRoot(rest),
  });
  try {
    const [sub, ...tail] = rest.filter((arg) => !arg.startsWith("--"));
    void sub;
    void tail;
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

await main();
