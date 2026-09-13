import { useEffect, useRef, useState } from "react";

import { api, runEvents } from "./api";
import type {
  AgentEvent,
  EngineCapabilities,
  HostEvent,
  Run,
  Session,
  Workspace,
} from "./types";

type Props = {
  workspace: Workspace;
  session: Session | null;
  engines: EngineCapabilities[];
  onSessionCreated: (session: Session) => void;
};

function EventList({ events }: { events: HostEvent[] }) {
  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => (event.type === "text_delta" ? event.text : ""))
    .join("");
  const thoughts = events
    .filter((event) => event.type === "thought_delta")
    .map((event) => (event.type === "thought_delta" ? event.text : ""))
    .join("");
  const tools = events.filter(
    (event) => event.type === "tool_call" || event.type === "tool_result",
  );
  const plans = events.filter((event) => event.type === "plan");
  const errors = events.filter((event) => event.type === "error");

  return (
    <div className="space-y-2">
      {thoughts && (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer">thinking</summary>
          <pre className="mt-1 whitespace-pre-wrap">{thoughts}</pre>
        </details>
      )}
      {plans.map((event, index) =>
        event.type === "plan" ? (
          <div
            key={`plan-${index}`}
            className="rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs"
          >
            {event.entries.map((entry, entryIndex) => (
              <div key={entryIndex} className="flex gap-2">
                <span className="text-neutral-500">[{entry.status}]</span>
                <span>{entry.content}</span>
              </div>
            ))}
          </div>
        ) : null,
      )}
      {tools.map((event, index) => (
        <div
          key={`tool-${index}`}
          className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-[11px] text-neutral-400"
        >
          {event.type === "tool_call" ? `▸ ${event.name}` : `✓ ${event.name}`}
        </div>
      ))}
      {text && (
        <div className="whitespace-pre-wrap text-sm leading-6 text-neutral-200">
          {text}
        </div>
      )}
      {errors.map((event, index) => (
        <div key={`err-${index}`} className="text-xs text-red-400">
          {event.type === "error" ? event.message : ""}
        </div>
      ))}
    </div>
  );
}

function RunView({ run }: { run: Run }) {
  const [events, setEvents] = useState<HostEvent[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const close = runEvents(
      run.id,
      0,
      (event) => setEvents((value) => [...value, event]),
      () => setDone(true),
    );
    return close;
  }, [run.id]);

  return (
    <div className="space-y-2">
      <EventList events={events} />
      {!done && run.status !== "finished" && (
        <div className="text-[11px] text-neutral-600">running…</div>
      )}
      {(run.status === "cancelled" || run.status === "error") && (
        <div className="text-[11px] text-neutral-500">run {run.status}</div>
      )}
    </div>
  );
}

export function SessionView(props: Props) {
  const { session, workspace, engines } = props;
  const [runs, setRuns] = useState<Run[]>([]);
  const [prompt, setPrompt] = useState("");
  const [engineId, setEngineId] = useState(session?.engine ?? "devin");
  const [modelId, setModelId] = useState(session?.model.id ?? "");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) return setRuns([]);
    void api.listRuns(session.id).then(setRuns);
  }, [session]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [runs]);

  const engine = engines.find((entry) => entry.id === engineId);
  const models = engine?.models ?? [];
  const selectedModel = modelId || models[0]?.id || "";

  async function submit() {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      if (!session) {
        const { session: created, run } = await api.createSession(
          workspace.id,
          {
            prompt: text,
            engine: engineId,
            ...(selectedModel
              ? { model: { id: selectedModel, params: [] } }
              : {}),
          },
        );
        props.onSessionCreated(created);
        setRuns([run]);
      } else {
        const { run } = await api.send(session.id, text);
        setRuns((value) => [...value, run]);
      }
      setPrompt("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2">
        <span className="text-xs text-neutral-400">{workspace.branch}</span>
        {session ? (
          <span className="text-xs text-neutral-600">
            {session.engine} · {session.model.id}
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={engineId}
              onChange={(event) => {
                setEngineId(event.target.value as typeof engineId);
                setModelId("");
              }}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
            >
              {engines.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id}
                </option>
              ))}
            </select>
            <select
              value={selectedModel}
              onChange={(event) => setModelId(event.target.value)}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex-1" />
        {runs.length > 0 && runs[runs.length - 1]?.status === "running" && (
          <button
            onClick={() => void api.cancelRun(runs[runs.length - 1]!.id)}
            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:text-red-400"
          >
            Cancel run
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {runs.map((run) => (
          <RunView key={run.id} run={run} />
        ))}
        <div ref={bottomRef} />
      </div>
      <form
        className="border-t border-neutral-800 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={session ? "Send a follow-up…" : "Describe the task…"}
            className="min-w-0 flex-1 resize-none rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
          <button
            disabled={busy || !prompt.trim()}
            className="self-end rounded bg-neutral-200 px-4 py-2 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
