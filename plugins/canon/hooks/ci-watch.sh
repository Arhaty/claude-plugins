#!/bin/bash
# After a command that starts a CI run, watch the GitHub Actions runs for the
# commits it started them on and, if one fails, exit 2 with the failing log on stderr. Exit 2
# from an asyncRewake hook wakes Claude with that output, so a red run lands in
# context instead of waiting to be noticed. Wire to PostToolUse on Bash with
# "asyncRewake": true.
#
# Anything that is not a CI failure exits 0 in silence: no gh, no run triggered,
# a push that did not land. A watcher that cries wolf gets ignored.
#
# Which commands start a run is the project's to say, not GitHub's defaults: projects trim the
# `pull_request` activity types to save Actions minutes. `lib/ci-triggers.mjs` reads the `on:`
# triggers of every workflow in the checkout, since a failure in any run on the commit is
# reported, and the rule is:
#
# - `gh pr create` starts a run if `opened` is a type;
# - `gh pr ready` starts one if `ready_for_review` is a type, and `gh pr reopen` if `reopened`
#   is; both watch the pull request's head, not `HEAD`;
# - `git push` starts one for each ref it sent: a branch if a `push` trigger's branch filters
#   take it, or if `synchronize` is a type and the branch has an open pull request; a tag if a
#   `push` trigger has tag filters or none.
#
# With no workflow directory, or a shape the reader does not know, the types are GitHub's
# defaults, `opened`, `synchronize` and `reopened`, with no `push`: under those, marking a draft
# ready starts nothing. A command that starts nothing exits before any `gh run` call, because
# watching for a run that never comes is 60 seconds of polling for an absence. So does one the
# reader cannot make out: it prints nothing, and nothing is watched.
#
# Under `synchronize` without `push`, a push to a branch with no pull request starts nothing, and
# the lookup below finds no run for the commit and exits quietly. `/canon:production` opens a
# pull request from the integration branch while `HEAD` is some other commit, so its run is never
# found here; that command watches its own.
#
# It runs only in a canon project: one with `.claude/canon.json`.

# Taken first: the cutoff below is a minute before this, and the reader's `gh` lookups can take
# longer than that.
start=$(date -u +%s)
input=$(cat)

# Most commands are none of these, and need no Node at all. Only the command counts, not what
# it printed: `git log` in a repository that mentions `gh pr` is not one. The payload puts
# `tool_input` before `tool_response`; in any other order the whole of it is read. The group
# flag can come first (`gh pr -R o/r ready 12`), so the subcommand need not follow `gh pr`.
request=${input%%'"tool_response"'*}
case "$request" in *'"tool_input"'*) ;; *) request=$input ;; esac
case "$request" in
  *"git push"* | *"gh pr"*create* | *"gh pr"*ready* | *"gh pr"*reopen*) ;;
  *) exit 0 ;;
esac
command -v gh >/dev/null 2>&1 || exit 0

# Node rather than jq: every hook here already needs it, and a missing jq read every command as
# empty and switched the watcher off without a word. It prints the checkout to run `gh` in and
# the cutoff, then one line per commit to watch: the SHA, the name the report gives it, and the
# repository when it is not the checkout's, tab-separated.
targets=$(printf '%s' "$input" | node "$(dirname "${BASH_SOURCE[0]}")/lib/ci-triggers.mjs" "$start" 2>/dev/null)
[ -n "$targets" ] || exit 0
tab=$(printf '\t')
IFS=$tab read -r dir since <<HEADER
$(printf '%s\n' "$targets" | sed -n 1p)
HEADER
cd "$dir" 2>/dev/null || exit 0

# GitHub takes a few seconds to register the run. A command that triggers nothing
# is normal — a push to a branch with no pull request starts no run —
# so give up quietly rather than reporting an absence as a problem.
#
# Only a run created after this command finished counts, less a minute for the push itself:
# a SHA can already carry an older run, failed or skipped, and watching it would report a stale
# result as this push's. A refused push and a `gh pr create` for an already-pushed SHA both start
# nothing, and the time filter is what keeps them quiet.

# Watch one commit's runs: `watch_target <sha> <label> <repo> <prefix>`. Each run gets a
# watcher of its own, which writes its report to `<prefix>.<run id>` if the run failed and
# nothing otherwise: one after another, a lint run that failed in two minutes waited behind a
# release run that took twenty. `gh` reads the checkout's repository unless `repo` names another.
watch_target() {
  local sha=$1 label=$2 repo=$3 prefix=$4 ids="" id _
  gh_in() {
    if [ -n "$repo" ]; then GH_REPO=$repo gh "$@"; else gh "$@"; fi
  }
  list_runs() {
    gh_in run list --commit "$sha" --limit 20 --json databaseId,conclusion,createdAt \
      --jq "map(select(.conclusion != \"skipped\" and .createdAt >= \"$since\")) | .[].databaseId" 2>/dev/null
  }
  for _ in $(seq 1 20); do
    ids=$(list_runs)
    [ -n "$ids" ] && break
    sleep 3
  done
  [ -n "$ids" ] || return 0
  # Workflows on one push register a few seconds apart; read once more for the stragglers.
  sleep 5
  ids=$(printf '%s\n%s\n' "$ids" "$(list_runs)" | grep -E '^[0-9]+$' | sort -u)
  for id in $ids; do
    watch_run "$id" >"$prefix.$id" 2>/dev/null </dev/null &
  done
  wait
}

# Watch one run, inside `watch_target`, whose `sha`, `label`, `repo` and `gh_in` it uses.
watch_run() {
  local id=$1 conclusion job
  # **Every run, not the newest.** A workflow that skips itself, such as a deploy check on a
  # branch with no deployment, is listed with no conclusion yet, so the filter above cannot
  # drop it. Watching only the newest run watched that one, saw it skip, and never looked at
  # the run that failed.
  #
  # `--exit-status` is non-zero for every conclusion that is not success. Three of those are
  # not failures:
  #
  # - `cancelled`: a workflow with cancel-in-progress on pull requests cancels the first of two
  #   pull-request events inside a minute by design, and the later run is watched by its own
  #   invocation.
  # - `skipped` and `neutral`: the workflow chose not to run, or not to judge.
  #
  # None of them is a pass either: this hook reports failures and nothing else, and
  # `/canon:staging` merges only when no check on the head is pending or failing.
  # `timed_out` reports: it is a real failure wearing a softer word.
  gh_in run watch "$id" --exit-status --interval 10 >/dev/null 2>&1 && return 0
  conclusion=$(gh_in run view "$id" --json conclusion --jq '.conclusion' 2>/dev/null)
  case "$conclusion" in
    cancelled | skipped | neutral) return 0 ;;
  esac

  # The job tree and annotations say which step broke and why. The raw log is
  # mostly runner noise, so it goes in trimmed and last. A job's id is its
  # check run's id, which is where its annotations live.
  echo "CI failed on ${label} at ${sha}."
  echo
  gh_in api "repos/{owner}/{repo}/actions/runs/$id/jobs" --jq '.jobs[]
    | "\(.name): \(.conclusion // .status)",
      (.steps[]? | select(.conclusion == "failure") | "  failed step: \(.name)")' 2>&1
  for job in $(gh_in api "repos/{owner}/{repo}/actions/runs/$id/jobs" \
      --jq '.jobs[] | select(.conclusion == "failure") | .id' 2>/dev/null); do
    gh_in api "repos/{owner}/{repo}/check-runs/$job/annotations" \
      --jq '.[] | "  \(.annotation_level) \(.path):\(.start_line) \(.message)"' 2>&1
  done
  echo
  echo "Tail of the failing log:"
  gh_in run view "$id" --log-failed 2>&1 | tail -30
}

# A process and everything it started, children first.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}

# **Every commit at once.** One after another, a tag's release run that takes ten minutes
# pushed the report of a branch run that failed in six past the hook's timeout, and a commit
# with no run cost the next one a minute of polling first.
reports=$(mktemp -d "${TMPDIR:-/tmp}/canon-ci-watch.XXXXXX") || exit 0
trap 'rm -rf "$reports"' EXIT
n=0
pids=""
while IFS=$tab read -r sha label repo; do
  [ -n "$sha" ] || continue
  n=$((n + 1))
  watch_target "$sha" "$label" "$repo" "$reports/$n" >/dev/null 2>&1 </dev/null &
  pids="$pids $!"
done < <(printf '%s\n' "$targets" | sed -n '2,$p')
[ -n "$pids" ] || exit 0

# The hook's timeout in hooks.json is 900 seconds from its start, and a hook killed there
# reports nothing. At 840, counted from the start as `SECONDS` is, stop the watchers still
# running so the reports already written get through. The trap goes in before the sleep starts,
# and the sleep holds none of the hook's output, so a kill at any moment leaves nothing holding
# the hook open. `/bin/sleep`, not `sleep`: the tests stub `sleep` to skip the polling waits.
budget=$((840 - SECONDS))
[ "$budget" -gt 0 ] || budget=1
(
  trap 'exit 0' TERM
  /bin/sleep "$budget" </dev/null >/dev/null 2>&1 &
  trap 'kill "$!" 2>/dev/null; exit 0' TERM
  wait "$!"
  for pid in $pids; do kill_tree "$pid"; done
) </dev/null >/dev/null 2>&1 &
watchdog=$!
# shellcheck disable=SC2086 # one word per pid
wait $pids
kill_tree "$watchdog"

status=0
for report in "$reports"/*; do
  [ -s "$report" ] || continue
  cat "$report" >&2
  status=2
done
exit "$status"
