#!/bin/bash
# After a command that starts a CI run, watch the GitHub Actions run for the
# commit it pushed and, if it fails, exit 2 with the failing log on stderr. Exit 2
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
# empty and switched the watcher off without a word. Prints the command; whether the output says
# nothing was pushed; the directory the command ran in; and, from the last ref git reported, the
# commit it sent (`old..new  src -> dst`, empty for a `[new branch]` line), its source ref and the
# branch it wrote. All three come from one line. The output is JSON-encoded here, so a newline is
# a backslash.
read_payload='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);
const out=JSON.stringify(p.tool_response??"");
const ref=[...out.matchAll(/(?:\b[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})|\[new branch\])\s+([^\s\\]+) -> ([^\s\\]+)/g)].at(-1)??[];
const one=(v)=>String(v??"").replace(/\n/g," ");
process.stdout.write([one(p.tool_input?.command),/Everything up-to-date/.test(out)?"1":"0",one(p.cwd),ref[1]??"",ref[2]??"",ref[3]??""].join("\n"))}catch{}})'
parsed=$(printf '%s' "$input" | node -e "$read_payload" 2>/dev/null)
cmd=$(printf '%s' "$parsed" | sed -n 1p)
up_to_date=$(printf '%s' "$parsed" | sed -n 2p)
cwd=$(printf '%s' "$parsed" | sed -n 3p)
sent=$(printf '%s' "$parsed" | sed -n 4p)
src=$(printf '%s' "$parsed" | sed -n 5p)
dst=$(printf '%s' "$parsed" | sed -n 6p)

case "$cmd" in
  *"git push"*) ;;
  *"gh pr create"*) ;;
  *) exit 0 ;;
esac

# A push that moved nothing starts no run, and the newest run for the SHA is an old one.
# Unless the same call also opened a pull request, which starts a run of its own.
case "$cmd" in
  *"gh pr create"*) ;;
  *) [ "$up_to_date" = "1" ] && exit 0 ;;
esac

command -v gh >/dev/null 2>&1 || exit 0
# The directory the command ran in, which may be a worktree or another checkout: reading `HEAD`
# in the project directory watched a commit nobody pushed.
cd "${cwd:-${CLAUDE_PROJECT_DIR:-.}}" 2>/dev/null || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
# A canon project: the checkout the command ran in, or the session's project, when a worktree
# was cut from a branch that predates the config.
[ -f "$top/.claude/canon.json" ] || [ -f "${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/canon.json" ] ||
  exit 0

# What the push sent, from the line git printed: `git push origin other-branch` sends a commit
# that is not `HEAD`. A new branch prints no range, so its source ref names the commit. A commit
# this checkout cannot resolve was pushed from somewhere else (`cd ../other && git push`): stay
# quiet rather than watch the wrong one. With no ref line at all, `HEAD`.
if [ -n "$sent" ]; then
  sha=$(git rev-parse --verify -q "$sent^{commit}" 2>/dev/null) || exit 0
elif [ -n "$src" ]; then
  sha=$(git rev-parse --verify -q "$src^{commit}" 2>/dev/null) || exit 0
else
  sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
fi
# The branch the push wrote, which `git push origin feature` from `main` is not `HEAD`'s.
branch=${dst#refs/heads/}
[ -n "$branch" ] || branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

# GitHub takes a few seconds to register the run. A command that triggers nothing
# is normal — a push to a branch with no pull request starts no run —
# so give up quietly rather than reporting an absence as a problem.
#
# Only a run created after this command finished counts, less a minute for the push itself:
# a SHA can already carry an older run, failed or skipped, and watching it would report a stale
# result as this push's. A refused push and a `gh pr create` for an already-pushed SHA both start
# nothing, and the time filter is what keeps them quiet.
since=$(node -e 'process.stdout.write(new Date(Date.now()-60000).toISOString().replace(/\.\d+Z$/,"Z"))')
list_runs() {
  gh run list --commit "$sha" --limit 20 --json databaseId,conclusion,createdAt \
    --jq "map(select(.conclusion != \"skipped\" and .createdAt >= \"$since\")) | .[].databaseId" 2>/dev/null
}
ids=""
for _ in $(seq 1 20); do
  ids=$(list_runs)
  [ -n "$ids" ] && break
  sleep 3
done
[ -n "$ids" ] || exit 0
# Workflows on one push register a few seconds apart; read once more for the stragglers.
sleep 5
ids=$(printf '%s\n%s\n' "$ids" "$(list_runs)" | grep -E '^[0-9]+$' | sort -u)

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
failed=""
for id in $ids; do
  gh run watch "$id" --exit-status --interval 10 >/dev/null 2>&1 && continue
  conclusion=$(gh run view "$id" --json conclusion --jq '.conclusion' 2>/dev/null)
  case "$conclusion" in
    cancelled | skipped | neutral) ;;
    *) failed="$failed $id" ;;
  esac
done
[ -n "$failed" ] || exit 0

# The job tree and annotations say which step broke and why. The raw log is
# mostly runner noise, so it goes in trimmed and last. A job's id is its
# check run's id, which is where its annotations live.
{
  echo "CI failed on ${branch} at ${sha}."
  for id in $failed; do
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
  done
} >&2
exit 2
