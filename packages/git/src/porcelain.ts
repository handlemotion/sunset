import type { GitWorktree } from "./types.js";

export function parseWorktreePorcelain(stdout: string): GitWorktree[] {
  const blocks = stdout
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);
  const worktrees: GitWorktree[] = [];
  for (const block of blocks) {
    let pathValue: string | undefined;
    let head = "";
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked: string | null = null;
    let prunable: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        pathValue = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        branch = null;
        detached = true;
      } else if (line === "locked") {
        locked = "";
      } else if (line.startsWith("locked ")) {
        locked = line.slice("locked ".length);
      } else if (line === "prunable") {
        prunable = "";
      } else if (line.startsWith("prunable ")) {
        prunable = line.slice("prunable ".length);
      }
    }
    if (pathValue !== undefined) {
      worktrees.push({
        path: pathValue,
        pathExists: true,
        head,
        branch,
        detached,
        bare,
        locked,
        prunable,
      });
    }
  }
  return worktrees;
}
