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

import { HostError } from "./errors.js";

const execFileAsync = promisify(execFile);
const POLL_MS = 25;

type HostLeaseOwner = {
  schemaVersion: 1;
  leaseId: string;
  stateDir: string;
  pid: number;
  hostname: string;
  processStartFingerprint: string;
  acquiredAt: number;
};

export type HostLease = { release: () => Promise<void> };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

function isOwner(value: unknown): value is HostLeaseOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<HostLeaseOwner>;
  return (
    owner.schemaVersion === 1 &&
    typeof owner.leaseId === "string" &&
    typeof owner.stateDir === "string" &&
    typeof owner.pid === "number" &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.hostname === "string" &&
    typeof owner.processStartFingerprint === "string" &&
    owner.processStartFingerprint.length > 0 &&
    typeof owner.acquiredAt === "number"
  );
}

async function fingerprint(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const fields = stat.slice(commandEnd + 2).split(" ");
      const started = fields[19];
      if (started) return `linux:${started}`;
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

async function ownerDefinitelyGone(owner: HostLeaseOwner): Promise<boolean> {
  if (owner.hostname !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
  const current = await fingerprint(owner.pid);
  return current !== undefined && current !== owner.processStartFingerprint;
}

async function readOwner(
  lockPath: string,
): Promise<HostLeaseOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    return isOwner(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function reclaim(
  lockRoot: string,
  lockPath: string,
  stale: HostLeaseOwner,
): Promise<void> {
  const claimPath = path.join(lockRoot, `reclaim-${stale.leaseId}`);
  try {
    await mkdir(claimPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return;
    throw error;
  }
  try {
    const current = await readOwner(lockPath);
    if (
      current?.leaseId === stale.leaseId &&
      (await ownerDefinitelyGone(current))
    ) {
      await unlink(lockPath).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
      await rm(path.join(lockRoot, "owners", `${stale.leaseId}.json`), {
        force: true,
      });
    }
  } finally {
    await rm(claimPath, { recursive: true, force: true });
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireHostLease(
  stateDir: string,
  timeoutMs: number,
): Promise<HostLease> {
  const lockRoot = path.join(stateDir, ".sunset-locks");
  const owners = path.join(lockRoot, "owners");
  const lockPath = path.join(lockRoot, "host.lock");
  await mkdir(owners, { recursive: true });

  const leaseId = randomUUID();
  const ownerPath = path.join(owners, `${leaseId}.json`);
  const temporaryOwnerPath = `${ownerPath}.${process.pid}.tmp`;
  const processStartFingerprint = await fingerprint(process.pid);
  if (!processStartFingerprint) {
    throw new HostError(
      "could not determine the current Host process identity",
      "host_lease_unavailable",
    );
  }
  const owner: HostLeaseOwner = {
    schemaVersion: 1,
    leaseId,
    stateDir,
    pid: process.pid,
    hostname: os.hostname(),
    processStartFingerprint,
    acquiredAt: Date.now(),
  };

  let acquired = false;
  try {
    await writeFile(temporaryOwnerPath, `${JSON.stringify(owner)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryOwnerPath, ownerPath);

    const deadline = Date.now() + timeoutMs;
    while (!acquired) {
      try {
        await link(ownerPath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new HostError(
            "could not acquire the Host state lease",
            "host_lease_unavailable",
            { cause: error },
          );
        }
      }

      const current = await readOwner(lockPath);
      if (current && (await ownerDefinitelyGone(current))) {
        await reclaim(lockRoot, lockPath, current);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new HostError(
          `state directory is already owned by another Host: ${stateDir}`,
          "host_busy",
        );
      }
      await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    }
  } catch (error) {
    await rm(ownerPath, { force: true }).catch(() => undefined);
    await rm(temporaryOwnerPath, { force: true }).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        const current = await readOwner(lockPath);
        if (current?.leaseId === leaseId) {
          await unlink(lockPath).catch((error: unknown) => {
            if (errorCode(error) !== "ENOENT") {
              throw new HostError(
                "could not release the Host state lease",
                "host_lease_unavailable",
                { cause: error },
              );
            }
          });
        }
      } finally {
        await rm(ownerPath, { force: true }).catch(() => undefined);
        await rm(temporaryOwnerPath, { force: true }).catch(() => undefined);
      }
    },
  };
}
