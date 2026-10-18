---
name: canon
description: Update docs/canon for what this branch settled, committed on the branch before it merges, reported in one line
argument-hint: <canon file, e.g. auth, or nothing to route from the diff>
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs" --check)
  - Read
  - Grep
  - Glob
  - Edit(./docs/canon/**)
  - Write(./docs/canon/**)
  - Edit(./.claude/canon-domains.json)
---

# Update the canon for what this branch settled

Run this **after `/canon:review`, before `/canon:staging`**: the work is built, the review will
not overturn it, and nothing has merged, so the rule lands in the same pull request as the code.
The `require-canon` hook refuses `gh pr create`, `gh pr ready` and the merge when a governed path
changed and no canon file did, so this is usually run because that hook asked.

`docs/canon/` says how the project works **today** and why. `docs/specs/` argues for one change and
is then archived. A spec is never where to look up current behaviour, and a canon file is never a
record of what a branch argued about.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>` and `<integration>` mean its `owner` and `branches.integration`.

## Route to the file

With `$ARGUMENTS`, use that file. Without it, put `git diff --name-only origin/<integration>...HEAD`
through `.claude/canon-domains.json`, cross-checked against the spec's `## Where` and the
`Read when` column in `docs/canon/README.md`. If they disagree, say so; one of them is wrong.

Two files can both be right: the map names one owner per path for the hook, which is a routing
rule rather than a limit on what you may update.

## Decide whether there is anything to write

Usually no. Write when the choice is expensive to reverse. A rename, a fix, a dependency bump, a
test, a formatting pass or a refactor that changes no rule settles nothing. Then return exactly
one line naming which change it covers and why no rule moved, and stop. The pull request proceeds
with `ALLOW_UNDECIDED_MERGE=1` in front of the `gh` command, and that line is its justification.
**Never invent a rule to satisfy a hook.**

The test: would someone reading the file afterwards now be wrong about how the project behaves? If
so, write. If not, do not.

## Read before writing

Read the whole file, `Rejected` included: re-proposing a rejected option without naming it is the
failure that section prevents. Then it is one of three cases:

- **A new rule.** One bullet in `How it works`, beside the rules it belongs with.
- **A changed rule.** Edit the bullet in place. The old wording is gone. A rule that no longer
  holds is deleted, not annotated.
- **A new file.** Rare. Start from `docs/canon/_TEMPLATE.md`, with status `proposed`. An index row
  in `docs/canon/README.md` and a map entry (or a `$comment` line) in
  `.claude/canon-domains.json`, in the same commit.

A file in an older format than `_TEMPLATE.md`: put the rule in the closest equivalent section and
do not convert the whole file as a side effect.

## Write it, do not wait for approval

The owner does not read a canon draft, so asking them to approve one is a round trip that returns
nothing. Write the rule, commit it, and name it in the hand-back; they push back in the pull
request. The one case that stops is a rule the spec's `## Decisions` table did not settle and that
changes user-facing behaviour, a URL, or what is promised to a user: that is a product decision.
Put it to `<owner>` as a question with a recommendation and leave the file untouched until they
answer.

The shape, per `docs/canon/README.md`:

- **A bolded claim and, only when the claim does not carry it, one line of why.** No history, no
  incident, no counts. That goes in the commit message.
- **It describes the code as it is today**, not what the spec proposed. If the code and the rule
  disagree, the code wins, or the code is the thing to fix.
- **One place per rule.** Other files point at it in half a line.
- **`Rejected`**: one line per option turned down. **`Not decided`**: one line per open question.
  **`Log`**: one line at the top, dated; a sixth line pushes the oldest out.
- **Status stays as it is.** Never write `accepted` yourself.

## Steps

1. **Make the edit**, updating the header if `In one line` or `Covers` moved.
2. **Make the file shorter**, or at least no longer.
3. **Update `docs/canon/README.md`** if the file is new or its status or `Read when` changed.
4. **Update `.claude/canon-domains.json`** if the rule governs a path the map does not route.
5. **Regenerate the index and check the map**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs" --check
   ```

   Fix every problem `--check` names before committing.

6. **Commit on this branch**, `docs: record <domain> rule on <what>`, body `Spec: NNN` when there
   is a spec. Its own commit unless inseparable from a line of code.

## Hand back

Which file changed and the rule as it now reads, one line each. With nothing to write, the single
no-change line and nothing else. By hand, `/canon:staging` is next.
