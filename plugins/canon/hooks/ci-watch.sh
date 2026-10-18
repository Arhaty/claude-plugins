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
# Which commands start a run is the project's to say, not GitHub's defaults: projects trim the
# `pull_request` activity types to save Actions minutes. With a `ci` block in
# `.claude/canon.json`, `lib/ci-triggers.mjs` reads the `on:` triggers of every workflow in the
# checkout, since a failure in any run on the commit is reported, and the rule is:
#
# - `gh pr create` starts a run if `opened` is a type;
# - `gh pr ready` starts one if `ready_for_review` is a type, and `gh pr reopen` if `reopened`
#   is; both watch the pull request's head, not `HEAD`;
# - `git push` starts one if a `push` trigger's branch filters take the branch, a tag push if a
#   `push` trigger has tag filters or none, or if `synchronize` is a type and the branch has an
#   open pull request.
#
# With no `ci` block, no `ci.workflow` file, or a shape the reader does not know, the types are
# GitHub's defaults, `opened`, `synchronize` and `reopened`, with no `push`: under those, marking
# a draft ready starts nothing. A command that starts nothing exits before any `gh` call, because
# watching for a run that never comes is 60 seconds of polling for an absence.
#
# Under `synchronize` without `push`, a push to a branch with no pull request starts nothing, and
# the lookup below finds no run for the commit and exits quietly. `/canon:production` opens a
# pull request from the integration branch while `HEAD` is some other commit, so its run is never
# found here; that command watches its own.
#
# It runs only in a canon project: one with `.claude/canon.json`.
#
# The match is on text, so a command that only mentions `git push` in a message wakes this for
# nothing more than a quiet lookup.

input=$(cat)

# Node rather than jq: every hook here already needs it, and a missing jq read every command as
# empty and switched the watcher off without a word. Prints the command; whether the output says
# nothing was pushed; the directory the command ran in; then each ref line git reported, as the
# commit it sent (`old..new  src -> dst`, empty for a `[new ...]` line), its source ref, the ref
# it wrote and whether git called it a new tag, tab-separated with `-` for an empty field, since
# `read` folds empty tab fields away. The output is JSON-encoded here, so a newline is a
# backslash.
read_payload='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);
const out=JSON.stringify(p.tool_response??"");
const refs=[...out.matchAll(/(?:\b[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})|\[new (branch|tag)\])\s+([^\s\\]+) -> ([^\s\\]+)/g)].map(m=>[m[1]??"-",m[3],m[4],m[2]==="tag"?"tag":"-"].join("\t"));
const one=(v)=>String(v??"").replace(/\n/g," ");
process.stdout.write([one(p.tool_input?.command),/Everything up-to-date/.test(out)?"1":"0",one(p.cwd),...refs].join("\n"))}catch{}})'
parsed=$(printf '%s' "$input" | node -e "$read_payload" 2>/dev/null)
cmd=$(printf '%s' "$parsed" | sed -n 1p)
up_to_date=$(printf '%s' "$parsed" | sed -n 2p)
cwd=$(printf '%s' "$parsed" | sed -n 3p)

case "$cmd" in
  # The group flag can come first (`gh pr -R o/r ready 12`), so the subcommand need not follow
  # `gh pr` directly; the reader below sorts out which one ran.
  *"git push"* | *"gh pr "*create* | *"gh pr "*ready* | *"gh pr "*reopen*) ;;
  *) exit 0 ;;
esac

command -v gh >/dev/null 2>&1 || exit 0
# The directory the command ran in, which may be a worktree or another checkout: reading `HEAD`
# in the project directory watched a commit nobody pushed.
cd "${cwd:-${CLAUDE_PROJECT_DIR:-.}}" 2>/dev/null || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
# A canon project: the checkout the command ran in has the config, or it is a worktree of the
# session's project, which does (a worktree cut from a branch that predates the config). A push
# from any other repository is not this project's CI.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
project_common=$(git -C "${CLAUDE_PROJECT_DIR:-/nonexistent}" rev-parse --path-format=absolute \
  --git-common-dir 2>/dev/null)
[ -f "$top/.claude/canon.json" ] ||
  { [ -n "$common" ] && [ "$common" = "$project_common" ] &&
    [ -f "$CLAUDE_PROJECT_DIR/.claude/canon.json" ]; } ||
  exit 0

# Which ref lines are tags. git says `[new tag]` for a new one and nothing for one it updated
# (`+ a...b v1 -> v1 (forced update)`), which reads like a branch: a source that is a tag here
# and not a branch is one too. git prints tags after branches, and `--follow-tags` sends both,
# so the last branch line is what the push sent; with none, the last tag line. `tags` tells the
# reader below: `none`, `only` tags, or `also` tags beside a branch.
tab=$(printf '\t')
has_branch=0
has_tag=0
sent="" src="" dst="" is_tag=0
tag_sent="" tag_src="" tag_dst=""
while IFS=$tab read -r l_sent l_src l_dst l_kind; do
  [ -n "$l_src" ] || continue
  [ "$l_sent" = - ] && l_sent=""
  if [ "$l_kind" = tag ] || [ "${l_dst#refs/tags/}" != "$l_dst" ] ||
    { git show-ref --verify -q "refs/tags/${l_src#refs/tags/}" &&
      ! git show-ref --verify -q "refs/heads/${l_src#refs/heads/}"; }; then
    has_tag=1 tag_sent=$l_sent tag_src=$l_src tag_dst=$l_dst
  else
    has_branch=1 sent=$l_sent src=$l_src dst=$l_dst
  fi
done <<REFS
$(printf '%s' "$parsed" | sed -n '4,$p')
REFS
tags=none
[ "$has_tag" = 1 ] && tags=also
if [ "$has_tag" = 1 ] && [ "$has_branch" = 0 ]; then
  tags=only is_tag=1 sent=$tag_sent src=$tag_src dst=$tag_dst
fi

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
# The branch the push wrote, which `git push origin feature` from `main` is not `HEAD`'s. A tag
# names the report, but a branch filter is read against the branch checked out.
branch=${dst#refs/heads/}
[ -n "$branch" ] && [ "$is_tag" != 1 ] || branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
label=${dst#refs/tags/}
[ "$is_tag" = 1 ] && [ -n "$label" ] || label=$branch

# Whether anything in the command starts a run under this project's triggers, decided before any
# `gh` call. A push that moved nothing starts no run, and the newest run for the SHA is an old
# one; a pull request opened, marked ready or reopened in the same call starts one of its own.
# `lib/ci-triggers.mjs` reads the command the way the guards do, so `gh pr -R o/r ready 12` is a
# ready and `gh pr ready --undo` is not. Should it fail or print nothing, the watcher falls back
# to GitHub's default types rather than watching nothing.
decision=$(printf '%s' "$input" | node "$(dirname "${BASH_SOURCE[0]}")/lib/ci-triggers.mjs" \
  "$top" "${CLAUDE_PROJECT_DIR:-}" "$branch" "$up_to_date" "$tags" 2>/dev/null)
if [ "$(printf '%s' "$decision" | sed -n 1p)" = ok ]; then
  pushed=$(printf '%s' "$decision" | sed -n 2p)
  opened=$(printf '%s' "$decision" | sed -n 3p)
  pr_sub=$(printf '%s' "$decision" | sed -n 4p)
  pr_target=$(printf '%s' "$decision" | sed -n 5p)
  pr_repo=$(printf '%s' "$decision" | sed -n 6p)
else
  pushed=0
  opened=0
  pr_sub=""
  case "$cmd" in *"git push"*) [ "$up_to_date" = 1 ] || pushed=1 ;; esac
  case "$cmd" in *"gh pr create"*) opened=1 ;; esac
  # Only the plain spellings, whose pull request is plain to see: guessing the current branch's
  # for `gh pr reopen 42` would watch someone else's run.
  reopen_n='gh pr reopen +([0-9]+)([^0-9]|$)'
  reopen_bare='gh pr reopen *($|[;&|])'
  if [[ $cmd =~ $reopen_n ]]; then
    pr_sub=reopen pr_target=${BASH_REMATCH[1]}
  elif [[ $cmd =~ $reopen_bare ]]; then
    pr_sub=reopen
  fi
fi
[ "$pushed" = 1 ] || [ "$opened" = 1 ] || [ -n "$pr_sub" ] || exit 0

# A pull request marked ready or reopened runs on its own head, which need not be `HEAD`:
# `gh pr ready 12` from another branch, or with commits not pushed yet, or in another
# repository. Ask for it, unless a push or a new pull request in the same call is what started
# the run. A pull request gh cannot read leaves `HEAD`.
if [ "$pushed" != 1 ] && [ "$opened" != 1 ]; then
  head=$(gh pr view ${pr_target:+"$pr_target"} ${pr_repo:+--repo "$pr_repo"} \
    --json headRefOid,headRefName --jq '.headRefOid + " " + .headRefName' 2>/dev/null)
  case "$head" in
    [0-9a-f]*" "?*) sha=${head%% *} label=${head#* } ;;
  esac
  # `gh run list` reads the current repository unless told otherwise.
  [ -n "$pr_repo" ] && export GH_REPO="$pr_repo"
fi

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
  echo "CI failed on ${label} at ${sha}."
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
