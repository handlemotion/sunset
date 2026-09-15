import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256, type BoxClient } from "@sunset/box";
import {
  publishPatch,
  reconcilePublication,
  validatePatch,
  validatePatchEnvelope,
  type PatchPolicy,
} from "./publish.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const POLICY: PatchPolicy = {
  allowedPath: /^src\/[a-zA-Z0-9_./-]+$/u,
  prohibitedPaths: [/secrets/u],
};

function patchFor(path: string): string {
  return `diff --git a/${path} b/${path}
index 0000000..1111111 100644
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
`;
}

describe("validatePatchEnvelope", () => {
  it("accepts a simple source patch", () => {
    expect(validatePatchEnvelope(patchFor("src/app.ts"), POLICY)).toEqual([
      "src/app.ts",
    ]);
  });

  it("rejects paths outside the allowlist", () => {
    expect(() =>
      validatePatchEnvelope(patchFor("package.json"), POLICY),
    ).toThrow("patch_path_prohibited");
  });

  it("rejects traversal and prohibited paths", () => {
    expect(() =>
      validatePatchEnvelope(patchFor("src/../secrets/key.ts"), POLICY),
    ).toThrow("patch_path_prohibited");
    expect(() =>
      validatePatchEnvelope(patchFor("src/secrets/key.ts"), POLICY),
    ).toThrow("patch_path_prohibited");
  });

  it("rejects embedded secrets", () => {
    const patch = patchFor("src/app.ts").replace(
      "+new",
      "+const k = 'sk_1234567890abcdefgh'",
    );
    expect(() => validatePatchEnvelope(patch, POLICY)).toThrow(
      "patch_content_prohibited",
    );
  });

  it("rejects empty patches", () => {
    expect(() => validatePatchEnvelope("", POLICY)).toThrow(
      "patch_path_count_invalid",
    );
  });

  it("rejects a rename out of a prohibited source", () => {
    expect(() =>
      validatePatchEnvelope(
        `diff --git a/src/secrets/key.ts b/src/app.ts
similarity index 100%
rename from src/secrets/key.ts
rename to src/app.ts
`,
        POLICY,
      ),
    ).toThrow("patch_path_prohibited");
  });
});

const VALIDATION_POLICY: PatchPolicy = {
  allowedPath:
    /^(?:apps|packages)\/[^/]+\/(?:src|test|tests)\/[a-zA-Z0-9_./-]+$/u,
  prohibitedPaths: [
    /(^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u,
    /^scripts\//u,
    /^\.github\//u,
  ],
};

const VALIDATION_PATCH = `diff --git a/apps/api/test/new.test.ts b/apps/api/test/new.test.ts
new file mode 100644
--- /dev/null
+++ b/apps/api/test/new.test.ts
@@ -0,0 +1 @@
+approved
`;

const CHECKS = [
  ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
  ["pnpm", "check"],
  ["pnpm", "check-types"],
  ["pnpm", "test"],
];

it.each([
  { fail: false, rename: false },
  { fail: true, rename: false },
  { fail: false, rename: true },
])(
  "validates new files, freezes published bytes, and fails closed on failed checks (%s)",
  async ({ fail, rename }) => {
    const temp = mkdtempSync(join(tmpdir(), "sunset-validation-"));
    const root = `${temp}/validation`;
    try {
      mkdirSync(`${temp}/base/repo/apps/api/test`, { recursive: true });
      writeFileSync(`${temp}/base/repo/package.json`, "{}\n");
      if (rename)
        writeFileSync(
          `${temp}/base/repo/apps/api/test/old.test.ts`,
          "approved\n",
        );
      execFileSync("tar", [
        "-czf",
        `${temp}/bundle.tgz`,
        "-C",
        `${temp}/base`,
        "repo",
      ]);
      let checks = 0;
      const deleted = vi.fn(async () => undefined);
      const box = {
        write: async (path: string, content: string, encoding?: "base64") => {
          writeFileSync(
            path.replace("/workspace/home/validation", root),
            content,
            encoding ?? "utf8",
          );
        },
        read: async (path: string) => {
          const local = path.replace("/workspace/home/validation", root);
          return existsSync(local) ? readFileSync(local, "utf8") : null;
        },
        exec: async (command: string[], timeout?: number) => {
          if (command.join(" ").includes("exec bwrap")) {
            execFileSync("bash", ["-n", "-c", command[2]!]);
            expect(timeout).toBeGreaterThan(0);
            expect(command.join(" ")).toContain("--ro-bind");
            expect(command[2]).toContain("--clearenv --setenv PATH");
            expect(command[2]).toContain("--setenv HOME /tmp");
            expect(command[2]).toContain("--tmpfs /workspace/home");
            expect(command[2]?.includes("--unshare-net")).toBe(checks > 0);
            checks++;
            writeFileSync(
              `${root}/apps/api/test/new.test.ts`,
              "mutated by check\n",
            );
            return {
              exitCode: fail ? 1 : 0,
              output: "untrusted output",
              error: "",
            };
          }
          try {
            return {
              exitCode: 0,
              output: execFileSync(
                command[0]!,
                command
                  .slice(1)
                  .map((arg) =>
                    arg.replaceAll("/workspace/home/validation", root),
                  ),
                { encoding: "utf8" },
              ),
              error: "",
            };
          } catch {
            return { exitCode: 1, output: "", error: "" };
          }
        },
        delete: deleted,
      };
      const result = validatePatch({
        patch: rename
          ? `diff --git a/apps/api/test/old.test.ts b/apps/api/test/new.test.ts
similarity index 100%
rename from apps/api/test/old.test.ts
rename to apps/api/test/new.test.ts
`
          : VALIDATION_PATCH,
        baseSha: "a".repeat(40),
        deadlineAt: Date.now() + 60_000,
        policy: VALIDATION_POLICY,
        box: box as unknown as BoxClient,
        bundle: readFileSync(`${temp}/bundle.tgz`).toString("base64"),
        checks: CHECKS,
      });
      if (fail) {
        await expect(result).rejects.toThrow("validation_install_failed");
      } else {
        const { files } = await result;
        expect(files).toEqual([
          {
            path: "apps/api/test/new.test.ts",
            content: "approved\n",
            mode: "100644",
          },
          ...(rename
            ? [
                {
                  path: "apps/api/test/old.test.ts",
                  content: null,
                  mode: "100644",
                },
              ]
            : []),
        ]);
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
        const validatedTree = git("write-tree");
        git("reset", "--hard", "-q", "HEAD");
        for (const file of files) {
          if (file.content === null) rmSync(`${root}/${file.path}`);
          else {
            mkdirSync(dirname(`${root}/${file.path}`), { recursive: true });
            writeFileSync(`${root}/${file.path}`, file.content);
          }
        }
        git("add", "-A");
        expect(git("write-tree")).toBe(validatedTree);
        expect(checks).toBe(4);
      }
      expect(deleted).toHaveBeenCalledOnce();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it("rejects a changed patch digest before any external transition", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    publishPatch({
      repo: { repo: "owner/name", base: "main" },
      credentials: { appId: "1", installationId: "2", privateKey: "x" },
      branch: "sunset/run-one",
      baseSha: "a".repeat(40),
      patch: VALIDATION_PATCH,
      patchDigest: "wrong",
      validated: { files: [], checks: [] },
      commitMessage: "change",
      identity: { name: "Sunset", email: "sunset@localhost" },
      commitDate: new Date().toISOString(),
      deadlineAt: Date.now() + 60_000,
      allowPrCreate: true,
    }),
  ).rejects.toThrow("patch_digest_mismatch");
  expect(fetch).not.toHaveBeenCalled();
});

it("reconciles an existing draft repeatedly without repeating PR creation", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("expected key pair");
  const privateKey = Buffer.from(
    new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    ),
  ).toString("base64");
  const digest = await sha256(VALIDATION_PATCH);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens"))
      return Response.json({ token: "test-installation" });
    expect(init?.method).toBe("GET");
    if (url.includes("/git/ref/"))
      return Response.json({ object: { sha: "a".repeat(40) } });
    if (url.includes("/git/commits/"))
      return Response.json({ message: `Sunset-Patch: ${digest}` });
    return Response.json([
      { number: 10, html_url: "https://github.test/pull/10", state: "open" },
    ]);
  });
  vi.stubGlobal("fetch", fetch);
  const input = {
    repo: { repo: "owner/name", base: "main" },
    credentials: { appId: "1", installationId: "2", privateKey },
    branch: "sunset/run-one",
    patchDigest: digest,
  };
  for (let i = 0; i < 2; i++)
    await expect(reconcilePublication(input)).resolves.toMatchObject({
      pull: { number: 10 },
    });
  expect(
    fetch.mock.calls.filter(([url]) => String(url).includes("/pulls")),
  ).toHaveLength(2);
});
