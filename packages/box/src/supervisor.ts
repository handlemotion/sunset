/**
 * Detached task supervisor for a persistent Box.
 *
 * Serializes launches with flock, writes a per-run marker so a second launch
 * call returns the existing process instead of duplicating it, and runs the
 * task under a hard `timeout --signal=KILL` deadline in its own session.
 * The task body is supplied by the caller and written to $task/task.sh.
 */
export function supervisorScript(root = "/workspace/home/sunset"): string {
  return String.raw`#!/usr/bin/env bash
set -euo pipefail
umask 077
run_id="$1"
root="${root}"
task="$root/tasks/$run_id"
trusted="$root/trusted"
output="$trusted/$run_id"
marker="$trusted/run-$run_id.json"
deadline="$2"
mkdir -p "$output"
exec 9>"$trusted/process.lock"
if ! flock -n 9; then
  test -f "$marker" && cat "$marker"
  exit 0
fi
if test -f "$marker"; then cat "$marker"; exit 0; fi
remaining=$((deadline - $(date +%s)))
test "$remaining" -gt 0
setsid timeout --signal=KILL "$remaining"s bash "$task/task.sh" > /dev/null 2> "$output/task.stderr" &
pid=$!
printf '{"runId":"%s","pid":%s,"startedAt":%s}\n' "$run_id" "$pid" "$(date +%s000)" > "$marker.tmp"
mv "$marker.tmp" "$marker"
cat "$marker"
`;
}
