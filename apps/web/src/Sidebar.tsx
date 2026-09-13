import { useState } from "react";

import type { Project, Session, Workspace } from "./types";

type Props = {
  projects: Project[];
  project: Project | null;
  workspaces: Workspace[];
  workspace: Workspace | null;
  sessions: Session[];
  session: Session | null;
  onSelectProject: (project: Project) => void;
  onSelectWorkspace: (workspace: Workspace) => void;
  onSelectSession: (session: Session | null) => void;
  onAddProject: (repoRoot: string) => Promise<void>;
  onCreateWorkspace: (slug: string) => Promise<void>;
  onArchiveWorkspace: () => Promise<void>;
};

export function Sidebar(props: Props) {
  const [repoInput, setRepoInput] = useState("");
  const [slugInput, setSlugInput] = useState("");

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-925">
      <div className="border-b border-neutral-800 px-4 py-3 text-sm font-semibold tracking-wide text-neutral-100">
        Sunset
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Projects
        </div>
        {props.projects.map((project) => (
          <button
            key={project.id}
            onClick={() => props.onSelectProject(project)}
            className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${
              props.project?.id === project.id
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900"
            }`}
            title={project.repoRoot}
          >
            {project.repoRoot.split("/").pop()}
          </button>
        ))}
        <form
          className="mt-1 flex gap-1 px-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (repoInput.trim()) {
              void props.onAddProject(repoInput.trim());
              setRepoInput("");
            }
          }}
        >
          <input
            value={repoInput}
            onChange={(event) => setRepoInput(event.target.value)}
            placeholder="/path/to/repo"
            className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
          <button className="rounded border border-neutral-800 px-2 text-xs text-neutral-400 hover:bg-neutral-800">
            +
          </button>
        </form>

        {props.project && (
          <>
            <div className="mt-4 flex items-center justify-between px-2 pb-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                Workspaces
              </span>
            </div>
            {props.workspaces.map((workspace) => (
              <button
                key={workspace.id}
                onClick={() => props.onSelectWorkspace(workspace)}
                className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                  props.workspace?.id === workspace.id
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900"
                }`}
              >
                {workspace.slug}
                <span className="ml-1 text-neutral-600">
                  {workspace.branch}
                </span>
              </button>
            ))}
            <form
              className="mt-1 flex gap-1 px-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (slugInput.trim()) {
                  void props.onCreateWorkspace(slugInput.trim());
                  setSlugInput("");
                }
              }}
            >
              <input
                value={slugInput}
                onChange={(event) => setSlugInput(event.target.value)}
                placeholder="new workspace slug"
                className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
              />
              <button className="rounded border border-neutral-800 px-2 text-xs text-neutral-400 hover:bg-neutral-800">
                +
              </button>
            </form>
          </>
        )}

        {props.workspace && (
          <>
            <div className="mt-4 flex items-center justify-between px-2 pb-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                Sessions
              </span>
              <button
                onClick={() => props.onSelectSession(null)}
                className="text-[10px] text-neutral-500 hover:text-neutral-300"
              >
                new
              </button>
            </div>
            {props.sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => props.onSelectSession(session)}
                className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                  props.session?.id === session.id
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900"
                }`}
              >
                {session.engine} · {session.model.id}
              </button>
            ))}
          </>
        )}
      </div>
      {props.workspace && (
        <div className="border-t border-neutral-800 p-2">
          <button
            onClick={() => void props.onArchiveWorkspace()}
            className="w-full rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 hover:border-red-900 hover:text-red-400"
          >
            Archive workspace
          </button>
        </div>
      )}
    </aside>
  );
}
