import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configPath,
  loadConfig,
  parseConfig,
  resolveConfig,
  type LoadedConfig,
} from "./config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sunset-config-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { SUNSET_CONFIG: path.join(dir, "config.json"), ...overrides };
}

async function writeConfig(text: string): Promise<string> {
  const file = path.join(dir, "config.json");
  await writeFile(file, text, "utf8");
  return file;
}

function loaded(
  config: LoadedConfig["config"],
  warnings: string[] = [],
): LoadedConfig {
  return { path: "/test/config.json", found: true, config, warnings };
}

describe("configPath", () => {
  it("honors SUNSET_CONFIG", () => {
    expect(configPath({ SUNSET_CONFIG: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  it("defaults to ~/.config/sunset/config.json", () => {
    expect(configPath({})).toBe(
      path.join(process.env.HOME ?? "/", ".config", "sunset", "config.json"),
    );
  });
});

describe("loadConfig", () => {
  it("returns an empty config when the file is missing", async () => {
    const result = await loadConfig(env());
    expect(result.found).toBe(false);
    expect(result.config).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("warns and falls back on invalid JSON", async () => {
    const file = await writeConfig("{ not json");
    const result = await loadConfig(env());
    expect(result.config).toEqual({});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(file);
    expect(result.warnings[0]).toContain("not valid JSON");
  });

  it("warns and falls back on a non-object document", async () => {
    await writeConfig('["devin"]');
    const result = await loadConfig(env());
    expect(result.config).toEqual({});
    expect(result.warnings[0]).toContain("expected a JSON object");
  });

  it("rejects the whole file when a valid key is mixed with unknown keys", async () => {
    await writeConfig('{"port": 8080, "bogus": true, "other": 1}');
    const result = await loadConfig(env());
    expect(result.config).toEqual({});
    expect(result.warnings.join(" ")).toContain('"bogus"');
    expect(result.warnings.join(" ")).toContain('"other"');
    expect(result.warnings.join(" ")).toContain("ignoring the whole file");
  });

  it("rejects the whole file when a valid key is mixed with invalid values", async () => {
    await writeConfig('{"port": 8080, "defaultEngine": "gpt"}');
    const result = await loadConfig(env());
    expect(result.config).toEqual({});
    expect(result.warnings.join(" ")).toContain('"defaultEngine"');
  });

  it("warns on invalid values and drops them", async () => {
    await writeConfig(
      '{"port": "nope", "stateDir": 42, "defaultEngine": "gpt", "defaultModel": ""}',
    );
    const result = await loadConfig(env());
    expect(result.config).toEqual({});
    expect(result.warnings).toHaveLength(5);
  });

  it("accepts port 0 (ephemeral)", async () => {
    await writeConfig('{"port": 0}');
    const result = await loadConfig(env());
    expect(result).toMatchObject({ config: { port: 0 }, warnings: [] });
  });

  it("loads a valid config", async () => {
    await writeConfig(
      '{"port": 8080, "stateDir": "/tmp/state", "defaultEngine": "codex", "defaultModel": "codex:gpt-6-astra"}',
    );
    const result = await loadConfig(env());
    expect(result).toMatchObject({
      found: true,
      config: {
        port: 8080,
        stateDir: "/tmp/state",
        defaultEngine: "codex",
        defaultModel: "codex:gpt-6-astra",
      },
      warnings: [],
    });
  });
});

describe("parseConfig", () => {
  it("rejects arrays and primitives", () => {
    for (const data of [[], "x", 7, null]) {
      const { config, warnings } = parseConfig(data, "test");
      expect(config).toEqual({});
      expect(warnings).toHaveLength(1);
    }
  });
});

describe("resolveConfig precedence", () => {
  const baseEnv = () => env();

  it("uses defaults when nothing is set", () => {
    const resolved = resolveConfig(loaded({}), baseEnv());
    expect(resolved.stateDir).toContain(".local/share/sunset/state");
    expect(resolved.worktreeRoot).toContain(".local/share/sunset/worktrees");
    expect(resolved.port).toBeUndefined();
    expect(resolved.errors).toEqual([]);
  });

  it("applies file values", () => {
    const resolved = resolveConfig(
      loaded({
        port: 9000,
        stateDir: "/file/state",
        defaultEngine: "codex",
        defaultModel: "codex:gpt-6-astra",
      }),
      baseEnv(),
    );
    expect(resolved).toMatchObject({
      port: 9000,
      stateDir: "/file/state",
      defaultEngine: "codex",
      defaultModel: "codex:gpt-6-astra",
    });
  });

  it("environment beats file", () => {
    const resolved = resolveConfig(
      loaded({
        port: 9000,
        stateDir: "/file/state",
        defaultEngine: "codex",
        defaultModel: "file-model",
      }),
      env({
        SUNSET_PORT: "9100",
        SUNSET_STATE_DIR: "/env/root",
        SUNSET_DEFAULT_ENGINE: "devin",
        SUNSET_DEFAULT_MODEL: "env-model",
      }),
    );
    expect(resolved).toMatchObject({
      port: 9100,
      stateDir: path.join("/env/root", "state"),
      worktreeRoot: path.join("/env/root", "worktrees"),
      defaultEngine: "devin",
      defaultModel: "env-model",
    });
  });

  it("flags beat environment and file", () => {
    const resolved = resolveConfig(
      loaded({ port: 9000, stateDir: "/file/state", defaultEngine: "codex" }),
      env({ SUNSET_PORT: "9100", SUNSET_STATE_DIR: "/env/root" }),
      {
        port: "9200",
        stateDir: "/flag/state",
        engine: "devin",
        model: "flag-model",
      },
    );
    expect(resolved).toMatchObject({
      port: 9200,
      stateDir: "/flag/state",
      defaultEngine: "devin",
      defaultModel: "flag-model",
    });
  });

  it("invalid env values warn and fall back to the file value", () => {
    const resolved = resolveConfig(
      loaded({ port: 9000, defaultEngine: "codex" }),
      env({ SUNSET_PORT: "abc", SUNSET_DEFAULT_ENGINE: "bogus" }),
    );
    expect(resolved.port).toBe(9000);
    expect(resolved.defaultEngine).toBe("codex");
    expect(resolved.warnings).toHaveLength(2);
    expect(resolved.errors).toEqual([]);
  });

  it("invalid flag values are errors", () => {
    const resolved = resolveConfig(loaded({}), baseEnv(), {
      port: "abc",
      engine: "bogus",
    });
    expect(resolved.errors).toHaveLength(2);
    expect(resolved.errors[0]).toContain("--port");
    expect(resolved.errors[1]).toContain("--engine");
  });

  it("propagates load warnings", () => {
    const resolved = resolveConfig(loaded({}, ["file warning"]), baseEnv());
    expect(resolved.warnings).toEqual(["file warning"]);
  });
});
