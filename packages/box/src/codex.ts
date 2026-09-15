/**
 * Unattended `codex exec` inside a persistent Box, locked down for a
 * credential-free sandbox: ChatGPT login only, a named filesystem permission
 * profile that denies the box home and /proc and permits writes only in the
 * task repo, no network, no web search, strict config with no fallback.
 *
 * Requires a pinned CLI that supports filesystem permission profiles,
 * installed under CODEX_BIN_DIR so the image's bundled CLI can never be
 * selected silently.
 *
 * Lifted from Transitive's apps/sunset worker and re-scoped to generic
 * workspace execution.
 */
import type { BoxClient } from "./box.js";

/** Pinned install location inside the Box; its `.bin` leads PATH. */
export const CODEX_BIN_DIR = "/workspace/home/node_modules/.bin";

/**
 * Commissioning gate: the box must resolve `codex --version` to exactly
 * `codex-cli <version>` from CODEX_BIN_DIR. Anything else blocks the run;
 * there is no weaker-sandbox fallback.
 */
export async function assertCodexVersion(
  box: BoxClient,
  version: string,
): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("invalid_codex_version");
  }
  const check = await box.exec([
    "bash",
    "-lc",
    `PATH="${CODEX_BIN_DIR}:$PATH" codex --version`,
  ]);
  if (check.exitCode !== 0 || check.output.trim() !== `codex-cli ${version}`) {
    throw new Error("codex_commissioning_required");
  }
}

/**
 * `task.sh` body for {@link launchRun}. Reads `trusted/model`,
 * `trusted/prompt.txt`, and — when present — `trusted/result-schema.json`
 * from the run root it sits under. Writes `status.json`, `patch.diff`,
 * `agent.jsonl`, `agent.stderr`, and `report.json` to `trusted/<runId>/`.
 *
 * Expects `task/repo` to hold a baseline git commit; the patch is captured
 * as `git diff --cached` after `add -A`.
 */
// Bash array expansion, inserted literally — `${…}` cannot appear verbatim
// inside a template literal.
const SCHEMA_ARGS = '"${schema_args[@]}"';

export function codexTaskScript(): string {
  return String.raw`set +e
task="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$(dirname "$task")")"
run_id="$(basename "$task")"
trusted="$root/trusted"
output="$trusted/$run_id"
status="$output/status.json"
export PATH="${CODEX_BIN_DIR}:$PATH"
cd "$task" || exit 1
schema_args=()
test -f "$trusted/result-schema.json" && schema_args=(--output-schema "$trusted/result-schema.json")
env -u OPENAI_API_KEY -u CODEX_API_KEY CODEX_HOME="/workspace/home/.codex" codex exec \
  --ignore-user-config --ignore-rules --strict-config --ephemeral \
  --json --skip-git-repo-check \
  -c 'approval_policy="never"' -c 'forced_login_method="chatgpt"' \
  -c 'default_permissions="sunset"' \
  -c "permissions.sunset.filesystem={ \"/\"=\"read\", \"/workspace/home\"=\"deny\", \"$task\"=\"read\", \"$task/repo\"=\"write\", \"$task/repo/.git\"=\"read\", \"/proc\"=\"deny\" }" \
  -c 'permissions.sunset.network.enabled=false' -c 'web_search="disabled"' \
  --model "$(cat "$trusted/model")" --cd "$task" \
  ${SCHEMA_ARGS} \
  --output-last-message "$output/report.json" - < "$trusted/prompt.txt" \
  > "$output/agent.jsonl" 2> "$output/agent.stderr" 9>&-
exit_code=$?
git -C "$task/repo" add -A || exit_code=1
git -C "$task/repo" diff --cached HEAD --binary --no-ext-diff > "$output/patch.diff" || exit_code=1
printf '{"exitCode":%s,"finishedAt":%s}\n' "$exit_code" "$(date +%s000)" > "$status.tmp"
mv "$status.tmp" "$status"
`;
}
