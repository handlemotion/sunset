import { execFile } from "node:child_process";
import type { EngineId } from "@sunset/domain";

export type EngineDefinition = {
  id: EngineId;
  /** Display name for UI. */
  displayName: string;
  /**
   * Command spawned for each session: `command` + `args(input)`.
   * The process must speak ACP over stdio.
   */
  command: string;
  args: (input: { model?: string }) => string[];
  env?: (input: { model?: string }) => Record<string, string>;
  /**
   * Shell command that prints a machine-readable model catalog, or null when
   * the engine has no catalog command.
   */
  catalogCommand: string[] | null;
};

export const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
export const CODEX_ACP_VERSION = "0.16.0";

export const ENGINES: Record<EngineId, EngineDefinition> = {
  devin: {
    id: "devin",
    displayName: "Devin",
    command: "devin",
    args: ({ model }) => ["acp", ...(model ? ["--model", model] : [])],
    catalogCommand: ["devin", "models", "list", "--format", "json"],
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    command: "codex-acp",
    args: ({ model }) =>
      model ? ["-c", `model=${JSON.stringify(model)}`] : [],
    catalogCommand: null,
  },
};

function onPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [command], (error) => resolve(!error));
  });
}

const spawnCache = new Map<
  EngineId,
  Promise<{ command: string; args: string[] }>
>();

/**
 * Resolves how to spawn an engine. `codex-acp` on PATH wins; otherwise npx
 * runs the pinned adapter package.
 */
export function resolveEngineSpawn(
  engine: EngineId,
): Promise<{ command: string; args: string[] }> {
  const cached = spawnCache.get(engine);
  if (cached) return cached;
  const resolved = (async (): Promise<{ command: string; args: string[] }> => {
    const def = ENGINES[engine];
    if (engine === "codex" && !(await onPath(def.command))) {
      return {
        command: "npx",
        args: ["-y", `${CODEX_ACP_PACKAGE}@${CODEX_ACP_VERSION}`],
      };
    }
    return { command: def.command, args: [] };
  })();
  spawnCache.set(engine, resolved);
  return resolved;
}
