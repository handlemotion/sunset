import { execa } from "execa";

import { createGit, GitError } from "../../dist/index.js";

const input = JSON.parse(process.argv[2]);

function send(message) {
  process.send?.(message);
}

async function waitForRelease() {
  await new Promise((resolve) => {
    process.on("message", (message) => {
      if (message === "release") resolve();
    });
  });
}

const spawn = async (args, options) => {
  if (args[0] === "worktree" && args[1] === "add") {
    send({ type: "entered", slug: input.slug });
    await waitForRelease();
  }
  const result = await execa("git", args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    cancelSignal: options.signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new GitError(
      `${args.join(" ")}: ${result.stderr || result.stdout || "git failed"}`,
      "git_failed",
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0,
  };
};

try {
  const git = createGit({
    spawn,
    leaseTimeoutMs: input.leaseTimeoutMs,
  });
  await git.createWorktree({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    slug: input.slug,
    branch: input.branch,
    baseRef: "HEAD",
  });
  send({ type: "complete", slug: input.slug });
  process.exitCode = 0;
} catch (error) {
  send({
    type: "error",
    slug: input.slug,
    code: error?.code,
    details: error?.details,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
