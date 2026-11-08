---
name: pickup
description: Pick the next approved issue from the tracker and ship it, one issue per run, usually from a schedule
argument-hint: (none, or --unattended when a schedule starts it)
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pickup.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" *)
  - Bash(git fetch --prune origin)
  - Read
  - Grep
  - Glob
---

Pick the next buildable issue and ship it. **$ARGUMENTS**

This is the step that replaces the owner starting `/canon:ship` by hand. The owner's part ended
at `/canon:approve`; everything here is reversible and decided by the tracker's board. One issue
per run keeps the cost bounded and means two runs never race on the integration branch.

`--unattended` in `$ARGUMENTS` means a schedule started this run and nobody is watching. The run
then never waits on `AskUserQuestion` and never guesses: where `/canon:ship` would ask, it blocks
on the issue and ends.

**Unattended means no permission prompts either.** Nobody is there to approve one, so the
environment a schedule runs in must already allow what `/canon:ship` does: `git` commits and
pushes, `gh api` calls, file edits and subagents. The grants above cover only this command's own
reads; a step that stops on a prompt leaves its issue in `building` until a later run takes it
for dead.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
**It must have a `tracker` block and `autonomy.pickup` set to `true`**: otherwise say which is
missing, that `/canon:setup` sets it, and stop. Read `${CLAUDE_PLUGIN_ROOT}/references/tracker.md`
now.

## Steps

1. **Read the board.**

   ```bash
   git fetch --prune origin
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pickup.mjs"
   ```

   It reads the issues in the `building`, `blocked` and `approved` roles, the blocked ones'
   answers, each blocked or building issue's last comment, and the remote branches' last commits, and prints one decision. It writes nothing.
   A failure is said as it is and ends the run: never pick an issue by reading the board yourself.

2. **`live`: a run is going.** An issue in `building` had a commit on its branch, an update or a
   comment within `autonomy.staleHours` (3 by default). Say which issue and when, in one line, and stop.
   Two runs at once would race on the integration branch.

3. **Block every issue in `dead` first.** Its run stopped without finishing. For each, as
   `tracker.md` says under **Blocked**, minus the chat question:

   ```bash
   printf '%s' "The run stopped without finishing. Reply \`resume\` to carry on from the branch, or say what to do instead." \
     | node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" comment <ID> --blocked
   node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" set-state <ID> blocked
   ```

   The decision already counts these as blocked with no answer, so carry on with it.

4. **`none`: nothing to build.** One line, `Nothing to build.`, then each issue in `waiting` and
   what it waits on, a few words each. No comments and no status moves beyond step 3's.

5. **`build`: claim `issue.identifier`, then ship it.** `issue.unblocks`, when set, is the issue
   it clears the way for: say so in one line. `issue.resume` true means a blocked issue the owner
   answered: ship's gate takes it as a run resuming, and `/canon:build` carries on from its
   branch.

   **Claim it first**, before anything else touches it:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" set-state <ID> building`. A second pickup
   started now meets a `building` issue updated a moment ago, takes it for a live run and stops,
   so two runs never ship the same issue. Then post a `canon: note` on the issue saying the run
   picked it up.

   Run `/canon:ship` on it **in this context**, by reading
   `${CLAUDE_PLUGIN_ROOT}/skills/ship/SKILL.md` and following it. Its arguments are `<ID>`, then
   `--picked approved` or `--picked blocked` for `issue.role`, then `--unattended` when this run
   has it, and the plugin root it names is the one this
   file was loaded from, `${CLAUDE_PLUGIN_ROOT}`. The skill cannot be invoked from here: its `disable-model-invocation` keeps
   it, and every step it starts, to the owner's own command or a file read like this one.
   Ship's gate, review caps, triage and report apply unchanged.

6. **Stop after the one issue**, whatever ship reported. The next run, scheduled or typed, picks
   the next.

## Hard limits

- **One issue per run.** Never loop back to step 1.
- **Never pick an issue `pickup.mjs` did not.** Its order is the owner's: blocked issues they
  answered, then approved ones, by priority and then age, blockers first.
- **Two status moves of its own: a dead run to `blocked`, and the picked issue to `building` as
  its claim.** Every other move is ship's, build's or the GitHub integration's. Never `approved`: that is the owner's, through `/canon:approve`.
- **Unattended, never ask in the chat.** Block on the issue and end the run.
- **Never run `/canon:approve`, `/canon:production` or `/canon:define`.**
