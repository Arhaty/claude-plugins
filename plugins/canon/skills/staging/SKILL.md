---
name: staging
description: Archive the branch's spec, wait for CI, and merge the branch into the integration branch
argument-hint: (none, works on the current branch)
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" *)
  - Bash(git fetch --quiet --prune origin)
  - Bash(git fetch --prune origin)
  - Bash(git push -u origin HEAD)
  - Bash(git pull --ff-only)
  - Bash(git branch --show-current)
  - Bash(git for-each-ref --format='%(refname:short)' refs/remotes/origin)
  - Bash(git merge-base --is-ancestor *)
  - Bash(gh pr view *)
  - Bash(gh pr list *)
  - Bash(gh pr checks *)
  - Bash(gh pr ready *)
  - Read
  - Grep
  - Glob
  - Edit(./docs/specs/**)
---

# Land the current branch on the integration branch

A draft pull request gives a private look at a branch. This is the deliberate step that lands it
on the integration branch, so it merges without waiting for a review. The decision was made by
asking for it.

**This is the whole path, not the second half of one.** If the branch has no pull request yet,
open one and carry on.

**Automatic merging means no second pair of eyes.** That is acceptable because the integration
branch is not production: a bad merge there costs a revert. It is exactly why
`/canon:production` does not do the same: merging into production is the owner's alone, and the
`protect-merge` hook enforces it.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>`, `<integration>` and `<production>` mean its `owner`, `branches.integration` and
`branches.production`; **the gate** is its non-null `commands`; `urls.preview` (with `{branch}`
replaced) and `urls.staging` are where the work can be seen, when they are set. A `ci` block
names the workflow step 6 starts when nothing has run on the head commit.

**If it has a `tracker` block**, read `${CLAUDE_PLUGIN_ROOT}/references/tracker.md` now. This
command **never sets the issue's status**: the merge does, through the tracker's GitHub
integration, from the `Fixes <ID>` line in the pull request body. `<ID>` is the spec's
`**Issue:**` line.

## Requires `gh`

Merging needs the API. Without an authenticated `gh`, say so and give the pull request URL so the
owner can merge it. **Do not work around it with `git merge` and a push**: the push hook refuses
the push to `<integration>`, and a local merge produces no pull request and no CI run.

## Refuse to merge if

Check all of these before merging, and stop at the first that fails.

- **The current branch is `<integration>` or `<production>`.**
- **The branch was cut from another feature branch.** Same check as `/canon:approve`:

  ```bash
  git fetch --quiet --prune origin
  b=$(git branch --show-current)
  git for-each-ref --format='%(refname:short)' refs/remotes/origin \
    | grep -vE "^origin/(HEAD|$b)$" \
    | while read -r ref; do
        git merge-base --is-ancestor "$ref" HEAD 2>/dev/null \
          && ! git merge-base --is-ancestor "$ref" origin/<integration> 2>/dev/null \
          && echo "cut from $ref"
      done
  ```

- **The pull request has conflicts** or GitHub reports it not mergeable. A `null` `mergeable` is
  still being computed: read again, never take it as mergeable.
- **CI failed** (a fix on this branch, not a retry) or **has not finished** (wait).
- **The base is not `<integration>`.** A pull request into `<production>` is a release.
- **The gate fails locally.**
- **The branch has an unpushed commit.** What CI checked is not what would merge.
- **A governed path changed and no canon file did.** Run `/canon:canon` first rather than meeting
  the hook here.
- **The branch adds more than one active spec, or its spec is not `in-progress`.** Two specs is
  two concerns. A `draft` or `approved` spec means the work was not built through
  `/canon:build`: say which and let the owner decide; never move a status this command does not
  own.

- **With a tracker, the pull request body does not close the issue**: no `Fixes <ID>` line, or
  the identifier sits beside a contributing word (`Part of`, `ref`, `related to`,
  `contributes to`, `towards`), which links the pull request and stops the merge moving the
  issue. Read it with `gh pr view <number> --json body -q .body`. This one is free to fix and
  this command fixes it: rewrite the body with a `Fixes <ID>` line and no contributing word for
  `<ID>` (`gh pr edit <number> --body-file <file>`), then carry on. After the merge it cannot be
  fixed: a merge event does not replay.

## Steps

**1. Bring `<integration>` in first, and settle any conflict here.**

```bash
git fetch --prune origin
git merge --no-edit origin/<integration>
git push -u origin HEAD
```

`-u origin HEAD`, never a bare push. A merge, never a rebase. **Resolve a mechanical conflict and
stop on anything else**: two branches appending to one list or a lockfile is mechanical; two
branches changing the same behaviour or the same canon file is a decision for the owner. Never
resolve a conflict by taking one side wholesale.

**2. Run the gate locally.** If it fails, stop and fix it. Do not push a branch you know is red.

**3. Commit anything uncommitted**, following the project's commit conventions.

**4. Mark the spec shipped and archive it, in its own commit.** The branch's spec is the one
active `docs/specs/NNN-*.md` it adds:

```bash
git diff --name-only --diff-filter=A --no-renames origin/<integration>...HEAD -- 'docs/specs/[0-9]*.md'
```

None means a branch with no spec, which a small fix is: carry on and say so. Otherwise set the
`**Status:**` line from `in-progress` to `shipped`, and nothing else, then:

```bash
git mv docs/specs/NNN-slug.md docs/specs/archive/NNN-slug.md
git add docs/specs/archive/NNN-slug.md
git commit -m "docs: archive spec NNN" -m "Spec: NNN"
```

The `git add` is not redundant: `git mv` carries the status edit along unstaged. `/canon:canon`
comes before this: the canon replaces the spec, so archiving first leaves the behaviour
documented nowhere.

**5. Push, then make sure there is a pull request.**

```bash
git push -u origin HEAD
gh pr view --json number,state,baseRefName,mergeable,url
```

If none is open, `gh pr create --base <integration>` with a body covering what changed, why and
how to verify, and with a tracker a `Fixes <ID>` line. Then `gh pr ready <number>`, which is idempotent: `/canon:build` leaves the pull
request in draft when the canon hook refused the ready mark.

**6. Wait for CI on the head commit.** Read the head and the buckets every query below sorts a
run into:

```bash
sha=$(gh pr view <number> --json headRefOid -q .headRefOid)
buckets='if .status != "completed" or .conclusion == "action_required" then "pending"
  elif .conclusion == "success" then "success"
  elif (.conclusion | IN("skipped", "neutral", "cancelled", "stale")) then "ignored"
  else "failing" end'
```

`pending` means wait and read again (`action_required` waits on a person). `failing` is a fix on
this branch. `ignored` is neither: a run that skipped itself, or one cancelled or made stale by a
later run on the same head. **A query that fails is not an empty answer.** Each one below prints
`none` when it finds no run, and nothing when `gh api` fails: say GitHub's error and stop, never
read it as nothing having run.

**With a `ci` block, start the workflow first if nothing has run on the head.** Some projects run
CI only when a pull request opens or leaves draft, so nothing runs on a later commit, including
the merge commit step 1 pushed. Below, `<workflow>` and `<baseInput>` are `ci.workflow` and
`ci.baseInput`. Read the configured workflow's runs on the head:

```bash
runs=$(gh api --paginate "repos/{owner}/{repo}/actions/workflows/<workflow>/runs?head_sha=$sha&per_page=100" \
  --jq ".workflow_runs[] | $buckets") \
  && if [ -z "$runs" ]; then echo none; else sort <<<"$runs" | uniq -c; fi
```

A `404` here means no workflow file has that name on the default branch: say `ci.workflow` is
wrong and stop.

If step 5 pushed a commit, opened the pull request or took it out of draft, a run those started
can take a while to register: read every 15 seconds for up to 90 seconds before taking an empty
answer as final. Otherwise one read is enough.

- **`success` or `pending`: do not dispatch.** A dispatch on top of a queued or running run is a
  second full run, and the two do not collapse: a typical `concurrency` key
  (`pull_request.number || ref`) puts them in different groups.
- **`failing`: do not dispatch.** CI failed on this head, which is a fix on this branch, not a
  retry.
- **Nothing else (`none`, or only `ignored`): dispatch, once for this head.**

```bash
branch=$(gh api "repos/{owner}/{repo}/pulls/<number>" \
  --jq 'select(.head.repo.full_name == .base.repo.full_name) | .head.ref')
gh api -X POST "repos/{owner}/{repo}/actions/workflows/<workflow>/dispatches" \
  -f ref="$branch" -f "inputs[<baseInput>]=<integration>"
```

An empty `branch` is a pull request from a fork, whose branch this repository does not have: say
so and do not dispatch. Leave out the `inputs` field when `<baseInput>` is null. `branch` is read
off the pull request because an empty `ref` fails without saying why. The base input is for a
workflow that diffs against the base to skip work: a dispatched run carries no
`pull_request.base.sha`, so without it every dispatched run counts as everything changed.

**A dispatch that fails is reported in one line and never retried:**

- `404`: `<workflow>` is not on the default branch, or no workflow has that name. GitHub
  dispatches only a workflow file the default branch has.
- `422` saying the workflow has no `workflow_dispatch` trigger: add one, or remove the `ci` block
  so this command only waits.
- `422` about unexpected inputs: the workflow declares no `<baseInput>` input. Fix `ci.baseInput`,
  or set it to null.
- Anything else: GitHub's message, as it is.

After a dispatch, read the workflow query every 15 seconds until it shows the run. **Never
dispatch a second time for the same head.** A minute with still no run on `$sha`:

- **The head moved** (`gh pr view <number> --json headRefOid` no longer gives `$sha`): the
  dispatch ran on the new tip. That is step 7: go back to step 5.
- **Otherwise the run failed to start:** say so and stop.

**Then wait for the checks.** Without a `ci` block, watch them:

```bash
gh pr checks <number> --watch --fail-fast -i 5
```

With one, poll the two queries every 30 seconds instead: a dispatched run may not appear in the
pull request's checks, so the watch can end before it starts. The queries decide either way.

**Only a success on the head SHA is a pass.** An empty rollup, a missing run and a run that
ended `skipped` or `neutral` are not: none of them shows the code passed. Nor is one quick check
that succeeded while the rest are still running or have failed. Read every check run on the head
SHA:

```bash
runs=$(gh api --paginate "repos/{owner}/{repo}/commits/$sha/check-runs?per_page=100" \
  --jq ".check_runs[] | $buckets") \
  && if [ -z "$runs" ]; then echo none; else sort <<<"$runs" | uniq -c; fi
```

It passes only when at least one is `success`, none is `pending` and none is `failing`. An
`ignored` run is why a success is still required. **With a `ci` block, the configured workflow's
success is required too**, read again from the workflow query on every poll, never from the read
before the dispatch: a success from another app, a deploy preview or a scanner, does not show CI
passed. A dispatched run that ends `ignored` with no `success` beside it means the workflow
skipped itself on this head: say so, and ask the owner whether to merge on the other checks. No `success` at all means CI has not finished on
this head, or never ran: wait and read again. A repository with no CI at all, and no `ci` block,
never shows one: after one minute with no check run registered, say the repository has no CI and
ask the owner whether to merge on the local gate alone. Give up after about fifteen minutes and
say where to look.

**7. If anything in steps 5 or 6 produced a commit, go back to step 5.** Green checks on a commit
that is no longer the head verify nothing.

**8. Merge on the head CI verified, and delete the branch.**

```bash
sha=$(gh pr view <number> --json headRefOid -q .headRefOid)
gh pr merge <number> --merge --delete-branch --match-head-commit "$sha"
```

`--merge`, not `--squash`: `/canon:production` finds work that reached `<integration>` without a
pull request by listing non-merge commits on its first-parent path, and that only works while
reviewed work arrives as merge commits. If the repository does not allow merge commits, merge the
way it does allow and say in the hand-back that the production check is weaker for it.
`--match-head-commit` makes GitHub refuse if the branch moved since CI ran.

**9. Clean up locally.**

```bash
git checkout <integration> && git pull --ff-only && git branch -d <branch>
```

## Hand back

- What changed, in one line.
- The spec it shipped, by number and archived path, or that the branch had none.
- That it merged, and where to see it: `urls.staging` if set. If `urls.preview` is null, say the
  branch had no preview, so the integration deployment is the first served build of the work.
- That production is unaffected.
- **With a tracker**, the issue's status a minute after the merge (`issue <ID>`). Still not at
  `staging`: say so, and that the GitHub integration's branch rule for `<integration>` or the pull
  request body is what to check. Never set it by hand.
- **If this command opened the pull request itself, say so**: nobody read the diff.
