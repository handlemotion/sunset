import type {
  HostCapabilities,
  HostEvent,
  Project,
  Run,
  RunResult,
  Session,
  Workspace,
} from "./types";

export type WorktreeDiff = {
  worktreePath: string;
  head: string;
  diff: string;
  stat: string;
};

export type WorktreeCommit = {
  commit: string;
  summary: string;
};

const params = new URLSearchParams(window.location.search);
const token =
  params.get("token") ?? window.localStorage.getItem("sunset.token");
if (params.get("token")) {
  window.localStorage.setItem("sunset.token", params.get("token")!);
  params.delete("token");
  const url = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
  window.history.replaceState(null, "", url);
}

export function getToken(): string | null {
  return token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token ?? ""}`,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new Error(
      body?.error?.message ?? `request failed: ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  capabilities: () => request<HostCapabilities>("/api/capabilities"),
  listProjects: () =>
    request<{ projects: Project[] }>("/api/projects").then((r) => r.projects),
  addProject: (repoRoot: string) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ repoRoot }),
    }),
  listWorkspaces: (projectId: string) =>
    request<{ workspaces: Workspace[] }>(
      `/api/projects/${projectId}/workspaces`,
    ).then((r) => r.workspaces),
  createWorkspace: (projectId: string, slug: string) =>
    request<Workspace>(`/api/projects/${projectId}/workspaces`, {
      method: "POST",
      body: JSON.stringify({ slug }),
    }),
  archiveWorkspace: (workspaceId: string) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/archive`, {
      method: "POST",
      body: JSON.stringify({ keepBranch: true }),
    }),
  workspaceDiff: (workspaceId: string, baseRef?: string) =>
    request<WorktreeDiff>(
      `/api/workspaces/${workspaceId}/diff${baseRef ? `?base=${encodeURIComponent(baseRef)}` : ""}`,
    ),
  commitWorkspace: (workspaceId: string, message: string) =>
    request<WorktreeCommit>(`/api/workspaces/${workspaceId}/commit`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  listSessions: (workspaceId: string) =>
    request<{ sessions: Session[] }>(
      `/api/workspaces/${workspaceId}/sessions`,
    ).then((r) => r.sessions),
  createSession: (
    workspaceId: string,
    input: {
      prompt: string;
      engine?: string;
      location?: string;
      mode?: string;
      model?: { id: string; params: { id: string; value: string }[] };
    },
  ) =>
    request<{ session: Session; run: Run }>(
      `/api/workspaces/${workspaceId}/sessions`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  send: (sessionId: string, prompt: string) =>
    request<{ session: Session; run: Run }>(`/api/sessions/${sessionId}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  listRuns: (sessionId: string) =>
    request<{ runs: Run[] }>(`/api/sessions/${sessionId}/runs`).then(
      (r) => r.runs,
    ),
  cancelRun: (runId: string) =>
    request<RunResult>(`/api/runs/${runId}/cancel`, { method: "POST" }),
};

export function runEvents(
  runId: string,
  afterSequence: number,
  onEvent: (event: HostEvent) => void,
  onClose: () => void,
): () => void {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${proto}//${window.location.host}/api/runs/${runId}/events?token=${token}&after=${afterSequence}`,
  );
  ws.onmessage = (message) => {
    onEvent(JSON.parse(String(message.data)) as HostEvent);
  };
  ws.onclose = () => onClose();
  ws.onerror = () => ws.close();
  return () => ws.close();
}
