import type { SunsetClient } from "@sunset/api";
import type { AgentMode, ModelSelection, Run, Session } from "@sunset/domain";

import type { ResolvedConfig } from "./config.js";
import { modelSelection } from "./session-defaults.js";

/**
 * Server-only conductor verbs. These run against the API client discovered
 * via server.json — never against a directly opened host, because runs are
 * long-lived and must outlive this CLI process.
 */

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export type SessionRun = { session: Session; run: Run };

/** `sunset sessions create` — applies the CLI's engine/model defaults. */
export async function createSession(
  client: SunsetClient,
  config: ResolvedConfig,
  input: { workspaceId: string; prompt: string; mode?: AgentMode },
): Promise<SessionRun> {
  const engine = config.defaultEngine;
  let model: ModelSelection | undefined;
  if (config.defaultModel) {
    try {
      model = modelSelection(
        await client.capabilities(),
        engine ?? "devin",
        config.defaultModel,
      );
    } catch {
      model = { id: config.defaultModel, params: [] };
    }
  }
  return client.createSession(input.workspaceId, {
    prompt: input.prompt,
    ...(engine ? { engine } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(model ? { model } : {}),
  });
}

/** `sunset send` — a follow-up prompt on an existing session. */
export function sendPrompt(
  client: SunsetClient,
  sessionId: string,
  prompt: string,
): Promise<SessionRun> {
  return client.send(sessionId, prompt);
}

/**
 * `sunset attach` — writes each run event as one NDJSON line, then returns
 * the final run record so the caller can pick the exit code.
 */
export async function attachRunNdjson(
  client: SunsetClient,
  runId: string,
  options: { after?: number },
  write: (line: string) => void,
): Promise<Run | null> {
  for await (const event of client.attachRun(runId, {
    after: options.after,
  })) {
    write(JSON.stringify(event));
  }
  return client.getRun(runId);
}

/** Exit code for a terminal run status: only `finished` succeeds. */
export function runExitCode(status: Run["status"] | "missing"): number {
  return status === "finished" ? 0 : 1;
}
