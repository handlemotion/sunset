import { readFile } from "node:fs/promises";
import path from "node:path";

import { GitError } from "./errors.js";
import type { SunsetJson } from "./types.js";

export type SetupSpec = {
  copy: string[];
  commands: Array<{ command: string; cursorScript: boolean }>;
};

function asCommandList(
  value: unknown,
  filePath: string,
): Array<{ command: string; cursorScript: boolean }> {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new GitError(`empty setup command: ${filePath}`, "config_invalid");
    }
    return [{ command: value, cursorScript: false }];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new GitError(
          `invalid setup command: ${filePath}`,
          "config_invalid",
        );
      }
      return { command: item, cursorScript: false };
    });
  }
  if (value === undefined) {
    return [];
  }
  throw new GitError(`invalid setup command: ${filePath}`, "config_invalid");
}

function copyList(value: unknown, filePath: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GitError(`invalid copy list: ${filePath}`, "config_invalid");
  }
  return value;
}

function cursorScriptPath(value: string, filePath: string): string {
  if (value.trim().length === 0 || path.isAbsolute(value)) {
    throw new GitError(
      `invalid Cursor setup script: ${filePath}`,
      "config_invalid",
    );
  }
  const cursorRoot = path.join(path.dirname(filePath));
  const resolved = path.resolve(cursorRoot, value);
  const relative = path.relative(cursorRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new GitError(
      `Cursor setup script escapes .cursor: ${filePath}`,
      "config_invalid",
    );
  }
  return path.join(".cursor", relative);
}

async function readJsonObject(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return null;
    }
    throw new GitError(`failed to read ${filePath}`, "config_invalid", {
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new GitError(`invalid JSON: ${filePath}`, "config_invalid", {
      cause,
    });
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new GitError(`invalid JSON object: ${filePath}`, "config_invalid");
}

function isEnoent(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

export async function loadWorktreeConfig(
  repoRoot: string,
  extraCopyGlobs: string[] | undefined,
): Promise<SetupSpec> {
  if (extraCopyGlobs !== undefined && !Array.isArray(extraCopyGlobs)) {
    throw new GitError("invalid copy globs", "config_invalid");
  }
  const extra = extraCopyGlobs ?? [];
  const sunset = await readJsonObject(path.join(repoRoot, "sunset.json"));
  if (sunset !== null) {
    const allowed = new Set(["copy", "setup"]);
    if (Object.keys(sunset).some((key) => !allowed.has(key))) {
      throw new GitError("unknown key in sunset.json", "config_invalid");
    }
    return {
      copy: [...copyList(sunset.copy, "sunset.json"), ...extra],
      commands: asCommandList(sunset.setup, "sunset.json"),
    };
  }

  const cursorFile = path.join(repoRoot, ".cursor", "worktrees.json");
  const cursor = await readJsonObject(cursorFile);
  const copy = extra;
  if (cursor === null) {
    return { copy, commands: [] };
  }
  const spec = Object.hasOwn(cursor, "setup-worktree-unix")
    ? cursor["setup-worktree-unix"]
    : cursor["setup-worktree"];
  if (typeof spec === "string") {
    return {
      copy,
      commands: [
        { command: cursorScriptPath(spec, cursorFile), cursorScript: true },
      ],
    };
  }
  return { copy, commands: asCommandList(spec, cursorFile) };
}

export type { SunsetJson };
