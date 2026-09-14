// Minimal ACP agent over ndjson stdio for cloud contract tests.
// Flags: --fail-init | --crash-on-prompt | --exit-after-prompt | --fragment |
//        --emoji | --reject-resume | --codex-models | --prompt-delay=<ms> |
//        --model=<id>
// Every request method is logged to stderr as `saw:<method>:<sessionId>` so
// tests can verify what the remote agent actually received.
import readline from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const prefix = `--${name}=`;
  const direct = args.find((a) => a.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const model = value("model");
const promptDelay = Number(value("prompt-delay") ?? 0);

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
// Split the JSON line's bytes mid-codepoint to exercise the worker's
// streaming UTF-8 decode across fragmented stdout chunks.
const sendFragmented = (msg) => {
  const bytes = Buffer.from(JSON.stringify(msg) + "\n", "utf8");
  const at = bytes.indexOf(0xf0); // first byte of the 4-byte emoji
  const k = at > 0 ? at + 1 : Math.floor(bytes.length / 2);
  process.stdout.write(bytes.subarray(0, k));
  setImmediate(() => process.stdout.write(bytes.subarray(k)));
};

if (flag("fail-init")) process.exit(1);

const replyPrompt = (msg, text) => {
  const update = {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: msg.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
  const result = {
    jsonrpc: "2.0",
    id: msg.id,
    result: { stopReason: "end_turn" },
  };
  const finish = () => {
    send(result);
    if (flag("exit-after-prompt")) process.exit(0);
  };
  if (flag("fragment")) {
    // The result must not interleave between the update's two byte halves.
    sendFragmented(update);
    setTimeout(finish, 10);
    return;
  }
  send(update);
  finish();
};

readline
  .createInterface({ input: process.stdin, terminal: false })
  .on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // notification
    process.stderr.write(
      `saw:${msg.method}:${msg.params?.modelId ?? msg.params?.sessionId ?? "-"}\n`,
    );
    switch (msg.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [],
          },
        });
        return;
      case "session/new":
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            sessionId: "sess-fake",
            models: flag("codex-models")
              ? {
                  availableModels: [
                    {
                      modelId: "fake-slug[medium]",
                      name: "Fake Slug (medium)",
                    },
                    { modelId: "fake-slug[high]", name: "Fake Slug (high)" },
                  ],
                  currentModelId: "fake-slug[high]",
                }
              : {
                  availableModels: [
                    { modelId: "fake-model", name: "Fake Model" },
                  ],
                  currentModelId: "fake-model",
                },
          },
        });
        return;
      case "session/resume":
      case "session/load":
        if (flag("reject-resume")) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: "unknown_session" },
          });
          return;
        }
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      case "session/set_model":
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      case "session/prompt": {
        if (flag("crash-on-prompt")) process.exit(2);
        const text = msg.params?.prompt?.[0]?.text ?? "";
        const echo = `echo:${flag("emoji") ? "👋:" : ""}${text}${model ? ` model:${model}` : ""}`;
        if (promptDelay > 0) {
          setTimeout(() => replyPrompt(msg, echo), promptDelay);
        } else {
          replyPrompt(msg, echo);
        }
        return;
      }
      default:
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  });
