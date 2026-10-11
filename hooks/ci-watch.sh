#!/bin/bash
# After a command that starts a CI run, watch the GitHub Actions run for the
# current commit and, if it fails, exit 2 with the failing log on stderr. Exit 2
# from an asyncRewake hook wakes Claude with that output, so a red run lands in
# context instead of waiting to be noticed. Wire to PostToolUse on Bash with
# "asyncRewake": true.
#
# Anything that is not a CI failure exits 0 in silence: no gh, no run triggered,
# a push that did not land. A watcher that cries wolf gets ignored.
#
# The filter is the two commands that start a run under GitHub's default `pull_request` trigger,
# whose activity types are `opened`, `synchronize` and `reopened`: `gh pr create` starts one and
# a `git push` to a branch with an open pull request starts one. `gh pr ready` is deliberately not
# in it: `ready_for_review` is not a default type, so marking a draft ready starts nothing, and
# watching for a run that never comes is 60 seconds of polling for an absence.
#
# A push to a branch with no pull request starts nothing either, and the lookup below finds no
# run for the commit and exits quietly. `/canon:production` opens a pull request from the
# integration branch while `HEAD` is some other commit, so its run is never found here; that
# command watches its own.
#
# It runs only in a canon project: one with `.claude/canon.json`.
#
# The match is on text, so a command that only mentions `git push` in a message wakes this for
# nothing more than a quiet lookup.

input=$(cat)

# Node rather than jq: every hook here already needs it, and a missing jq read every command as
# empty and switched the watcher off without a word. Prints the command, then on a second line
# whether the output says nothing was pushed.
read_payload='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);
const out=JSON.stringify(p.tool_response??"");
process.stdout.write((p.tool_input?.command??"").replace(/\n/g," ")+"\n"+(/Everything up-to-date/.test(out)?"1":"0"))}catch{}})'
parsed=$(printf '%s' "$input" | node -e "$read_payload" 2>/dev/null)
cmd=$(printf '%s' "$parsed" | head -n 1)
up_to_date=$(printf '%s' "$parsed" | sed -n 2p)

case "$cmd" in
  *"git push"*) ;;
  *"gh pr create"*) ;;
  *) exit 0 ;;
esac

# A push that moved nothing starts no run, and the newest run for the SHA is an old one.
[ "$up_to_date" = "1" ] && exit 0

command -v gh >/dev/null 2>&1 || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -f .claude/canon.json ] || exit 0

sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

# GitHub takes a few seconds to register the run. A command that triggers nothing
# is normal — a push to a branch with no pull request starts no run —
# so give up quietly rather than reporting an absence as a problem.
#
# Only a run created after this command finished counts, less a minute for the push itself:
# a SHA can already carry an older run, failed or skipped, and watching it would report a stale
# result as this push's. A refused push and a `gh pr create` for an already-pushed SHA both start
# nothing, and the time filter is what keeps them quiet.
since=$(node -e 'process.stdout.write(new Date(Date.now()-60000).toISOString().replace(/\.\d+Z$/,"Z"))')
id=""
for _ in $(seq 1 20); do
  id=$(gh run list --commit "$sha" --limit 10 --json databaseId,conclusion,createdAt \
        --jq "map(select(.conclusion != \"skipped\" and .createdAt >= \"$since\")) | .[0].databaseId // empty" 2>/dev/null)
  [ -n "$id" ] && break
  sleep 3
done
[ -n "$id" ] || exit 0

gh run watch "$id" --exit-status --interval 10 >/dev/null 2>&1 && exit 0

# `--exit-status` is non-zero for every conclusion that is not success, and
# cancelled is one of them. A workflow with cancel-in-progress on pull requests
# cancels the first of two pull-request events inside a minute by design, and
# reporting that as a failure is noise. The later run is already being watched by
# its own invocation, so there is nothing to say about the run it superseded.
#
# Only `cancelled` is forgiven. `timed_out` still reports: it is a real failure
# wearing a softer word. `skipped` is filtered out above rather than forgiven
# here, which is the narrower treatment of the two: a run that was never a
# candidate cannot mask a later real one, whereas forgiving the conclusion here
# would silence a genuine skip on the run this hook actually chose to watch.
conclusion=$(gh run view "$id" --json conclusion --jq '.conclusion' 2>/dev/null)
[ "$conclusion" = "cancelled" ] && exit 0

# The job tree and annotations say which step broke and why. The raw log is
# mostly runner noise, so it goes in trimmed and last. A job's id is its
# check run's id, which is where its annotations live.
{
  echo "CI failed on ${branch} at ${sha}."
  echo
  gh api "repos/{owner}/{repo}/actions/runs/$id/jobs" --jq '.jobs[]
    | "\(.name): \(.conclusion // .status)",
      (.steps[]? | select(.conclusion == "failure") | "  failed step: \(.name)")' 2>&1
  for job in $(gh api "repos/{owner}/{repo}/actions/runs/$id/jobs" \
      --jq '.jobs[] | select(.conclusion == "failure") | .id' 2>/dev/null); do
    gh api "repos/{owner}/{repo}/check-runs/$job/annotations" \
      --jq '.[] | "  \(.annotation_level) \(.path):\(.start_line) \(.message)"' 2>&1
  done
  echo
  echo "Tail of the failing log:"
  gh run view "$id" --log-failed 2>&1 | tail -30
} >&2
exit 2
