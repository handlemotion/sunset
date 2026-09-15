#!/usr/bin/env node
import { Readable, Writable } from "node:stream";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { fakeAcpAgent, type FakeAcpAgentOptions } from "../fake-agent.js";

/**
 * Runs the fake ACP agent over real stdio so tests can exercise the spawned
 * process path (`stdioConnector`/`nodeSpawn`): process groups, the stderr
 * drain, and transport teardown.
 *
 * Usage: `node fake-agent.js '<json>'` where the argument is a JSON-serialized
 * `FakeAcpAgentOptions`. Error fields take strings instead of `Error`
 * instances; `"auth"` keeps its sentinel meaning on resume/load.
 */
function main(): void {
  const raw = process.argv[2];
  let options: FakeAcpAgentOptions = {};
  if (raw !== undefined) {
    try {
      options = JSON.parse(raw) as FakeAcpAgentOptions;
    } catch {
      process.stderr.write("fake-agent: argv[2] is not valid JSON\n");
      process.exit(2);
    }
  }
  const fake = fakeAcpAgent(options);
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const conn = fake.app().connect(stream);
  void conn.closed.then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

main();
