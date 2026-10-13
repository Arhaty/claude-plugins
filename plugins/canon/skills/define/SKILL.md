---
name: define
description: Research a change and write its spec to docs/specs, asking the owner questions until nothing is open
argument-hint: <slug or one-line description, an issue ID with a tracker, or a spec number for a revision>
disable-model-invocation: true
---

Write the spec for **$ARGUMENTS**.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on:
the project needs `/canon:setup`. Otherwise it prints the project's config. Below, `<owner>`,
`<integration>` and `<production>` mean its `owner`, `branches.integration` and
`branches.production`, and `<prefixes>` its `branches.prefixes`.

**If it has a `tracker` block**, read `${CLAUDE_PLUGIN_ROOT}/references/tracker.md` now, then
follow **With a tracker** below wherever a step names it.

## What this is for

The owner ran this and is reading the conversation as it happens. That is the point: every
decision the build would otherwise have to make is put to them here, in rounds, until none is
left. This is the one place in the loop where their time is spent on purpose, so spend it on
decisions and never on facts you could look up. `/canon:ship` builds the spec without stopping,
so a question not asked here is a guess made there.

The spec file is the record. Its `**Status:**` line, directly under the H1, is the gate every
later command reads, and `docs/specs/README.md` owns the lifecycle. This command writes `draft`
and nothing else.

## With a tracker

A new spec starts from an issue, and `$ARGUMENTS` is its identifier, e.g. `ABC-123`. Anything else
for a new spec is a stop: ask for the issue.

1. **Read the issue and its comments** with `issue` and `comments`. The title and description are
   the brief; a comment from the owner refines it.
2. **Check the role before anything else.**
   - **New spec: the role must be `ready`.** `spec` already has a spec waiting to be read, so it
     wants `/canon:approve` or a revision round on that spec; `approved` wants `/canon:build`;
     `building` or `blocked` is being built; `staging` or `production` is merged. Say which and
     stop.
   - **Revision round: the role must be `spec` or `approved`.** `approved` goes back to `spec`,
     and the status line back to `draft`, for the same reason: the approval was for text that no
     longer exists. `building` or later stops, as `in-progress` does.
3. **Set `spec` once the checks pass, before the research**: `set-state <ID> spec`. It is the board
   saying the issue is being worked, and where it rests until `/canon:approve`.
4. **The slug comes from the issue title**, and the branch is `<prefix>/<id>-<slug>` with the
   identifier in lowercase. A revision round finds it with `git branch -a --list '*/<id>-*'`. A
   branch that already exists for the identifier on a new spec is a stop: name it.
5. **The spec carries `**Issue:** <ID>`** on the line under `**Status:**`.
6. **Fill in the domain labels when the spec is written.** Put every path in `## Where` through
   `.claude/canon-domains.json`; each canon file it names is a label, `<labelPrefix><name>`,
   where `labelPrefix` is `tracker.labelPrefix` (default `domain-`) and `<name>` the file without
   `.md`: `auth.md` is `domain-auth`. Add the ones the issue lacks with `label <ID> +a,+b`, and
   remove none. A label the client reports `missing` does not exist in the workspace: say so in
   the hand-back and never create it.

## Steps

1. **Work out which round this is.**

   - **A spec number** (`/canon:define 043`, optionally with feedback) is a revision round on
     `docs/specs/043-*.md`.
   - **The current branch already adds an active spec** (`git diff --name-only
origin/<integration>...HEAD -- 'docs/specs/[0-9]*.md'` plus untracked files there) is a
     revision round on that spec, whatever the argument says.
   - **Anything else** is a new spec. Derive a kebab-case slug from the argument, three to five
     words, naming the change.

   **A revision round revises, it does not redraft.** The brief is the newest feedback. If there
   is none, ask what to revise and stop. Address exactly what it raised and do not re-run research
   it did not question. If the status is `approved`, set it back to `draft`: the approval was for
   text that no longer exists. If it is `in-progress` or later, stop: a build is running against
   it, and changing the contract under it is the owner's call.

   With a tracker, see **With a tracker**: the argument is the issue, and its role decides the
   round.

   **A new slug that is already taken is refused.** Check every spec, active and archived:

   ```bash
   git fetch --prune origin
   git ls-tree -r --name-only origin/<integration> docs/specs | grep -E "/[0-9]{3}-$slug\.md$"
   ```

   A hit means name the existing spec and stop.

2. **Get on a branch cut from a freshly fetched `origin/<integration>`, before any research.**
   Several sessions may merge into `<integration>` at once, so the local copy is often stale. A
   spec researched against last week's code names files that moved and misses the module that
   already does half the work.

   The branch is `<prefix>/<slug>`, with a prefix from `<prefixes>` matching what the change is.
   With a tracker it is `<prefix>/<id>-<slug>`. Say which in one line.

   **New spec:**

   ```bash
   git fetch --prune origin
   git checkout -b "$branch" --no-track origin/<integration>
   ```

   `--no-track` leaves the branch with no upstream until `/canon:approve` pushes it with
   `git push -u origin HEAD`. Tracking `origin/<integration>` would make a bare `git push` aim at
   `<integration>`, which the push hook refuses.

   **Revision round:** find the branch that holds the spec (`git branch -a --list '*/<slug>'`),
   check it out and bring `<integration>` in:

   ```bash
   git checkout -B "$branch" "origin/$branch" 2>/dev/null || git checkout "$branch"
   git merge --no-edit origin/<integration>
   ```

   Never check out or fast-forward the local `<integration>`: the branch hook refuses a write
   while it is checked out, and the fetch gives the research everything it needs.

3. **Take the number** (new spec only): the highest three-digit prefix across `docs/specs/**` on
   every remote branch, plus one.

   ```bash
   for ref in $(git for-each-ref --format='%(refname)' refs/remotes/origin); do
     git ls-tree -r --name-only "$ref" docs/specs 2>/dev/null
   done | grep -oE '/[0-9]{3}-' | tr -d '/-' | sort -n | tail -1
   ```

   No result means `001`. Other branches count because a spec pushed on one holds its number
   before it reaches `<integration>`.

4. **Research, in this order.** Stop as soon as the answer is settled.

   a. **The canon.** Read `docs/canon/README.md`, pick the files whose `Read when` matches the
   change, then read those, plus every file they reference. Build to what they say and never
   diverge quietly. Where a better answer exists, name the file and the line and argue the
   case in the spec as a proposed change, with what the rule costs and what the better answer
   buys. Do not edit the file.

   b. **The codebase.** What already exists that this extends or duplicates. Name the files you
   found and why each does or does not fit. The reuse ladder in
   `.claude/rules/principles.md` applies to the spec, not just the build: reuse, then extend,
   then generalise and merge, then create. This fills `## Reuse check`, which
   `/canon:approve` refuses empty.

   c. **Outside sources**, where the change has user-facing behaviour someone has already solved,
   or a technical choice that is expensive to reverse. What others got wrong is worth more
   than what they got right. Skip it for tooling and internal changes.

5. **Write the spec to `docs/specs/NNN-<slug>.md` and leave it uncommitted.**

   Start from `docs/specs/_TEMPLATE.md` and fill every section in order, with
   `**Status:** draft` directly under the H1 (and `**Issue:** <ID>` under it, with a tracker) and
   `## TL;DR` under that. A file rather than a chat
   message, because a spec goes through several rounds and is edited in place, diffed between
   rounds and handed to reviewers by path. **Do not paste the spec into the chat.** Report what
   changed and why, and let the owner read the file.

   Beyond the template's own instructions:

   - **`## Where`** lists every file that changes and every file created. `/canon:build` reads
     each one before writing code, so a missing file is a scope surprise.
   - **`## Constraints`** carries the alternatives rejected, each with the real case for it. An
     alternative with no case was dismissed, not considered.
   - **`## Decisions`** is a table, one row per answer the owner gave: the question, the answer,
     who decided. A call you made because they said "your call" is a row marked
     `Claude, recommended`.
   - **`## Still open`** is everything you could not close, or `None.`

   Then ask, in rounds, until nothing is open. Hold the open decisions as a tree: each answer
   settles one node and exposes the decisions under it. The **frontier** is every decision whose
   prerequisites are settled. Ask the whole frontier in one message, numbered, each with your
   recommended answer, and wait:

   ```text
   **Q1. <title>** <the question, choices if there are any>
   → <your recommended answer, one line>
   ```

   A fact is yours to find, never theirs: research it. A decision is theirs: put it with a
   recommendation and stop. Revise the spec after each round, write each answer into
   `Decisions`, and say what moved rather than restating the spec. Two to four rounds is normal.

6. **Stop with the spec written, the frontier empty and the status `draft`.** Say where the file
   is, how many decisions it holds, and that `/canon:approve` is next. With a tracker, also the
   issue's status and any label that was missing from the workspace.

## Hard limits

- **Two research rounds at most.** A question still open after two is a decision: put it in the
  next round with your recommendation.
- **Each question round asks the whole frontier.** One question per message is the slow failure.
- **Write `draft` and nothing else.** `approved` is `/canon:approve`'s, `in-progress` is
  `/canon:build`'s, `shipped` is `/canon:staging`'s, and `abandoned` is set only on the owner's
  instruction.
- **With a tracker, one status move: `ready` to `spec`**, or `approved` back to `spec` in a
  revision round. Never post the spec to the issue: it lives in `docs/specs/`.
- **Never commit, push or open a pull request.**
- **Do not edit `docs/canon/` on your own initiative.** If the owner asks for the canon edit
  during this pass, write it to `/canon:canon`'s format and leave it uncommitted, so
  `/canon:approve` commits it as its own change, and say it still needs their sign-off in the
  pull request.
- **Never edit `CLAUDE.md` or `.claude/settings.json`.**
