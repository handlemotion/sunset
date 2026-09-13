import { mkdir, copyFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { glob } from "tinyglobby";

import { GitError } from "./errors.js";
import { isPathInside } from "./paths.js";

export function assertCopyGlobs(patterns: readonly string[]): void {
  for (const pattern of patterns) {
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      path.isAbsolute(pattern) ||
      pattern.split(/[\\/]/).includes("..")
    ) {
      throw new GitError(`copy path escapes repo: ${pattern}`, "path_escape");
    }
  }
}

export async function copyGlobs(
  repoRoot: string,
  worktreePath: string,
  patterns: string[],
): Promise<string[]> {
  assertCopyGlobs(patterns);
  if (patterns.length === 0) {
    return [];
  }
  const matches = await glob(patterns, {
    cwd: repoRoot,
    dot: true,
    absolute: false,
    onlyFiles: true,
  });
  const copied: string[] = [];
  const realRoot = await realpath(repoRoot);
  const realWorktree = await realpath(worktreePath);
  for (const relative of matches) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new GitError(`copy path escapes repo: ${relative}`, "path_escape");
    }
    const from = path.join(realRoot, relative);
    const to = path.join(realWorktree, relative);
    const realFrom = await realpath(from);
    if (
      !isPathInside(realRoot, realFrom) ||
      !isPathInside(realWorktree, path.dirname(to))
    ) {
      throw new GitError(`copy path escapes repo: ${relative}`, "path_escape");
    }
    const info = await stat(realFrom);
    if (!info.isFile()) {
      continue;
    }
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(realFrom, to);
    copied.push(relative);
  }
  return copied;
}
