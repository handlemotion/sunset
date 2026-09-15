import type {
  HostCapabilities,
  HostEvent,
  Project,
  Run,
  RunResult,
  Session,
  Workspace,
} from "@sunset/domain";

import { attachRunEvents, type AttachRunOptions } from "./attach.js";
import {
  routes,
  type AddProjectResponse,
  type ArchiveWorkspaceRequest,
  type CommitWorkspaceRequest,
  type CommitWorkspaceResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type GetRunResponse,
  type GetWorkspaceDiffResponse,
  type GetWorkspaceResponse,
  type ListOperationsResponse,
  type ListProjectsResponse,
  type ListRunsResponse,
  type ListSessionsResponse,
  type ListWorkspacesResponse,
  type ProjectReconciliation,
  type SendResponse,
  type WorkspaceOperation,
} from "./contract.js";

/** HTTP failure. Carries the server's status code, error code, and message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type SunsetClientOptions = {
  /** Server origin, e.g. `http://127.0.0.1:8123`. */
  baseUrl: string;
  /** Boot token. Sent as `Authorization: Bearer` for HTTP and `?token=` for WS. */
  token?: string;
};

export type SunsetClient = ReturnType<typeof createClient>;

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/:([a-zA-Z]+)/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`missing path parameter: ${name}`);
    }
    return encodeURIComponent(value);
  });
}

export function createClient(options: SunsetClientOptions) {
  const base = new URL(options.baseUrl);
  const token = options.token;

  async function request<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const fetchImpl = globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("fetch is not available in this environment");
    }
    const headers: Record<string, string> = {};
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(new URL(path, base), {
      method: init?.method ?? "GET",
      headers,
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      throw new ApiError(
        response.status,
        typeof body?.error?.code === "string" ? body.error.code : "unknown",
        typeof body?.error?.message === "string"
          ? body.error.message
          : `request failed with status ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  function get<T>(template: string, params?: Record<string, string>) {
    return request<T>(interpolate(template, params ?? {}));
  }

  function post<T>(
    template: string,
    params: Record<string, string>,
    body: unknown,
  ) {
    return request<T>(interpolate(template, params), {
      method: "POST",
      body,
    });
  }

  function eventsUrl(runId: string, after: number): string {
    const url = new URL(interpolate(routes.runEvents.path, { runId }), base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (token !== undefined) url.searchParams.set("token", token);
    url.searchParams.set("after", String(after));
    return url.toString();
  }

  const client = {
    capabilities: () => get<HostCapabilities>(routes.capabilities.path),

    listProjects: async () =>
      (await get<ListProjectsResponse>(routes.listProjects.path)).projects,

    addProject: (repoRoot: string) =>
      post<AddProjectResponse>(routes.addProject.path, {}, { repoRoot }),

    listWorkspaces: async (projectId: string) =>
      (
        await get<ListWorkspacesResponse>(routes.listWorkspaces.path, {
          projectId,
        })
      ).workspaces,

    createWorkspace: (projectId: string, input: CreateWorkspaceRequest) =>
      post<CreateWorkspaceResponse>(
        routes.createWorkspace.path,
        { projectId },
        input,
      ),

    reconcileProject: (projectId: string) =>
      get<ProjectReconciliation>(routes.reconcileProject.path, { projectId }),

    getWorkspace: (workspaceId: string) =>
      get<GetWorkspaceResponse>(routes.getWorkspace.path, { workspaceId }),

    archiveWorkspace: (
      workspaceId: string,
      input: ArchiveWorkspaceRequest = {},
    ) => post<Workspace>(routes.archiveWorkspace.path, { workspaceId }, input),

    workspaceDiff: (workspaceId: string, baseRef?: string) =>
      get<GetWorkspaceDiffResponse>(
        baseRef === undefined
          ? routes.getWorkspaceDiff.path
          : `${routes.getWorkspaceDiff.path}?base=${encodeURIComponent(baseRef)}`,
        { workspaceId },
      ),

    workspaceCommit: (workspaceId: string, input: CommitWorkspaceRequest) =>
      post<CommitWorkspaceResponse>(
        routes.commitWorkspace.path,
        { workspaceId },
        input,
      ),

    listSessions: async (workspaceId: string) =>
      (
        await get<ListSessionsResponse>(routes.listSessions.path, {
          workspaceId,
        })
      ).sessions,

    createSession: (workspaceId: string, input: CreateSessionRequest) =>
      post<CreateSessionResponse>(
        routes.createSession.path,
        { workspaceId },
        input,
      ),

    send: (sessionId: string, prompt: string) =>
      post<SendResponse>(routes.send.path, { sessionId }, { prompt }),

    listRuns: async (sessionId: string) =>
      (await get<ListRunsResponse>(routes.listRuns.path, { sessionId })).runs,

    getRun: (runId: string) =>
      get<GetRunResponse>(routes.getRun.path, { runId }),

    cancelRun: (runId: string) =>
      post<RunResult>(routes.cancelRun.path, { runId }, {}),

    waitRun: (runId: string) => get<RunResult>(routes.waitRun.path, { runId }),

    listOperations: async () =>
      (await get<ListOperationsResponse>(routes.listOperations.path))
        .operations,

    attachRun: (
      runId: string,
      attachOptions?: AttachRunOptions,
    ): AsyncIterable<HostEvent> =>
      attachRunEvents(
        { eventsUrl, getRun: (id) => client.getRun(id) },
        runId,
        attachOptions,
      ),
  };

  return client;
}
