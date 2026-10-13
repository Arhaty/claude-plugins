---
name: ship
description: Build an approved spec, loop review, triage and fix until clean, write the canon, land it on the integration branch, and report in five lines
argument-hint: <spec number, e.g. 043, or the issue ID with a tracker>
disable-model-invocation: true
---

Ship spec **$ARGUMENTS** from `approved` to the integration branch.

Every decision the owner was going to be asked was asked in `/canon:define` and sits in the
spec's `## Decisions` table, and `/canon:approve` refused the spec while anything was open. So the
contract here is `.claude/rules/principles.md`'s: never block on the human for reversible work,
prove it works against the real artefact, and keep the main thread for conclusions. A question
that comes up mid-run is answered by the spec, by the canon, or by you, in that order, and logged
in the report. The ones that genuinely need the owner are under **When to ask**.

This command owns the sequence and nothing else. Each step is an existing canon skill run in a
subagent with a fresh context, pointed at the branch and the spec number, never by pasting. That
is what keeps this context small enough to run the whole loop.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>` and `<integration>` mean its `owner` and `branches.integration`.

**If it has a `tracker` block**, read `${CLAUDE_PLUGIN_ROOT}/references/tracker.md` now.
`$ARGUMENTS` is then the issue's identifier, `<ID>` below.

## Steps

**1. Check the gate, here.** Fetch, find `docs/specs/$ARGUMENTS-<slug>.md` on its remote branch,
and read its `**Status:**` line. It must say `approved`, `## Still open` must be `None.`, and
`## Decisions` must exist. Anything else: say which and stop. Never set `approved` yourself.

With a tracker, the gate is the issue's role instead of the status line: `approved`, or `blocked`
with an answer after the question (`comments <ID>`), which is a run resuming. `blocked` with no
answer: repeat the question and stop. Any other role is `/canon:build`'s own refusal: say which
and stop. The spec checks stand.

**2. Build.** One subagent, foreground: `Run /canon:build $ARGUMENTS. You are running under
/canon:ship, so report the branch, the pull request number, whether it is ready or waiting on
/canon:canon, and anything undone, and nothing about what to run next.`

A pull request left in draft **because the canon hook refused the ready mark** is normal: step 6
writes the canon. Left in draft **because the gate is red** is not: go to **When to ask**. Nor is
a stop the build reported for the owner: go to **When to ask**.

**3. Review: two read-only subagents in one message.** Each gets the spec number and the branch,
never the conversation:

- `/canon:review $ARGUMENTS`, using the `canon:reviewer` agent where it is available: the canon,
  the rule files, reuse and the spec.
- `/code-review`, scoped to `origin/<integration>...HEAD` in round one: correctness.

Tell each to return findings only, each with its consequence in the same sentence, and that
"nothing found" is a valid result.

**4. Triage, here.** You are the lead reviewer: the subagents saw a diff and a spec; you have the
Decisions table and the canon. Sort every finding into four buckets and post the whole list,
dismissed included, as one pull request comment per round, headed with the round number:

```bash
gh pr comment <number> --body-file <file>
```

- **Act on.** A correctness bug, a security gap, a canon rule broken, a spec requirement missing
  or wrong. More than five entries means you are not filtering.
- **Consider.** A valid concern whose cost is uncertain. Goes in the report.
- **Noted.** Sound but low impact, or premature. Logged, not fixed.
- **Dismissed.** Wrong, unreachable, a preference, a pattern the codebase already uses, or
  wording. One line each saying why.

**Verify a finding against the code before acting on it**: trace the call site, read the type,
run the test. A lone correctness or security finding still gets traced, never dismissed for being
alone. **An empty act-on list ends the loop**: go to step 6.

**5. Fix, one subagent, then review again.** Give it the act-on list verbatim and the branch. It
commits one logical change per finding (`Spec: NNN` in each body), pushes with
`git push -u origin HEAD`, and runs the gate. Then back to step 3, with both reviews scoped to the
fix commits only (`<last reviewed sha>..HEAD`): a re-review of reviewed code produces new
opinions, not new bugs.

- **Three review rounds, hard cap.** Round three's act-on list is the last one fixed. Findings
  after that go to **When to ask**.
- **Oscillation stops a finding, not the run.** A finding that reappears after it was fixed, or
  contradicts an earlier round, is logged under **Decided alone** and no longer counts.

**6. Canon.** A subagent runs `/canon:canon`. It writes and commits, or says in one line that
nothing settled, which is the line `ALLOW_UNDECIDED_MERGE=1` needs. Carry whichever back. If it
stopped on a product decision the spec did not settle, go to **When to ask**.

**7. Land.** A subagent runs `/canon:staging`: it archives the spec, marks the pull request
ready, waits for CI and merges. A conflict it reports as a decision goes to **When to ask**.

**8. Report, five lines, nothing else**, each starting with the bold word:

- **Shipped.** The pull request, the staging URL if configured, and the spec's archived path.
- **See it.** What to open or run to watch it work, from the spec's `## Verification`.
- **Deviations.** Where the code differs from the spec and why, or `none`.
- **Decided alone.** Questions the spec did not answer and what you chose, or `none`.
- **Review.** Rounds run, counts per bucket, the consider items in a few words, and the link to
  the last triage comment.

A sixth line only when the owner told the run to stop: **Stopped.** The step, the reason, what is
left. Post the same lines as a pull request comment first: the session may never be opened again;
the pull request will. With a tracker, post them on the issue too, as a plain comment.

## When to ask

Decide everything reversible yourself and log it under **Decided alone**. Ask the owner only for:

- A product decision the spec did not settle and the canon does not answer.
- A merge conflict `/canon:staging` names as a decision.
- A dependency the spec did not name.
- Anything irreversible outside the loop's own writes: a production change, a secret, a deletion
  others depend on.
- A build or fix that cannot pass the gate in three attempts.
- The three-round cap reached with act-on findings still open.

Ask with `AskUserQuestion`: one batched question per stop, every open point in it, each with your
recommended option first. Continue with the answer from the step that asked. Stop only if told to.

With a tracker, block first, as `tracker.md` says under **Blocked**: post the question with
`comment <ID> --blocked` and `set-state <ID> blocked`, then ask in the chat. An answer in the chat
is posted on the issue, then `set-state <ID> building`, and the run continues. With no answer in
the session, the issue stays `blocked` and `/canon:ship <ID>` resumes once the owner answers on
it.

## Hard limits

- **Never run a step here that a subagent can run.** This context reads conclusions and writes the
  triage, the questions and the report.
- **Three review rounds, never a fourth.**
- **Never widen the spec.** A finding asking for something the spec did not promise is **Noted**.
- **Never skip, weaken or delete a test to pass a gate.**
- **Never move a spec status.** `/canon:build` and `/canon:staging` do. With a tracker, the issue
  moves here only to `blocked` at a stop and back to `building` on an answer.
- **Never push to `<integration>` or the production branch directly, never force-push.**
