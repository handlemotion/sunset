import { fileURLToPath } from "node:url";

import type {
  FakeAcpAgentOptions,
  FakeAcpAuthenticate,
  FakeAcpPrompt,
} from "./fake-agent.js";

/**
 * JSON-serializable subset of `FakeAcpAgentOptions` for the spawned fake
 * agent: Error fields take message strings (resume/load keep the `"auth"`
 * sentinel).
 */
export type FakeAcpSpawnOptions = Omit<
  FakeAcpAgentOptions,
  "authenticate" | "prompt" | "resume" | "load"
> & {
  authenticate?: Omit<FakeAcpAuthenticate, "error"> & { error?: string };
  prompt?: Omit<FakeAcpPrompt, "error"> & { error?: string };
  resume?: { error?: string };
  load?: { error?: string };
};

/** Absolute path to the compiled stdio entrypoint (dist/bin/fake-agent.js). */
export function fakeAgentBinPath(): string {
  return fileURLToPath(new URL("./bin/fake-agent.js", import.meta.url));
}

/**
 * `{command, args}` that spawn the fake agent as a real child process,
 * suitable for `stdioConnector(...)` or `nodeSpawn(...)`.
 */
export function fakeAgentSpawn(options: FakeAcpSpawnOptions = {}): {
  command: string;
  args: string[];
} {
  return {
    command: process.execPath,
    args: [fakeAgentBinPath(), JSON.stringify(options)],
  };
}
