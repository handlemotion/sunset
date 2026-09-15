import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Server discovery.
 *
 * `sunset serve` announces itself by writing `<stateDir>/server.json` holding
 * the base URL, boot token, and owning pid. Other CLI invocations read that
 * record to reach the HTTP API instead of opening the state directory
 * directly (which would conflict with the server's host lease).
 *
 * A record is only honored while it is demonstrably live: the pid must exist
 * and the API must answer an authenticated probe. Dead pids and malformed
 * files are removed; a live pid whose probe fails is treated as absent but
 * left in place — it may be a server that is still starting up.
 */

export type ServerRecord = {
  url: string;
  token: string;
  pid: number;
  startedAt: number;
};

const DISCOVERY_FILENAME = "server.json";
const PROBE_TIMEOUT_MS = 1500;

export function serverRecordPath(stateDir: string): string {
  return path.join(stateDir, DISCOVERY_FILENAME);
}

function isServerRecord(value: unknown): value is ServerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ServerRecord>;
  return (
    typeof record.url === "string" &&
    record.url.length > 0 &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startedAt === "number"
  );
}

/** Reads and validates the discovery file. Returns null if absent/malformed. */
export async function readServerRecord(
  stateDir: string,
): Promise<ServerRecord | null> {
  let text: string;
  try {
    text = await readFile(serverRecordPath(stateDir), "utf8");
  } catch {
    return null;
  }
  try {
    const data: unknown = JSON.parse(text);
    return isServerRecord(data) ? data : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function drop(stateDir: string): Promise<void> {
  return rm(serverRecordPath(stateDir), { force: true }).then(
    () => undefined,
    () => undefined,
  );
}

export type DiscoverServerOptions = {
  /** Defaults to globalThis.fetch; injectable for tests. */
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
  /** Defaults to process.kill(pid, 0) probing; injectable for tests. */
  pidAlive?: (pid: number) => boolean;
};

/**
 * Returns the announced server record if a live server holds it, else null.
 * Liveness requires a live pid and an authenticated 200 from the API —
 * the pid check is cheap, the probe rules out pid reuse.
 */
export async function discoverServer(
  stateDir: string,
  options: DiscoverServerOptions = {},
): Promise<ServerRecord | null> {
  const record = await readServerRecord(stateDir);
  if (!record) {
    // Missing or malformed: clear any garbage so readers never parse it again.
    await drop(stateDir);
    return null;
  }
  const alive = options.pidAlive ?? pidAlive;
  if (!alive(record.pid)) {
    await drop(stateDir);
    return null;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(new URL("/api/capabilities", record.url), {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(options.probeTimeoutMs ?? PROBE_TIMEOUT_MS),
    });
    return response.ok ? record : null;
  } catch {
    return null;
  }
}

/**
 * Writes the discovery record for a running server. Returns a cleanup that
 * removes the file — but only while it still holds this process's record, so
 * a newer server that overwrote it is never clobbered.
 */
export async function announceServer(
  stateDir: string,
  server: { url: string; token: string },
): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true });
  const record: ServerRecord = {
    url: server.url,
    token: server.token,
    pid: process.pid,
    startedAt: Date.now(),
  };
  await writeFile(
    serverRecordPath(stateDir),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  let removed = false;
  return async () => {
    if (removed) return;
    removed = true;
    const existing = await readServerRecord(stateDir);
    if (existing && existing.pid !== process.pid) return;
    await drop(stateDir);
  };
}
