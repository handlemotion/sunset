import { access } from "node:fs/promises";
import path from "node:path";

import { execa, ExecaError } from "execa";

import { GitError } from "./errors.js";

export async function runSetupCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<void> {
  const asScript = path.isAbsolute(command) ? await isFile(command) : false;
  try {
    const result = await execa(command, {
      cwd: options.cwd,
      shell: !asScript,
      timeout: options.timeoutMs,
      cancelSignal: options.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      reject: false,
    });
    if (result.timedOut || result.isCanceled) {
      throw new GitError("setup timed out", "timeout");
    }
    if (result.exitCode !== 0) {
      throw new GitError(
        `setup failed: ${result.stderr || result.stdout}`,
        "setup_failed",
      );
    }
  } catch (cause) {
    if (cause instanceof GitError) {
      throw cause;
    }
    if (cause instanceof ExecaError && (cause.timedOut || cause.isCanceled)) {
      throw new GitError("setup timed out", "timeout", { cause });
    }
    throw new GitError("setup failed", "setup_failed", { cause });
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
