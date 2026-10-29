---
name: review
description: Check a branch, spec or paths against this project's canon, rule files and spec. Complements /code-review
argument-hint: <spec number (optionally with a sha range), paths, globs, or a git range; nothing reviews the branch>
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs" --check)
  - Bash(git diff *)
  - Bash(git log *)
  - Read
  - Grep
  - Glob
---

# Check a diff against this project's own rules

**This does not replace `/code-review`.** That one finds correctness bugs. This one finds
violations of rules specific to this repository that a general reviewer cannot know: a rule in
the canon, a rule file, the reuse principle, and the spec the branch was built to. Run both before
a pull request merges.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>` and `<integration>` mean its `owner` and `branches.integration`, and **the
gate** is its non-null `commands`, run as `${CLAUDE_PLUGIN_ROOT}/references/gate.md` says.

## The bar a finding has to clear

**Every finding names its consequence in the same sentence: what breaks, who sees it, or the canon
file, rule or spec requirement it contradicts.** If that clause cannot be written, there is no
finding.

These are not findings, and reporting one is a defect in the review:

- **Prose style** in a spec, canon file, rule file, README or commit message.
- **A comment's wording**, a name that is merely not the one you would pick, import order.
- **An alternative implementation that is no better.**
- **A problem only a feature nobody has built would have.**
- **Anything a check already decided.** The gate runs below; its verdict stands.
- **A hedge.** "Consider", "you might want to", "it may be worth" mean there is no consequence.

Do not soften the other direction: a rule genuinely broken is a finding at any size.

## Do not restate the rules here

They live in `CLAUDE.md`, `.claude/rules/` and `docs/canon/`. Read them, then check the diff
against what you read. `CLAUDE.md` is already loaded. Read, in this order:

1. **`.claude/rules/principles.md`**, always, then each rule file whose `paths` frontmatter matches
   what the diff touches. Match by path; do not read every rule file by default.
2. **`.claude/canon-index.md`, scoped to the diff.** Every canon claim and table row, each line
   prefixed with the file that owns it. Put the paths under review through
   `.claude/canon-domains.json` to name the canon files they touch, use the index's routing table
   for a path the map does not cover, then grep:

   ```bash
   grep -E '^(auth|billing)\.md' .claude/canon-index.md
   ```

   If the index is missing or stale (`node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs" --check`
   exits 1), read the canon files' `How it works` sections directly. **Open a canon file itself
   when you have a finding** and need the reasoning around a claim. Cite the canon file, never the
   index.

3. **The spec, when the branch has one.** Read its `## TL;DR`, `## Requirements`,
   `## Verification` and `## Where`; never the whole file. A requirement the diff does not meet,
   or behaviour no requirement asked for, is a blocker. The spec is the one `$ARGUMENTS` names,
   or the one active spec the branch adds:

   ```bash
   git diff --name-only --diff-filter=A --no-renames origin/<integration>...HEAD -- 'docs/specs/[0-9]*.md'
   ```

**An unannounced contradiction with the canon is the most serious finding available**, more
serious than a bug, because the code is what will be believed later and the rule left standing is
what the next reader trusts. A divergence from a `proposed` canon file is a note that names the
rule and asks the owner.

If the diff changes a canon file: it lands in the same pull request as the code that depends on
it, a changed rule is edited in place, and a new file starts from `docs/canon/_TEMPLATE.md` and
gets an index row and a map entry in the same change.

## What to review

`$ARGUMENTS` is the scope. Resolve it first:

- **Nothing**: the branch, `git diff origin/<integration>...HEAD`. A bare call always means the
  branch, never the scope of an earlier call.
- **Paths or globs**: those files whole, as they stand on disk.
- **A git range or a ref**: that diff instead.
- **A spec number**: the code written for that spec, against it. The branch that adds the spec
  when it is checked out; otherwise the branch named for the slug; for a merged spec, the commits
  carrying `Spec: NNN`. If none resolves, say so and stop.
- **An issue identifier** (`ABC-123`), when the config has a `tracker`: the spec whose
  `**Issue:**` line names it, reviewed as a spec number would be.
- **A spec number and a range** (`031 abc123..HEAD`): a later review round. Only the commits in
  the range are reviewed; earlier code is not re-litigated.

Never widen a scope that was given, and never fall back to `HEAD` when it fails to resolve.
Reviewing a document (a spec, a canon file) is a real scope: check what it promises against the
canon, and skip the code checks.

Within a diff, review only what it changes. A pre-existing violation in a touched file is one
note, not a blocker.

## Checks worth running rather than reading

Skip for a scope with no code. Otherwise run the gate with `set -o pipefail` (a pipeline without
it reports a failing suite as a pass). A check that is not configured is noted as absent.

Then, against the diff only:

- **Reuse.** For every new module, read where similar things live and search for similar purpose
  or shape. Creating comes last: reuse, extend, generalise, then create. The pull request has to
  say what was evaluated and why none fit; if it does not, that is the finding.
- **A new dependency** without a justification in the pull request or the spec.
- **A secret, key or credential** in the diff. That stops the review immediately.
- **Scope the spec did not define**: a route, page, command or feature no spec asked for.
- **`CLAUDE.md`, `.claude/settings.json` or `.claude/canon.json` changed** without being asked.
- **Debug output left in committed code**, where the project's rules forbid it.
- Anything a rule file that matches the diff names as checkable.

## Reporting

**Report what is broken. Report nothing else.** No list of what passed, no account of what was
read, no summary.

- **Blockers.** Contradicts the canon or misses a spec requirement, adds an unjustified
  dependency, leaks a secret, adds unrequested scope, breaks a check, or edits a file that needs
  asking first.
- **Notes.** Everything else that cleared the bar, including duplication out of scope here.

A blocker is the silent divergence, not the disagreement. When the branch's answer is better than
the canon's, say which rule the code has outgrown and what it should say, so `/canon:canon` moves
the rule rather than the code.

One line per finding: the file and line, what is wrong, the consequence. Drop an empty group. When
nothing cleared the bar, the whole report is one line saying so.
