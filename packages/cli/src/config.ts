import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type DefaultEngine = "devin" | "codex";

export type SunsetConfig = {
  port?: number;
  stateDir?: string;
  defaultEngine?: DefaultEngine;
  defaultModel?: string;
};

export type LoadedConfig = {
  path: string;
  /** Whether a file existed at `path` (it may still have failed to parse). */
  found: boolean;
  config: SunsetConfig;
  warnings: string[];
};

/** Raw flag values, as strings, extracted by the entrypoint. */
export type CliFlags = {
  port?: string;
  stateDir?: string;
  worktreeRoot?: string;
  engine?: string;
  model?: string;
};

export type ResolvedConfig = {
  stateDir: string;
  worktreeRoot: string;
  port?: number;
  defaultEngine?: DefaultEngine;
  defaultModel?: string;
  configPath: string;
  configFound: boolean;
  warnings: string[];
  /** Invalid flag values: fatal usage errors, not warnings. */
  errors: string[];
};

const KNOWN_KEYS = new Set([
  "port",
  "stateDir",
  "defaultEngine",
  "defaultModel",
]);

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SUNSET_CONFIG ??
    path.join(homedir(), ".config", "sunset", "config.json")
  );
}

export function defaultStateRoot(): string {
  return path.join(homedir(), ".local", "share", "sunset");
}

export function parseConfig(
  data: unknown,
  source: string,
): { config: SunsetConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: SunsetConfig = {};
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    warnings.push(`${source}: expected a JSON object; ignoring config`);
    return { config, warnings };
  }
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`${source}: unknown key "${key}"`);
      continue;
    }
    switch (key) {
      case "port":
        if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 65535
        ) {
          config.port = value;
        } else {
          warnings.push(
            `${source}: "port" must be an integer between 0 and 65535`,
          );
        }
        break;
      case "stateDir":
        if (typeof value === "string" && value.length > 0) {
          config.stateDir = value;
        } else {
          warnings.push(`${source}: "stateDir" must be a non-empty string`);
        }
        break;
      case "defaultEngine":
        if (value === "devin" || value === "codex") {
          config.defaultEngine = value;
        } else {
          warnings.push(
            `${source}: "defaultEngine" must be "devin" or "codex"`,
          );
        }
        break;
      case "defaultModel":
        if (typeof value === "string" && value.length > 0) {
          config.defaultModel = value;
        } else {
          warnings.push(`${source}: "defaultModel" must be a non-empty string`);
        }
        break;
    }
  }
  // Fail closed: any problem rejects the whole document so a partially
  // understood config is never applied.
  if (warnings.length > 0) {
    warnings.push(`${source}: invalid config; ignoring the whole file`);
    return { config: {}, warnings };
  }
  return { config, warnings };
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const file = configPath(env);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: file, found: false, config: {}, warnings: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: file,
      found: true,
      config: {},
      warnings: [`${file}: could not read config (${message}); ignoring it`],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      path: file,
      found: true,
      config: {},
      warnings: [`${file}: not valid JSON; ignoring config`],
    };
  }
  const { config, warnings } = parseConfig(data, file);
  return { path: file, found: true, config, warnings };
}

function parsePort(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const port = Number(value);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  return undefined;
}

function parseEngine(value: string): DefaultEngine | undefined {
  return value === "devin" || value === "codex" ? value : undefined;
}

/**
 * Merge file config, environment, and CLI flags. Precedence is
 * file < environment < flag. Invalid env values warn and fall through to the
 * file value; invalid flag values are reported as fatal errors.
 */
export function resolveConfig(
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
  flags: CliFlags = {},
): ResolvedConfig {
  const warnings = [...loaded.warnings];
  const errors: string[] = [];
  const { config } = loaded;

  // SUNSET_STATE_DIR keeps its existing meaning: the state *root*, with the
  // state dir at "$SUNSET_STATE_DIR/state". The file key and --state-dir flag
  // name the state dir directly.
  const envRoot = env.SUNSET_STATE_DIR;
  const stateDir =
    flags.stateDir ??
    (envRoot ? path.join(envRoot, "state") : undefined) ??
    config.stateDir ??
    path.join(defaultStateRoot(), "state");
  const worktreeRoot =
    flags.worktreeRoot ?? path.join(envRoot ?? defaultStateRoot(), "worktrees");

  let port: number | undefined;
  if (flags.port !== undefined) {
    port = parsePort(flags.port);
    if (port === undefined) {
      errors.push(
        `invalid --port "${flags.port}": expected an integer 0-65535`,
      );
    }
  } else if (env.SUNSET_PORT !== undefined) {
    port = parsePort(env.SUNSET_PORT);
    if (port === undefined) {
      warnings.push(
        `SUNSET_PORT: "${env.SUNSET_PORT}" is not an integer 0-65535; ignoring it`,
      );
      port = config.port;
    }
  } else {
    port = config.port;
  }

  let defaultEngine: DefaultEngine | undefined;
  if (flags.engine !== undefined) {
    defaultEngine = parseEngine(flags.engine);
    if (defaultEngine === undefined) {
      errors.push(
        `invalid --engine "${flags.engine}": expected "devin" or "codex"`,
      );
    }
  } else if (env.SUNSET_DEFAULT_ENGINE !== undefined) {
    defaultEngine = parseEngine(env.SUNSET_DEFAULT_ENGINE);
    if (defaultEngine === undefined) {
      warnings.push(
        `SUNSET_DEFAULT_ENGINE: "${env.SUNSET_DEFAULT_ENGINE}" is not "devin" or "codex"; ignoring it`,
      );
      defaultEngine = config.defaultEngine;
    }
  } else {
    defaultEngine = config.defaultEngine;
  }

  const defaultModel =
    (flags.model || undefined) ??
    (env.SUNSET_DEFAULT_MODEL || undefined) ??
    config.defaultModel;

  const resolved: ResolvedConfig = {
    stateDir,
    worktreeRoot,
    defaultModel,
    configPath: loaded.path,
    configFound: loaded.found,
    warnings,
    errors,
  };
  if (port !== undefined) resolved.port = port;
  if (defaultEngine !== undefined) resolved.defaultEngine = defaultEngine;
  return resolved;
}
