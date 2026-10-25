---
name: approve
description: Approve the spec on the current branch. Checks it, sets its status to approved, commits and pushes it
argument-hint: (none, works on the current branch)
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" *)
  - Bash(git ls-tree *)
  - Bash(git ls-files *)
  - Bash(git diff *)
  - Bash(sort -u)
  - Bash(git branch --show-current)
  - Bash(git status --porcelain *)
  - Bash(git for-each-ref *)
  - Bash(git merge-base --is-ancestor *)
  - Bash(git rev-parse --verify --quiet *)
  - Bash(git fetch --quiet --prune origin)
  - Bash(git push -u origin HEAD)
  - Read
  - Grep
  - Glob
  - Edit(./docs/specs/**)
---

# Approve the spec on the current branch

`/canon:define` writes a spec, commits and pushes it as a `draft` each round, and stops. This is
the deliberate step that says the owner read it and agrees, and the only thing that makes a spec
buildable. It leaves an artefact: the spec's
`**Status:** approved` line, in a commit, on a remote branch.

It takes no argument. The branch already holds the spec, and a typed number could only disagree
with it. Find the status by the `**Status:**` prefix, never by line number.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>`, `<integration>` and `<production>` mean its `owner`, `branches.integration` and
`branches.production`.

**If it has a `tracker` block**, read `${CLAUDE_PLUGIN_ROOT}/references/tracker.md` now. Approval
is then the issue's status, not the spec line: the line still moves to `approved`, as a mirror,
and the issue moves to `approved` after the push. `<ID>` below is the spec's `**Issue:**` line.

## Refuse to approve if

Check all of these before committing anything, and stop at the first that fails. Say what is
wrong and what would fix it.

- **The current branch is `<integration>` or `<production>`.** Offer to move the work to a
  branch.
- **The branch holds no spec, or more than one.** The spec is the one active
  `docs/specs/NNN-*.md` this branch adds. The lookup also finds a staged or untracked one, so
  the refusal below can name it:

  ```bash
  { git diff --name-only --diff-filter=A --no-renames origin/<integration>...HEAD -- 'docs/specs/[0-9]*.md'
    git diff --name-only --diff-filter=A --no-renames --cached -- 'docs/specs/[0-9]*.md'
    git ls-files --others --exclude-standard -- 'docs/specs/[0-9]*.md'; } | sort -u
  ```

  Added, not edited: an uncommitted edit to another spec, such as its status line, is not this
  branch's spec. `--no-renames` keeps a renumbered spec in the list as added.

  None: say so and offer `/canon:define`. Never write one: approving a spec you wrote in the same
  breath approves nothing. More than one is two concerns on one branch: name them and stop.

- **The spec or anything in `docs/canon/` has changes no commit holds**, or the spec has no
  commit at all: `git status --porcelain -- docs/specs/<NNN-slug>.md docs/canon` names them.
  `/canon:define` commits every round, the spec and any canon edit the owner asked for, so an
  uncommitted one is a correction that skipped it, or a draft from a define that never
  committed: either wants a `/canon:define NNN` round, which commits and pushes it, not an
  approval.
- **The status is not `draft`.** `approved` means it is already approved: change nothing.
  `in-progress` or later is past this command. A missing status line wants a `/canon:define`
  pass.
- **With a tracker: the spec has no `**Issue:**` line, the branch name does not contain the
  identifier in lowercase, or the issue's role is not `spec`.** Read it with `issue <ID>`.
  `approved` is already approved: change nothing. `ready` means `/canon:define` never ran on it;
  `building` or later is past this command.
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

- **The working tree holds anything else uncommitted outside `docs/specs/`.** Code
  on an unapproved branch is a build that started early. Name the files and stop.

## Steps

1. **Read the spec**, and anything the owner said about it in this conversation since it was
   written, and with a tracker the issue's comments. A correction they made overrides the file:
   that is a `/canon:define` round, not an approval.
2. **Set the status to `approved`** by editing the `**Status:**` line and nothing else.
3. **Commit the status-line change alone**, `docs: approve spec NNN`, body `Spec: NNN` (and
   `Part of <ID>` with a tracker), following the project's commit conventions. The draft, and any canon edit beside it, is
   already committed and pushed by `/canon:define`.
4. **Push**: `git push -u origin HEAD`. Never a bare `git push`. No pull request:
   `/canon:build` opens the draft one.
5. **With a tracker, set the issue to `approved`**: `set-state <ID> approved`. After the push and
   never before: a failed push leaves the issue in `spec`, where a second `/canon:approve` picks it
   up, while `approved` with nothing on the remote sends `/canon:build` looking for a branch that
   is not there.
6. **Report** the spec number, the commit shas, the pushed branch, and that `/canon:build NNN`
   (or `/canon:ship NNN`) is next. With a tracker, name the issue and use its identifier in place
   of the number.

## Hard limits

- **One status move: `draft` to `approved`**, and with a tracker the issue from `spec` to
  `approved`. Post nothing to the issue.
- **Never open a pull request, merge or force-push.**
- **Never write the spec, and never edit it beyond the status line.**
- **There is no unattended form of this.** `/canon:ship` checks for `approved` and never sets it.
