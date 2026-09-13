import { execa, ExecaError } from "execa";

import { GitError } from "./errors.js";
import type { GitSpawn } from "./types.js";

export const defaultGitSpawn: GitSpawn = async (args, options) => {
  try {
    const result = await execa("git", args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      cancelSignal: options.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      reject: false,
    });
    if (result.timedOut || result.isCanceled) {
      throw new GitError(`git ${args.join(" ")} timed out`, "timeout");
    }
    if (result.exitCode !== 0) {
      throw new GitError(
        `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        "git_failed",
      );
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    };
  } catch (cause) {
    if (cause instanceof GitError) {
      throw cause;
    }
    if (cause instanceof ExecaError && (cause.timedOut || cause.isCanceled)) {
      throw new GitError(`git ${args.join(" ")} timed out`, "timeout", {
        cause,
      });
    }
    throw new GitError(`git ${args.join(" ")} failed`, "git_failed", { cause });
  }
};
