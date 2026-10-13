---
name: staging
description: Archive the branch's spec, wait for CI, and merge the branch into the integration branch
argument-hint: (none, works on the current branch)
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, Edit
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
replaced) and `urls.staging` are where the work can be seen, when they are set.

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
git diff --name-only origin/<integration>...HEAD -- 'docs/specs/[0-9]*.md'
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

**6. Wait for CI on the head commit.**

```bash
gh pr checks <number> --watch --fail-fast -i 5
```

**An empty rollup is not a pass.** Confirm a run on the head SHA succeeded:

```bash
sha=$(gh pr view <number> --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/commits/$sha/check-runs" \
  --jq '[.check_runs[] | select(.conclusion == "success")] | length'
```

`0` means CI has not finished on this head: wait and read again. A repository with no CI at all
returns `0` forever: after one minute with no check run registered, say the repository has no CI
and ask the owner whether to merge on the local gate alone. Give up after about fifteen minutes and
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
