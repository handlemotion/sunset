import { useCallback, useEffect, useState } from "react";

import { api, getToken } from "./api";
import { SessionView } from "./SessionView";
import { Sidebar } from "./Sidebar";
import type { EngineCapabilities, Project, Session, Workspace } from "./types";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [engines, setEngines] = useState<EngineCapabilities[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
      setEngines((await api.capabilities()).engines);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to connect");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!project) return setWorkspaces([]);
    void api
      .listWorkspaces(project.id)
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, [project]);

  useEffect(() => {
    if (!workspace) return setSessions([]);
    void api
      .listSessions(workspace.id)
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [workspace]);

  if (!getToken()) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="max-w-sm text-center text-sm text-neutral-400">
          <p className="mb-2 text-lg text-neutral-200">Sunset</p>
          <p>
            Start the local server with{" "}
            <code className="text-neutral-300">sunset open</code> and open the
            printed URL — it carries your boot token.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar
        projects={projects}
        project={project}
        workspaces={workspaces}
        workspace={workspace}
        sessions={sessions}
        session={session}
        onSelectProject={setProject}
        onSelectWorkspace={setWorkspace}
        onSelectSession={setSession}
        onAddProject={async (repoRoot) => {
          const created = await api.addProject(repoRoot);
          setProject(created);
          await refresh();
        }}
        onCreateWorkspace={async (slug) => {
          if (!project) return;
          const created = await api.createWorkspace(project.id, slug);
          setWorkspaces((value) => [...value, created]);
          setWorkspace(created);
        }}
        onArchiveWorkspace={async () => {
          if (!workspace) return;
          await api.archiveWorkspace(workspace.id);
          setWorkspace(null);
          if (project) setWorkspaces(await api.listWorkspaces(project.id));
        }}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        {workspace ? (
          <SessionView
            key={session?.id ?? `new:${workspace.id}`}
            workspace={workspace}
            session={session}
            engines={engines}
            onSessionCreated={(created) => {
              setSessions((value) => [...value, created]);
              setSession(created);
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
            Select or create a workspace to start.
          </div>
        )}
      </main>
    </div>
  );
}
