import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { listModels, resolveEngineSpawn } from "@sunset/acp";
import type { EngineId, ModelCapability } from "@sunset/domain";

import type { ResolvedConfig } from "./config.js";

const ENGINE_IDS: EngineId[] = ["devin", "codex"];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Whether `command` can be executed: bare names go through PATH lookup. */
export function commandAvailable(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) {
    return access(command, constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  return new Promise((resolve) => {
    execFile("which", [command], (error) => resolve(!error));
  });
}

export function defaultModelId(models: ModelCapability[]): string | undefined {
  const preferred =
    models.find((model) => model.variants.some((v) => v.isDefault)) ??
    models[0];
  return preferred?.id;
}

type EngineReport = {
  engine: EngineId;
  spawnOk: boolean;
  spawn: string;
  catalog: string;
};

async function checkEngine(engine: EngineId): Promise<EngineReport> {
  let spawn = "";
  let spawnOk = false;
  try {
    const resolved = await resolveEngineSpawn(engine);
    spawn = [resolved.command, ...resolved.args].join(" ");
    if (engine === "codex" && resolved.command === "npx") {
      spawn += " (fallback)";
    }
    spawnOk = await commandAvailable(resolved.command);
    if (!spawnOk) spawn += " — not found on PATH";
  } catch (error) {
    spawn = `error: ${errorMessage(error)}`;
  }

  let catalog = "";
  try {
    const models = await listModels(engine);
    if (models.length === 0) {
      catalog = "empty catalog";
    } else {
      const def = defaultModelId(models);
      catalog = `${models.length} models${def ? `, default ${def}` : ""}`;
    }
  } catch (error) {
    catalog = `error: ${errorMessage(error)}`;
  }

  return { engine, spawnOk, spawn, catalog };
}

async function checkStateDir(
  dir: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.sunset-doctor-${process.pid}`);
    await writeFile(probe, "ok", "utf8");
    await rm(probe);
    return { ok: true, detail: `${dir} (writable)` };
  } catch (error) {
    return { ok: false, detail: `${dir} (${errorMessage(error)})` };
  }
}

/** Runs all checks, prints the report, returns the process exit code. */
export async function runDoctor(
  config: ResolvedConfig,
  version: string,
): Promise<number> {
  console.log(`sunset ${version} (node ${process.version})`);
  console.log(
    `config  ${config.configPath}${config.configFound ? "" : " (not found)"}`,
  );
  for (const warning of config.warnings) {
    console.log(`        warning: ${warning}`);
  }

  const state = await checkStateDir(config.stateDir);
  console.log(`state   ${state.ok ? "" : "FAIL "}${state.detail}`);

  const engines = await Promise.all(ENGINE_IDS.map(checkEngine));
  console.log("");
  const width = Math.max(
    "resolution".length,
    ...engines.map((report) => report.spawn.length),
  );
  const line = (
    engine: string,
    status: string,
    spawn: string,
    catalog: string,
  ) =>
    `  ${engine.padEnd(6)} ${status.padEnd(5)} ${spawn.padEnd(width)}  ${catalog}`;
  console.log(line("engine", "", "resolution", "catalog"));
  for (const report of engines) {
    console.log(
      line(
        report.engine,
        report.spawnOk ? "ok" : "FAIL",
        report.spawn,
        report.catalog,
      ),
    );
  }

  const allResolved = engines.every((report) => report.spawnOk);
  if (!allResolved || !state.ok) {
    console.log("\nfix the FAIL checks above and re-run `sunset doctor`");
  }
  return allResolved && state.ok ? 0 : 1;
}
