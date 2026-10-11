---
name: approve
description: Approve the spec on the current branch. Checks it, sets its status to approved, commits and pushes it
argument-hint: (none, works on the current branch)
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, Edit
---

# Approve the spec on the current branch

`/canon:define` writes a spec and stops. This is the deliberate step that says the owner read it
and agrees, and the only thing that makes a spec buildable. It leaves an artefact: the spec's
`**Status:** approved` line, in a commit, on a remote branch.

It takes no argument. The branch already holds the spec, and a typed number could only disagree
with it. Find the status by the `**Status:**` prefix, never by line number.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>`, `<integration>` and `<production>` mean its `owner`, `branches.integration` and
`branches.production`.

## Refuse to approve if

Check all of these before committing anything, and stop at the first that fails. Say what is
wrong and what would fix it.

- **The current branch is `<integration>` or `<production>`.** Offer to move the work to a
  branch.
- **The branch holds no spec, or more than one.** The spec is the one active
  `docs/specs/NNN-*.md` this branch adds, committed or not:

  ```bash
  { git diff --name-only origin/<integration>...HEAD -- 'docs/specs/[0-9]*.md'
    git ls-files --others --modified --exclude-standard -- 'docs/specs/[0-9]*.md'; } | sort -u
  ```

  None: say so and offer `/canon:define`. Never write one: approving a spec you wrote in the same
  breath approves nothing. More than one is two concerns on one branch: name them and stop.

- **The status is not `draft`.** `approved` means it is already approved: change nothing.
  `in-progress` or later is past this command. A missing status line wants a `/canon:define`
  pass.
- **`## Still open` holds anything but `None.`** Say what is open.
- **`## Decisions` is missing**, or **`## Reuse check` is empty.** `N/A` with a reason is an
  answer; a blank section is not.
- **The branch was cut from another feature branch.**

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

  Output means it contains an unmerged branch that is not this one. The fetch in front is load
  bearing: a stale `origin/<integration>` makes the second test wrong, and a ref for a branch
  deleted after its merge makes the first one wrong. Not `git merge-base --is-ancestor
origin/<integration> HEAD`, which tests freshness rather than the base.

- **The number is taken** by another spec on any remote branch:

  ```bash
  spec=docs/specs/<NNN-slug>.md; n=<NNN>
  for ref in $(git for-each-ref --format='%(refname)' refs/remotes/origin); do
    git ls-tree -r --name-only "$ref" docs/specs 2>/dev/null | sed "s|^|$ref |"
  done | grep -E " docs/specs/(archive/)?$n-" | grep -v " $spec$"
  ```

  Name both and say `/canon:define` owes a renumber. Never renumber a spec someone else pushed.

- **The remote branch exists and the push would not be a fast-forward.**

  ```bash
  b=$(git branch --show-current)
  if git rev-parse --verify --quiet "origin/$b" >/dev/null; then
    git merge-base --is-ancestor "origin/$b" HEAD || echo "origin/$b has diverged"
  fi
  ```

  Two divergent specs need a person, not `--force-with-lease`.

- **The working tree holds anything uncommitted outside `docs/specs/` and `docs/canon/`.** Code
  on an unapproved branch is a build that started early. Name the files and stop.

## Steps

1. **Read the spec**, and anything the owner said about it in this conversation since it was
   written. A correction they made overrides the file: that is a `/canon:define` round, not an
   approval.
2. **Set the status to `approved`** by editing the `**Status:**` line and nothing else.
3. **Commit the spec as its own commit**, `docs: approve spec NNN`, body `Spec: NNN`, following
   the project's commit conventions. A `docs/canon/` edit `/canon:define` wrote at the owner's
   request gets its own second commit.
4. **Push**: `git push -u origin HEAD`. Never a bare `git push`. No pull request:
   `/canon:build` opens the draft one.
5. **Report** the spec number, the commit shas, the pushed branch, and that `/canon:build NNN`
   (or `/canon:ship NNN`) is next.

## Hard limits

- **One status move: `draft` to `approved`.**
- **Never open a pull request, merge or force-push.**
- **Never write the spec, and never edit it beyond the status line.**
- **There is no unattended form of this.** `/canon:ship` checks for `approved` and never sets it.
