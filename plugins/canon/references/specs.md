# Where the spec lives, and how it ends

Read this when `.claude/canon.json` has a `specs` block. Each setting left out is the behaviour
the skills describe, and the whole block left out is all of them: `naming` `"number"`, `archive`
`"repo"` and `commitWhileDrafting` `true`.

## The file: `specs.naming`

- **`number`**: `docs/specs/NNN-<slug>.md`, as the skills describe.
- **`branch`**: `docs/specs/<branch>.md`, named after the branch the spec is on, with each `/` in
  the branch name as `-`: `docs/specs/abc-123-rate-limit-reset.md`, or
  `docs/specs/feat-rate-limit.md` for `feat/rate-limit`. There is no number:
  - **Finding the branch's spec** is that one path, never the `'docs/specs/[0-9]*.md'` lookup:
    `spec="docs/specs/$(git branch --show-current | tr / -).md"`. It exists, committed, staged or
    untracked, or the branch has no spec. Where a skill reads "the one active spec the branch
    adds", it is this file.
  - **Wherever a skill says `NNN`**, in a commit subject, a `Spec: NNN` body line or a hand-back,
    use the file name without `.md`.
  - **`/canon:define` takes no number** and runs no slug check: the branch is new, so its file
    name is too. A file of that name already on another remote branch is a stop.
  - **A command that takes a spec number** (`/canon:build`, `/canon:ship`, `/canon:review`) takes
    the issue identifier with a tracker, and the branch name without one.

## The status line

**With a tracker, the `**Status:**` line is optional.** The issue's role is the status and the
gate. A spec without the line is complete, and no command adds one: the steps that would move it
(`/canon:approve` step 2, `/canon:build` step 3, `/canon:staging` step 4) skip the edit, and a
commit that would have held only the edit is not made. A refusal that reads the line reads the
issue's role instead. A spec with the line keeps it mirroring the issue, as before. Without a
tracker the line is the gate and stays required.

## Drafting: `specs.commitWhileDrafting`

- **`true`**: `/canon:define` commits and pushes the spec every round, as it describes.
- **`false`**: the spec stays uncommitted while it is drafted.
  - **`/canon:define`** writes the spec, and any `docs/canon/` edit the owner asks for, and
    commits and pushes nothing, in any round. The branch it cuts has no upstream. A revision round
    edits the file in place; there is never a commit or push owed. Say in the hand-back that the
    draft is on this machine only, until `/canon:approve`.
  - **`/canon:approve`** expects the uncommitted spec: changes no commit holds, in the spec or in
    `docs/canon/`, are not a refusal. Every other check stands. It commits the spec, with its
    status line set when it has one, as `docs: approve spec NNN`; a `docs/canon/` edit as a commit
    of its own; and then pushes with `git push -u origin HEAD`. That push is the first.

## When it ships: `specs.archive`

- **`repo`**: `/canon:staging` marks the spec `shipped` and moves it to `docs/specs/archive/`.
- **`tracker`**, which needs a `tracker` block: the issue is the archive, and `docs/specs/` holds
  only work in flight. `/canon:staging` step 4 is instead:

  ```bash
  printf '%s' "$(cat "$spec")" | node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" comment <ID>
  git rm -q -- "$spec"
  git commit -m "docs: archive spec to <ID>" -m "Part of <ID>"
  ```

  **Post first, and stop if the post fails.** Never delete a spec that was not posted: the comment
  is the only copy that outlives the branch. The deletion is a commit on the branch, so it merges
  with the work and the integration branch never carries the spec. The status line, if any, is
  not set to `shipped` first: the issue says it. The hand-back names the issue the spec was
  posted to instead of an archived path, and `/canon:production` counts a spec deleted from
  `docs/specs/` in the release as one that shipped.

- **Numbers, with `tracker` and `naming` `"number"`.** A shipped spec leaves `docs/specs/`, so the
  files alone would give its number out again. `/canon:define` step 3 takes the highest
  three-digit prefix ever committed under `docs/specs/`, on any branch, plus one:

  ```bash
  git -c core.quotePath=false log --all --format= --name-only -- docs/specs \
    | grep -oE '^docs/specs/[0-9]{3}-' | grep -oE '[0-9]{3}' | sort -n | tail -1
  ```

  In a shallow clone (`git rev-parse --is-shallow-repository` prints `true`), run
  `git fetch --unshallow origin` first: the history is the record.

- **Abandoned, with `tracker`.** On the owner's instruction only, post the spec to its issue,
  stopping if the post fails, then delete its branch unmerged:

  ```bash
  { printf 'Abandoned.\n\n'; cat "$spec"; } | node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" comment <ID>
  ```

  The status line is not set: the integration branch never held the spec, and the comment is the
  only copy. The owner cancels the issue in the tracker. With the branch gone, the spec's number
  can be given out again; none of its commits reached `<integration>`, so nothing there collides.
