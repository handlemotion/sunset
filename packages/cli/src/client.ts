import { createClient, type SunsetClient } from "@sunset/api";
import { createHost, type Host } from "@sunset/host";
import type { HostCapabilities, Project, Workspace } from "@sunset/domain";

import type { ResolvedConfig } from "./config.js";
import { discoverServer } from "./server-discovery.js";

/**
 * Command backends.
 *
 * When `sunset serve` is running it owns the host lease on the state dir, so
 * commands must go through its HTTP API (`via === "server"`, `client` set).
 * With no server the CLI opens the host directly (`via === "host"`).
 * Long-lived conductor verbs — sessions, runs, attach — are server-only:
 * starting them in a short-lived CLI process would kill the run on exit.
 */

export type CreateWorkspaceInput = {
  slug: string;
  branch?: string;
  baseRef?: string;
  copyGlobs?: string[];
};

export type Backend = {
  readonly via: "server" | "host";
  /** The API client — present iff `via === "server"`. */
  readonly client: SunsetClient | null;
  capabilities(): Promise<HostCapabilities>;
  listProjects(): Promise<Project[]>;
  addProject(repoRoot: string): Promise<Project>;
  listWorkspaces(projectId: string): Promise<Workspace[]>;
  createWorkspace(
    projectId: string,
    input: CreateWorkspaceInput,
  ): Promise<Workspace>;
  close(): Promise<void>;
};

/** Returns an API client for the announced server, or null when none is live. */
export async function resolveClient(
  config: ResolvedConfig,
): Promise<SunsetClient | null> {
  const record = await discoverServer(config.stateDir);
  if (!record) return null;
  return createClient({ baseUrl: record.url, token: record.token });
}

function apiBackend(client: SunsetClient): Backend {
  return {
    via: "server",
    client,
    capabilities: () => client.capabilities(),
    listProjects: () => client.listProjects(),
    addProject: (repoRoot) => client.addProject(repoRoot),
    listWorkspaces: (projectId) => client.listWorkspaces(projectId),
    createWorkspace: (projectId, input) =>
      client.createWorkspace(projectId, input),
    close: () => Promise.resolve(),
  };
}

function hostBackend(host: Host): Backend {
  return {
    via: "host",
    client: null,
    capabilities: () => host.capabilities(),
    listProjects: () => Promise.resolve(host.projects.list()),
    addProject: (repoRoot) => host.projects.register(repoRoot),
    listWorkspaces: (projectId) =>
      Promise.resolve(host.workspaces.list({ projectId })),
    createWorkspace: (projectId, input) =>
      host.workspaces.create({ projectId, ...input }),
    close: () => host.close(),
  };
}

/**
 * Resolves the command backend: the live server's API when one is announced,
 * otherwise a directly opened host on the state dir.
 */
export async function resolveBackend(config: ResolvedConfig): Promise<Backend> {
  const client = await resolveClient(config);
  if (client) return apiBackend(client);
  const host = await createHost({
    stateDir: config.stateDir,
    worktreeRoot: config.worktreeRoot,
  });
  return hostBackend(host);
}
