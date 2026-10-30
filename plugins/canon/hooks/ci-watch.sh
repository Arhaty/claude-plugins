#!/bin/bash
# After a command that starts a CI run, watch the GitHub Actions runs for the
# commits it started them on and, if one fails, exit 2 with the failing log on stderr. Exit 2
# from an asyncRewake hook wakes Claude with that output, so a red run lands in
# context instead of waiting to be noticed. Wire to PostToolUse on Bash with
# "asyncRewake": true.
#
# Anything that is not a CI failure exits 0 in silence: no gh, no run triggered,
# a push that did not land. A watcher that cries wolf gets ignored. The one exception is a run
# still going when the watch runs out of time: that exits 2 too, saying so, because silence there
# reads as a pass.
#
# Which commands start a run is the project's to say, not GitHub's defaults: projects trim the
# `pull_request` activity types to save Actions minutes. `lib/ci-triggers.mjs` reads the `on:`
# triggers of every workflow in the checkout, since a failure in any run on the commit is
# reported, and the rule is:
#
# - `gh pr create`, or its REST form `gh api -X POST .../pulls`, starts a run if `opened` is a
#   type;
# - `gh pr ready`, or the cloud proxy's `POST .../pulls/<n>/ccr/ready_for_review`, starts one if
#   `ready_for_review` is a type, and `gh pr reopen` if `reopened` is; both watch the pull
#   request's head, not `HEAD`;
# - `gh api -X POST .../actions/workflows/<wf>/dispatches` starts one on the branch its `ref`
#   names;
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
# git's own options can come before `push` (`git -c push.default=current push`), so a push is
# `git` then `push` inside one JSON string, from the command on: across the whole payload, a
# checkout under `~/git/` made every `pushd` one.
request=${input%%'"tool_response"'*}
case "$request" in *'"tool_input"'*) ;; *) request=$input ;; esac
command_on=${request#*'"command"'}
git_push='git([^"\\]|\\.)*push'
case "$request" in
  *"gh pr"*create* | *"gh pr"*ready* | *"gh pr"*reopen*) ;;
  *"gh api"*pulls* | *"gh api"*dispatches*) ;;
  *) [[ $command_on =~ $git_push ]] || exit 0 ;;
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
# release run that took twenty. So a watch cut short can say what it never saw end, `<prefix>.wait`
# exists until the commit's runs are listed, and `<prefix>.<run id>.open` until that run's report
# is written. `gh` reads the checkout's repository unless `repo` names another.
watch_target() {
  local sha=$1 label=$2 repo=$3 prefix=$4 ids="" id _
  : >"$prefix.wait"
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
  if [ -z "$ids" ]; then
    rm -f "$prefix.wait"
    return 0
  fi
  # Workflows on one push register a few seconds apart; read once more for the stragglers.
  sleep 5
  ids=$(printf '%s\n%s\n' "$ids" "$(list_runs)" | grep -E '^[0-9]+$' | sort -u)
  for id in $ids; do
    : >"$prefix.$id.open"
    {
      watch_run "$id" >"$prefix.$id"
      rm -f "$prefix.$id.open"
    } 2>/dev/null </dev/null &
  done
  rm -f "$prefix.wait"
  wait
}

# Watch one run, inside `watch_target`, whose `prefix` and `gh_in` it uses. The header naming
# the commit is the hook's, written once per commit however many of its runs failed.
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
  echo "Run $id:"
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
  echo
}

# **Every commit at once.** One after another, a tag's release run that takes ten minutes
# pushed the report of a branch run that failed in six past the hook's timeout, and a commit
# with no run cost the next one a minute of polling first.
#
# Each watcher and the watchdog start in a process group of their own (`set -m`), so one signal
# to the group stops a watcher and everything under it at once: killed one process at a time, a
# watcher outlived its `gh run watch` long enough to start the next `gh`. `jobs -pr` names only
# the jobs bash still has running, never a PID that has exited and may since belong to something
# else. Groups do not die with the hook's, so the hook stops them on any way out but `SIGKILL`.
stop_jobs() {
  local pid
  for pid in $(jobs -pr); do
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  done
}
reports=$(mktemp -d "${TMPDIR:-/tmp}/canon-ci-watch.XXXXXX") || exit 0
trap 'stop_jobs; rm -rf "$reports"' EXIT
trap 'exit 143' TERM INT HUP
n=0
pids=""
shas=()
labels=()
repos=()
set -m
while IFS=$tab read -r sha label repo; do
  [ -n "$sha" ] || continue
  n=$((n + 1))
  shas[n]=$sha
  labels[n]=$label
  repos[n]=$repo
  watch_target "$sha" "$label" "$repo" "$reports/$n" >/dev/null 2>&1 </dev/null &
  pids="$pids $!"
done < <(printf '%s\n' "$targets" | sed -n '2,$p')
[ -n "$pids" ] || exit 0

# The hook's timeout in hooks.json is 900 seconds from its start, and a hook killed there
# reports nothing. At 840, counted from the start as `SECONDS` is, the watchdog signals the hook,
# which stops the watchers still running so the reports already written get through. The hook
# stops them, not the watchdog, for the reason above. Nothing in the watchdog's group holds the
# hook's output. `/bin/sleep`, not `sleep`: the tests stub `sleep` to skip the polling waits, and
# set `CANON_CI_WATCH_BUDGET` to reach the cutoff in a second.
budget=$((${CANON_CI_WATCH_BUDGET:-840} - SECONDS))
[ "$budget" -gt 0 ] || budget=1
hook=$$
cut=""
trap 'cut=1' USR1
(
  /bin/sleep "$budget"
  kill -USR1 "$hook"
) </dev/null >/dev/null 2>&1 &
set +m
# Every watcher finishing, or the signal, which ends the `wait` early. bash reports each job a
# signal ended on stderr, which is the report: those lines go nowhere.
{
  # shellcheck disable=SC2086 # one word per pid
  wait $pids
  if [ -n "$cut" ]; then
    stop_jobs
    # shellcheck disable=SC2086 # one word per pid
    wait $pids
  fi
  stop_jobs
  wait
} 2>/dev/null

# One header per commit, in the order the command named them, then each failed run under it,
# then what the watch stopped before it saw the end of: a run with no result read, or a commit
# whose runs were not listed yet. Silence there would read as a pass.
status=0
for i in $(seq 1 "$n"); do
  failed=""
  open=""
  waiting=""
  for report in "$reports/$i".*; do
    case "$report" in
      *.wait) waiting=1 ;;
      *.open)
        id=${report%.open}
        id=${id##*.}
        # A report cut short still says the run failed; it goes with the others.
        [ -s "$reports/$i.$id" ] || open="$open $id"
        ;;
      *) [ -s "$report" ] && failed="$failed $report" ;;
    esac
  done
  [ -n "$failed$open$waiting" ] || continue
  status=2
  repo=${repos[i]:+ -R ${repos[i]}}
  if [ -n "$failed" ]; then
    printf 'CI failed on %s at %s.\n\n' "${labels[i]}" "${shas[i]}" >&2
    # shellcheck disable=SC2086 # one word per file
    cat $failed >&2
  fi
  for id in $open; do
    printf 'CI had not finished run %s on %s at %s when this watch stopped. `%s` picks it up.\n' \
      "$id" "${labels[i]}" "${shas[i]}" "gh run watch $id --exit-status$repo" >&2
  done
  if [ -n "$waiting" ]; then
    printf 'No CI run had registered on %s at %s when this watch stopped. `%s` lists any since.\n' \
      "${labels[i]}" "${shas[i]}" "gh run list --commit ${shas[i]}$repo" >&2
  fi
done
exit "$status"
