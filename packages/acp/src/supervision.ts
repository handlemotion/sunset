import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type EngineGroupMarker = {
  schemaVersion: 1;
  host: { pid: number; start: string };
  leader: { pid: number; start: string };
};

// Same start identity as the host lease fingerprint: /proc starttime on
// Linux, `ps lstart` elsewhere. An empty start degrades a marker to
// removal-only and never to a kill.
function startIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const started = stat.slice(commandEnd + 2).split(" ")[19];
      if (started) return `linux:${started}`;
    } catch {
      return undefined;
    }
  }
  try {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const output = result.stdout;
    const started = typeof output === "string" ? output.trim() : "";
    return started ? `${process.platform}:${started}` : undefined;
  } catch {
    return undefined;
  }
}

function markerPath(dir: string, leaderPid: number): string {
  return path.join(dir, `${leaderPid}.json`);
}

function removeMarker(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Marker cleanup is best-effort; startup must not fail on an undeletable entry.
  }
}

function isMarker(value: unknown): value is EngineGroupMarker {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as {
    schemaVersion?: unknown;
    host?: { pid?: unknown; start?: unknown };
    leader?: { pid?: unknown; start?: unknown };
  };
  return (
    marker.schemaVersion === 1 &&
    typeof marker.host?.pid === "number" &&
    Number.isInteger(marker.host.pid) &&
    marker.host.pid > 0 &&
    typeof marker.host.start === "string" &&
    typeof marker.leader?.pid === "number" &&
    Number.isInteger(marker.leader.pid) &&
    marker.leader.pid > 0 &&
    typeof marker.leader.start === "string"
  );
}

/**
 * Records a detached engine process group under the host state directory.
 * Returns an idempotent removal callback for when the group exits.
 */
export function trackEngineGroup(dir: string, leaderPid: number): () => void {
  const file = markerPath(dir, leaderPid);
  try {
    mkdirSync(dir, { recursive: true });
    const marker: EngineGroupMarker = {
      schemaVersion: 1,
      host: { pid: process.pid, start: startIdentity(process.pid) ?? "" },
      leader: { pid: leaderPid, start: startIdentity(leaderPid) ?? "" },
    };
    writeFileSync(file, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  } catch {
    return () => undefined;
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    try {
      rmSync(file, { force: true });
    } catch {
      // Marker cleanup is best-effort; a stale marker is reaped at startup.
    }
  };
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

/**
 * Scans the marker directory and kills detached groups orphaned by a dead
 * host. A group is only killed when the recorded host identity is gone or
 * verifiably reused and the current group-leader identity still matches the
 * recording, which keeps PID reuse from killing an unrelated process. Markers
 * for live hosts are preserved while their recorded leader still matches, and
 * stale or unverifiable markers are removed without ever killing.
 */
export function reapOrphanedEngineGroups(dir: string): void {
  if (process.platform === "win32") return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let marker: EngineGroupMarker | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isMarker(parsed)) marker = parsed;
    } catch {
      // An unreadable marker is stale.
    }
    if (!marker || marker.host.start === "" || marker.leader.start === "") {
      removeMarker(file);
      continue;
    }
    const hostNow = startIdentity(marker.host.pid);
    const leaderNow = startIdentity(marker.leader.pid);
    if (hostNow === marker.host.start) {
      // The recorded host is live: preserve only a verifiably matching group;
      // a dead or reused leader leaves a stale marker that is removed, never
      // killed.
      if (leaderNow === marker.leader.start) continue;
      removeMarker(file);
      continue;
    }
    const hostGone = hostNow !== undefined || pidGone(marker.host.pid);
    if (hostGone && leaderNow === marker.leader.start) {
      try {
        process.kill(-marker.leader.pid, "SIGKILL");
      } catch {
        // The group already exited.
      }
    }
    removeMarker(file);
  }
}
