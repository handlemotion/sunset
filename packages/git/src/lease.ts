import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { GitError } from "./errors.js";
import type { RepositoryLeaseOwner } from "./types.js";

const execFileAsync = promisify(execFile);
const POLL_MS = 25;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

function isOwner(value: unknown): value is RepositoryLeaseOwner {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RepositoryLeaseOwner>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.leaseId === "string" &&
    typeof candidate.repositoryIdentity === "string" &&
    (candidate.operation === "create_worktree" ||
      candidate.operation === "archive_worktree" ||
      candidate.operation === "recover_workspace_operation") &&
    (candidate.operationId === undefined ||
      typeof candidate.operationId === "string") &&
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.hostname === "string" &&
    typeof candidate.processStartFingerprint === "string" &&
    candidate.processStartFingerprint.length > 0 &&
    typeof candidate.acquiredAt === "number"
  );
}

async function fingerprint(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const started = fields[19];
      if (started) {
        return `linux:${started}`;
      }
    } catch {
      return undefined;
    }
  }
  try {
    const result = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 1_000, encoding: "utf8" },
    );
    const started = result.stdout.trim();
    return started.length > 0 ? `${process.platform}:${started}` : undefined;
  } catch {
    return undefined;
  }
}

async function processDefinitelyGone(
  owner: RepositoryLeaseOwner,
): Promise<boolean> {
  if (owner.hostname !== os.hostname()) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") {
      return true;
    }
    return false;
  }
  const currentFingerprint = await fingerprint(owner.pid);
  return (
    currentFingerprint !== undefined &&
    currentFingerprint !== owner.processStartFingerprint
  );
}

async function readOwner(
  lockPath: string,
): Promise<RepositoryLeaseOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    return isOwner(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function ownerDetails(
  owner: RepositoryLeaseOwner | undefined,
): Readonly<Record<string, unknown>> | undefined {
  return owner ? { owner } : undefined;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RepositoryLease {
  constructor(private readonly timeoutMs: number) {}

  async run<T>(
    repositoryIdentity: string,
    operation: RepositoryLeaseOwner["operation"],
    task: () => Promise<T>,
    operationId?: string,
  ): Promise<T> {
    const root = path.join(repositoryIdentity, "sunset-locks");
    const owners = path.join(root, "owners");
    const lockPath = path.join(root, "repository.lock");
    await mkdir(owners, { recursive: true });

    const leaseId = randomUUID();
    const ownerPath = path.join(owners, `${leaseId}.json`);
    const temporaryOwnerPath = `${ownerPath}.${process.pid}.tmp`;
    const processStartFingerprint = await fingerprint(process.pid);
    if (!processStartFingerprint) {
      throw new GitError(
        "could not determine the current process identity",
        "lease_unavailable",
      );
    }
    const owner: RepositoryLeaseOwner = {
      schemaVersion: 1,
      leaseId,
      repositoryIdentity,
      operation,
      pid: process.pid,
      hostname: os.hostname(),
      processStartFingerprint,
      acquiredAt: Date.now(),
    };
    if (operationId !== undefined) owner.operationId = operationId;
    await writeFile(temporaryOwnerPath, `${JSON.stringify(owner)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryOwnerPath, ownerPath);

    const deadline = Date.now() + this.timeoutMs;
    let acquired = false;
    try {
      while (!acquired) {
        try {
          await link(ownerPath, lockPath);
          acquired = true;
          break;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") {
            throw new GitError(
              "could not acquire repository lease",
              "lease_unavailable",
              {
                cause: error,
              },
            );
          }
        }

        const current = await readOwner(lockPath);
        if (current && (await processDefinitelyGone(current))) {
          await this.reclaim(root, lockPath, current);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new GitError(
            `repository is busy: ${repositoryIdentity}`,
            "repo_busy",
            { details: ownerDetails(current) },
          );
        }
        await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
      }

      return await task();
    } finally {
      try {
        if (acquired) {
          const current = await readOwner(lockPath);
          if (current?.leaseId === leaseId) {
            try {
              await unlink(lockPath);
            } catch (error) {
              if (errorCode(error) !== "ENOENT") {
                throw new GitError(
                  "could not release repository lease",
                  "lease_unavailable",
                  { cause: error },
                );
              }
            }
          }
        }
      } finally {
        await rm(ownerPath, { force: true }).catch(() => undefined);
        await rm(temporaryOwnerPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async reclaim(
    root: string,
    lockPath: string,
    stale: RepositoryLeaseOwner,
  ): Promise<void> {
    const claimPath = path.join(root, `reclaim-${stale.leaseId}`);
    try {
      await mkdir(claimPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      return;
    }
    try {
      const current = await readOwner(lockPath);
      if (
        current?.leaseId === stale.leaseId &&
        (await processDefinitelyGone(current))
      ) {
        await unlink(lockPath).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") {
            throw error;
          }
        });
        await rm(path.join(root, "owners", `${stale.leaseId}.json`), {
          force: true,
        });
      }
    } finally {
      await rm(claimPath, { recursive: true, force: true });
    }
  }
}
