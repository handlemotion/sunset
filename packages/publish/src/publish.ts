import { z } from "zod";

import { required, sha256, type BoxClient } from "@sunset/box";

const MAX_PATCH_BYTES = 1024 * 1024;
const SECRET_PATTERN =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:sk|ghp|github_pat|xox[baprs]|inc)_[A-Za-z\d_-]{16,}|AKIA[A-Z\d]{16})/u;
const TEXT_PATH =
  /(?:^|\/)(?:[^/]+\.(?:c|m)?(?:j|t)sx?|[^/]+\.(?:json|jsonc|md|mdx|css|sql|toml|ya?ml|txt|xml|graphql|sh)|Dockerfile|Makefile)$/u;

export type PublishRepo = {
  /** "owner/name" */
  repo: string;
  /** base branch, e.g. "main" */
  base: string;
};

export type GithubAppCredentials = {
  appId: string;
  installationId: string;
  privateKey: string;
};

export type PatchPolicy = {
  /** paths must match this to be allowed */
  allowedPath: RegExp;
  /** paths matching any of these are rejected even if allowed */
  prohibitedPaths: RegExp[];
  maxFiles?: number;
  maxBytes?: number;
};

export type ValidatedPatch = {
  files: { path: string; content: string | null; mode: "100644" | "100755" }[];
  checks: { command: string; status: "passed"; summary: string }[];
};

function beforeDeadline(deadlineAt: number): void {
  if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) {
    throw new Error("publication_deadline_expired");
  }
}

export function validatePatchEnvelope(
  patch: string,
  policy: PatchPolicy,
): string[] {
  if (
    new TextEncoder().encode(patch).byteLength >
    (policy.maxBytes ?? MAX_PATCH_BYTES)
  ) {
    throw new Error("patch_too_large");
  }
  if (
    patch.includes("GIT binary patch") ||
    /\b(?:120000|160000)\b/u.test(patch) ||
    SECRET_PATTERN.test(patch)
  ) {
    throw new Error("patch_content_prohibited");
  }
  const paths = [
    ...new Set(
      [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)].flatMap(
        (match) => [match[1]!, match[2]!],
      ),
    ),
  ];
  const maxFiles = policy.maxFiles ?? 40;
  if (paths.length === 0 || paths.length > maxFiles) {
    throw new Error("patch_path_count_invalid");
  }
  for (const path of paths) {
    if (
      !policy.allowedPath.test(path) ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      !TEXT_PATH.test(path) ||
      policy.prohibitedPaths.some((pattern) => pattern.test(path))
    ) {
      throw new Error("patch_path_prohibited");
    }
  }
  return [...new Set(paths)];
}

/**
 * Apply the patch inside an ephemeral Box against an immutable base tarball
 * and run the supplied check commands under bubblewrap isolation.
 */
export async function validatePatch(input: {
  patch: string;
  baseSha: string;
  deadlineAt: number;
  policy: PatchPolicy;
  box: BoxClient;
  bundle: string;
  checks: string[][];
}): Promise<ValidatedPatch> {
  beforeDeadline(input.deadlineAt);
  const expectedPaths = validatePatchEnvelope(input.patch, input.policy);
  const box = input.box;
  try {
    const root = "/workspace/home/validation";
    await box.exec(["mkdir", "-p", root]);
    await Promise.all([
      box.write(`${root}/repository.tgz`, input.bundle, "base64"),
      box.write(`${root}/patch.diff`, input.patch),
    ]);
    const prepare = await box.exec([
      "bash",
      "-lc",
      `set -e; tar -xzf '${root}/repository.tgz' -C '${root}' --strip-components=1; rm '${root}/repository.tgz'; git -C '${root}' init -q; git -C '${root}' config core.hooksPath /dev/null; git -C '${root}' add -A; git -C '${root}' -c user.name=Sunset -c user.email=sunset@localhost commit -qm baseline; git -C '${root}' apply --check '${root}/patch.diff'; git -C '${root}' apply --index '${root}/patch.diff'`,
    ]);
    if (prepare.exitCode !== 0) throw new Error("patch_application_failed");
    const names = await box.exec([
      "git",
      "-C",
      root,
      "diff",
      "--cached",
      "HEAD",
      "--name-only",
      "--no-renames",
      "-z",
    ]);
    if (names.exitCode !== 0) throw new Error("validated_diff_unreadable");
    const actualPaths = names.output.split("\0").filter(Boolean).sort();
    if (
      JSON.stringify(actualPaths) !== JSON.stringify([...expectedPaths].sort())
    ) {
      throw new Error("validated_diff_path_mismatch");
    }

    const files = await Promise.all(
      actualPaths.map(async (path) => {
        const [content, executable] = await Promise.all([
          box.read(`${root}/${path}`),
          box.exec(["test", "-x", `${root}/${path}`]),
        ]);
        return {
          path,
          content,
          mode:
            executable.exitCode === 0
              ? ("100755" as const)
              : ("100644" as const),
        };
      }),
    );
    const checkResults: ValidatedPatch["checks"] = [];
    for (const command of input.checks) {
      beforeDeadline(input.deadlineAt);
      // Check commands run arbitrary patched code, so the base is frozen:
      // .git, every tracked file outside src/test dirs, and the src/test
      // dirs themselves are ro-bound; only dependency installation gets a
      // network namespace.
      const result = await box.exec(
        [
          "bash",
          "-lc",
          `set -e; cd '${root}';
mounts=(--ro-bind '${root}/.git' '${root}/.git');
while IFS= read -r -d '' path; do mounts+=(--ro-bind "${root}/$path" "${root}/$path"); done < <(git ls-files -z -- ':!:**/src/**' ':!:**/test/**' ':!:**/tests/**');
while IFS= read -r -d '' path; do mounts+=(--ro-bind "${root}/$path" "${root}/$path"); done < <(find . -type d -name node_modules -prune -o -type d '(' -name src -o -name test -o -name tests ')' -prune -print0);
exec bwrap --die-with-parent --unshare-pid --unshare-user --unshare-uts --unshare-ipc ${command[1] === "install" ? "" : "--unshare-net"} --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp --tmpfs /workspace/home --bind '${root}' '${root}' "\${mounts[@]}" --chdir '${root}' ${command.join(" ")}`,
        ],
        Math.max(1, input.deadlineAt - Date.now() - 1_000),
      );
      if (result.exitCode !== 0) {
        throw new Error(`validation_${command[1] ?? command[0]}_failed`);
      }
      checkResults.push({
        command: command.join(" "),
        status: "passed",
        summary: "Passed in isolated validation.",
      });
    }
    if (
      files.some(
        ({ content }) => content !== null && SECRET_PATTERN.test(content),
      )
    ) {
      throw new Error("validated_secret_exposure");
    }
    beforeDeadline(input.deadlineAt);
    return { files, checks: checkResults };
  } finally {
    await box.delete().catch(() => undefined);
  }
}

function base64url(value: string | ArrayBuffer): string {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function githubAppJwt(
  credentials: GithubAppCredentials,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: required(credentials.appId, "GITHUB_APP_ID"),
    }),
  );
  const pem = required(credentials.privateKey, "GITHUB_APP_PRIVATE_KEY");
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----|\s/gu, "")),
    (character) => character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function installationToken(
  credentials: GithubAppCredentials,
  repo: PublishRepo,
): Promise<string> {
  const [, name] = repo.repo.split("/");
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(required(credentials.installationId, "GITHUB_APP_INSTALLATION_ID"))}/access_tokens`,
    {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${await githubAppJwt(credentials)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sunset",
      },
      body: JSON.stringify({
        repositories: [name],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  if (!response.ok) throw new Error(`github_app_${response.status}`);
  return z.object({ token: z.string().min(1) }).parse(await response.json())
    .token;
}

async function github<T>(
  repo: PublishRepo,
  token: string,
  method: string,
  path: string,
  body: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  allow404 = false,
): Promise<T | null> {
  const response = await fetch(
    `https://api.github.com/repos/${repo.repo}${path}`,
    {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sunset",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`github_write_${response.status}`);
  return schema.parse(await response.json());
}

const ShaSchema = z.object({ sha: z.string().regex(/^[a-f\d]{40}$/u) });
const PullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
});

export type CommitIdentity = {
  name: string;
  email: string;
};

/**
 * Idempotent: a branch whose head commit already carries the patch digest is
 * reused; any other branch state is a conflict, never clobbered.
 */
export async function ensureBranch(input: {
  repo: PublishRepo;
  token: string;
  branch: string;
  baseSha: string;
  patchDigest: string;
  files: ValidatedPatch["files"];
  commitMessage: string;
  identity: CommitIdentity;
  commitDate: string;
  deadlineAt: number;
}): Promise<string> {
  const { repo, token } = input;
  beforeDeadline(input.deadlineAt);
  const ref = await github(
    repo,
    token,
    "GET",
    `/git/ref/heads/${encodeURIComponent(input.branch)}`,
    undefined,
    z.object({ object: ShaSchema }),
    true,
  );
  if (ref) {
    beforeDeadline(input.deadlineAt);
    const commit = await github(
      repo,
      token,
      "GET",
      `/git/commits/${ref.object.sha}`,
      undefined,
      z.object({ message: z.string() }),
    );
    if (!commit?.message.includes(`Sunset-Patch: ${input.patchDigest}`)) {
      throw new Error("publication_branch_conflict");
    }
    return ref.object.sha;
  }

  const base = await github(
    repo,
    token,
    "GET",
    `/git/commits/${input.baseSha}`,
    undefined,
    z.object({ tree: ShaSchema }),
  );
  if (!base) throw new Error("publication_base_missing");
  const treeEntries = await Promise.all(
    input.files.map(async ({ path, content, mode }) => {
      if (content === null) return { path, mode, type: "blob", sha: null };
      beforeDeadline(input.deadlineAt);
      const blob = await github(
        repo,
        token,
        "POST",
        "/git/blobs",
        { content, encoding: "utf-8" },
        ShaSchema,
      );
      if (!blob) throw new Error("publication_blob_missing");
      return { path, mode, type: "blob", sha: blob.sha };
    }),
  );
  const tree = await github(
    repo,
    token,
    "POST",
    "/git/trees",
    { base_tree: base.tree.sha, tree: treeEntries },
    ShaSchema,
  );
  if (!tree) throw new Error("publication_tree_missing");
  beforeDeadline(input.deadlineAt);
  const commit = await github(
    repo,
    token,
    "POST",
    "/git/commits",
    {
      message: `${input.commitMessage}\n\nSunset-Patch: ${input.patchDigest}`,
      tree: tree.sha,
      parents: [input.baseSha],
      author: { ...input.identity, date: input.commitDate },
      committer: { ...input.identity, date: input.commitDate },
    },
    ShaSchema,
  );
  if (!commit) throw new Error("publication_commit_missing");
  beforeDeadline(input.deadlineAt);
  await github(
    repo,
    token,
    "POST",
    "/git/refs",
    { ref: `refs/heads/${input.branch}`, sha: commit.sha },
    z.object({ ref: z.string() }),
  );
  return commit.sha;
}

export async function existingPull(
  repo: PublishRepo,
  token: string,
  branch: string,
) {
  const owner = repo.repo.split("/")[0]!;
  const pulls = await github(
    repo,
    token,
    "GET",
    `/pulls?state=all&head=${owner}:${encodeURIComponent(branch)}&base=${encodeURIComponent(repo.base)}&per_page=10`,
    undefined,
    z.array(PullSchema),
  );
  if (!pulls || pulls.length === 0) return null;
  const pull = pulls[0]!;
  if (pull.state === "closed") throw new Error("publication_pull_closed");
  return pull;
}

function safePrText(value: string): string {
  return value.replace(
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#/giu,
    "$1 issue #",
  );
}

/**
 * Push a validated patch to a branch and optionally open a draft PR.
 * The caller supplies the PR title/body; ambiguous PR creation is reconciled
 * by listing pulls for the branch rather than retried.
 */
export async function publishPatch(input: {
  repo: PublishRepo;
  credentials: GithubAppCredentials;
  branch: string;
  baseSha: string;
  patch: string;
  patchDigest: string;
  validated: ValidatedPatch;
  commitMessage: string;
  identity: CommitIdentity;
  commitDate: string;
  deadlineAt: number;
  pullTitle?: string;
  pullBody?: string;
  allowPrCreate: boolean;
  beforePrCreate?: () => Promise<void>;
}): Promise<{
  commitSha: string;
  pull?: { number: number; url: string };
  validation: ValidatedPatch["checks"];
}> {
  if ((await sha256(input.patch)) !== input.patchDigest) {
    throw new Error("patch_digest_mismatch");
  }
  const token = await installationToken(input.credentials, input.repo);
  const commitSha = await ensureBranch({
    repo: input.repo,
    token,
    branch: input.branch,
    baseSha: input.baseSha,
    patchDigest: input.patchDigest,
    files: input.validated.files,
    commitMessage: input.commitMessage,
    identity: input.identity,
    commitDate: input.commitDate,
    deadlineAt: input.deadlineAt,
  });
  beforeDeadline(input.deadlineAt);
  const existing = await existingPull(input.repo, token, input.branch);
  if (existing) {
    return {
      commitSha,
      pull: { number: existing.number, url: existing.html_url },
      validation: input.validated.checks,
    };
  }
  if (!input.allowPrCreate) {
    return { commitSha, validation: input.validated.checks };
  }
  beforeDeadline(input.deadlineAt);
  await input.beforePrCreate?.();
  beforeDeadline(input.deadlineAt);
  try {
    const pull = await github(
      input.repo,
      token,
      "POST",
      "/pulls",
      {
        title: input.pullTitle ?? "Sunset change",
        head: input.branch,
        base: input.repo.base,
        draft: true,
        body: safePrText(input.pullBody ?? ""),
      },
      PullSchema,
    );
    if (!pull) throw new Error("publication_pull_missing");
    return {
      commitSha,
      pull: { number: pull.number, url: pull.html_url },
      validation: input.validated.checks,
    };
  } catch {
    const reconciled = await existingPull(input.repo, token, input.branch);
    if (!reconciled) throw new Error("publication_unknown");
    return {
      commitSha,
      pull: { number: reconciled.number, url: reconciled.html_url },
      validation: input.validated.checks,
    };
  }
}

/**
 * Recover after `publication_unknown`: reuse the branch only when its head
 * commit carries the patch digest, then list pulls for it rather than
 * repeating PR creation. Returns null when the branch was never written.
 */
export async function reconcilePublication(input: {
  repo: PublishRepo;
  credentials: GithubAppCredentials;
  branch: string;
  patchDigest: string;
}): Promise<{
  commitSha: string;
  pull: { number: number; url: string };
} | null> {
  const token = await installationToken(input.credentials, input.repo);
  const ref = await github(
    input.repo,
    token,
    "GET",
    `/git/ref/heads/${encodeURIComponent(input.branch)}`,
    undefined,
    z.object({ object: ShaSchema }),
    true,
  );
  if (!ref) return null;
  const commit = await github(
    input.repo,
    token,
    "GET",
    `/git/commits/${ref.object.sha}`,
    undefined,
    z.object({ message: z.string() }),
  );
  if (!commit?.message.includes(`Sunset-Patch: ${input.patchDigest}`)) {
    throw new Error("publication_branch_conflict");
  }
  const pull = await existingPull(input.repo, token, input.branch);
  return pull
    ? {
        commitSha: ref.object.sha,
        pull: { number: pull.number, url: pull.html_url },
      }
    : null;
}
