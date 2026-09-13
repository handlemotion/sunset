import { realpath } from "node:fs/promises";
import path from "node:path";

import { GitError } from "./errors.js";

export async function resolveRepoRoot(repoRoot: string): Promise<string> {
  try {
    return await realpath(path.resolve(repoRoot));
  } catch (cause) {
    throw new GitError(
      `repoRoot does not exist: ${repoRoot}`,
      "repo_not_found",
      {
        cause,
      },
    );
  }
}

export function assertAbsolutePath(label: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new GitError(
      `${label} must be an absolute path`,
      "path_not_absolute",
    );
  }
  return path.resolve(value);
}

export function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export async function resolveExistingPrefix(target: string): Promise<string> {
  const resolved = path.resolve(target);
  let current = resolved;
  while (true) {
    try {
      const real = await realpath(current);
      const rest = path.relative(current, resolved);
      if (rest === "") {
        return real;
      }
      return path.join(real, rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      current = parent;
    }
  }
}
