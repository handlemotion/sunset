/**
 * Persistent-box run lifecycle.
 *
 * One persistent Box serializes runs through the supervisor's flock. Each run
 * gets a fresh `tasks/<runId>/` workdir (untrusted, agent-writable) while
 * prompts, schemas, status, and artifacts live in `trusted/` outside it. A
 * run writes `trusted/<runId>/status.json` as its completion marker; the
 * marker file `trusted/run-<runId>.json` makes relaunch idempotent — a second
 * launch returns the live process instead of duplicating it.
 *
 * Lifted from Transitive's apps/sunset worker and re-scoped to generic
 * workspace execution.
 */
import { z } from "zod";

import type { BoxClient } from "./box.js";
import { supervisorScript } from "./supervisor.js";

export const RUN_ROOT = "/workspace/home/sunset";

const RUN_ID = /^[A-Za-z\d][A-Za-z\d_-]{0,127}$/u;
const FILE_NAME = /^[A-Za-z\d][A-Za-z\d._-]{0,127}$/u;

export type RunHandle = { boxId: string; processId: number };

/** A file written before the run launches. `task/…` lands in the per-run
 * workdir; `trusted/…` lands in the directory the agent profile denies. */
export type RunFile = {
  path: string;
  content: string;
  encoding?: "base64";
};

export type RunInspection =
  | { status: "running"; processId: number }
  | { status: "lost" }
  | {
      status: "finished";
      exitCode: number;
      failureCode?: "authentication" | "quota" | "agent_failed";
      artifacts: Record<string, string | null>;
    };

function safeRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error("invalid_run_id");
  return runId;
}

function filePath(root: string, runId: string, path: string): string {
  const base = path.startsWith("task/")
    ? `${root}/tasks/${runId}`
    : path.startsWith("trusted/")
      ? `${root}/trusted`
      : null;
  if (!base) throw new Error("run_file_scope_invalid");
  const rest = path.slice(path.indexOf("/") + 1);
  if (!rest || rest.split("/").includes("..")) {
    throw new Error("run_file_path_invalid");
  }
  return `${base}/${rest}`;
}

function markerPid(raw: string, runId: string): number {
  return z
    .object({ runId: z.literal(runId), pid: z.number().int().positive() })
    .parse(JSON.parse(raw)).pid;
}

/**
 * Launch a run under the supervisor. Idempotent per runId: when the marker
 * already exists, the recorded pid is returned without touching the box.
 * Launching a new run wipes the previous run's task dirs and markers under
 * the supervisor lock — one live run per box.
 */
export async function launchRun(
  box: BoxClient,
  input: {
    runId: string;
    deadlineAt: number;
    /** Task body run under the hard deadline; written to `task.sh`. */
    task: string;
    files?: RunFile[];
    /** `bash -lc` body run after files land, before the supervisor starts. */
    prepare?: string;
    root?: string;
  },
): Promise<RunHandle> {
  const runId = safeRunId(input.runId);
  const root = input.root ?? RUN_ROOT;
  if (Date.now() >= input.deadlineAt) throw new Error("run_deadline_expired");
  const task = `${root}/tasks/${runId}`;
  const trusted = `${root}/trusted`;
  // Scope-check every file before the first external transition.
  const files = (input.files ?? []).map((file) => ({
    ...file,
    fullPath: filePath(root, runId, file.path),
  }));

  const existingMarker = await box.read(`${trusted}/run-${runId}.json`);
  if (existingMarker) {
    return { boxId: box.id, processId: markerPid(existingMarker, runId) };
  }

  const cleaned = await box.exec([
    "bash",
    "-lc",
    `mkdir -p '${trusted}' '${root}/tasks'; exec 9>'${trusted}/process.lock'; flock -n 9 || exit 75; find '${root}/tasks' -mindepth 1 -maxdepth 1 -type d -exec rm -rf -- {} +; find '${trusted}' -maxdepth 1 -type f -name 'run-*.json' -delete`,
  ]);
  if (cleaned.exitCode !== 0) {
    throw new Error("box_previous_run_not_reconciled");
  }

  const dirs = new Set(
    files.map((file) => file.fullPath.slice(0, file.fullPath.lastIndexOf("/"))),
  );
  const made = await box.exec([
    "bash",
    "-lc",
    `rm -rf '${task}'; mkdir -p '${trusted}' '${task}'${[...dirs]
      .map((dir) => ` '${dir}'`)
      .join("")}`,
  ]);
  if (made.exitCode !== 0) throw new Error("box_run_setup_failed");

  await Promise.all([
    box.write(`${trusted}/supervisor.sh`, supervisorScript(root)),
    box.write(`${task}/task.sh`, input.task),
    ...files.map((file) =>
      box.write(file.fullPath, file.content, file.encoding),
    ),
  ]);

  const prepared = await box.exec([
    "bash",
    "-lc",
    `chmod 700 '${trusted}/supervisor.sh'${input.prepare ? `; ${input.prepare}` : ""}`,
  ]);
  if (prepared.exitCode !== 0) throw new Error("box_run_setup_failed");

  const launch = await box.exec([
    "bash",
    `${trusted}/supervisor.sh`,
    runId,
    String(Math.floor(input.deadlineAt / 1_000)),
  ]);
  if (launch.exitCode !== 0) throw new Error("box_process_launch_failed");
  return { boxId: box.id, processId: markerPid(launch.output, runId) };
}

/**
 * Poll a run. `artifacts` names files under `trusted/<runId>/` read once the
 * run finishes; `stderrArtifact` names the one used for failure
 * classification. A written status.json is not trusted while the supervisor
 * still holds the process lock, and a lost marker or pid is never restarted
 * from here — callers reconcile, they do not relaunch.
 */
export async function inspectRun(
  box: BoxClient,
  runId: string,
  options?: {
    artifacts?: string[];
    stderrArtifact?: string;
    root?: string;
  },
): Promise<RunInspection> {
  safeRunId(runId);
  const root = options?.root ?? RUN_ROOT;
  const trusted = `${root}/trusted`;
  const output = `${trusted}/${runId}`;
  const names = (options?.artifacts ?? []).map((name) => {
    if (!FILE_NAME.test(name) || name === ".." || name.includes("/")) {
      throw new Error("artifact_name_invalid");
    }
    return name;
  });

  const status = await box.read(`${output}/status.json`);
  if (!status) {
    const marker = await box.read(`${trusted}/run-${runId}.json`);
    if (!marker) return { status: "lost" };
    const pid = markerPid(marker, runId);
    const probe = await box.exec(["kill", "-0", String(pid)]);
    return probe.exitCode === 0
      ? { status: "running", processId: pid }
      : { status: "lost" };
  }

  const marker = await box.read(`${trusted}/run-${runId}.json`);
  if (!marker) return { status: "lost" };
  const pid = markerPid(marker, runId);
  const lock = await box.exec([
    "flock",
    "-n",
    `${trusted}/process.lock`,
    "true",
  ]);
  if (lock.exitCode === 1) return { status: "running", processId: pid };
  if (lock.exitCode !== 0) throw new Error("box_process_probe_failed");

  const { exitCode } = z
    .object({ exitCode: z.number().int() })
    .parse(JSON.parse(status));
  const artifacts = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await box.read(`${output}/${name}`)]),
    ),
  );
  const stderr =
    options?.stderrArtifact !== undefined
      ? (artifacts[options.stderrArtifact] ?? "")
      : "";
  const failureCode =
    exitCode === 0
      ? undefined
      : /(?:login|authentication|unauthorized|token.*(?:expired|revoked))/iu.test(
            stderr,
          )
        ? "authentication"
        : /(?:quota|usage limit|rate limit)/iu.test(stderr)
          ? "quota"
          : "agent_failed";
  return { status: "finished", exitCode, failureCode, artifacts };
}

/**
 * Terminate the run's process group: TERM, a short grace, then KILL if the
 * pgid survives. Returns false when the group could not be confirmed dead.
 */
export async function terminateRun(
  box: BoxClient,
  processId: number,
): Promise<boolean> {
  await box.exec(["kill", "-TERM", `-${processId}`]);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const stopped = async () => {
    const probe = await box.exec(["ps", "-eo", "pgid="]);
    if (probe.exitCode !== 0) throw new Error("box_process_probe_failed");
    return !probe.output.trim().split(/\s+/u).includes(String(processId));
  };
  if (await stopped()) return true;
  await box.exec(["kill", "-KILL", `-${processId}`]);
  return stopped();
}

/** Locate a live run by its marker without launching anything. */
export async function findRun(
  box: BoxClient,
  runId: string,
  options?: { root?: string },
): Promise<RunHandle | null> {
  safeRunId(runId);
  const marker = await box.read(
    `${options?.root ?? RUN_ROOT}/trusted/run-${runId}.json`,
  );
  if (!marker) return null;
  return { boxId: box.id, processId: markerPid(marker, runId) };
}
