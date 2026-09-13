import { describe, expect, it } from "vitest";

import { validatePatchEnvelope, type PatchPolicy } from "./publish.js";

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
});
