# Canon

How this project works today, and why. One file per domain, named for the domain. A rule here is
the default you build to and the current best answer, not law: when you see a better one, say
which rule, what it costs, and what the better answer buys, and propose the change, rather than
either obeying a rule you think is wrong or diverging from it quietly. If you cannot tell which
file a rule belongs in, the domain boundary is wrong, not the file count.

`docs/specs/` is the other half. A spec argues for one change while it is in flight and is
archived when it ships. A spec is never where to look up current behaviour; this directory is.

## Index

Route from here. `Read when` is the trigger, not a summary. Add a row when a file is created.

| File | Status | Read when |
| ---- | ------ | --------- |

## Format

Every file is the header and four sections, in this order. Start from `_TEMPLATE.md`.

1. **Header.** `Status`, `Covers`, `In one line`. Routing, never content.
2. **How it works.** Bullets, one rule each: a bolded claim, then the why in one line and only
   when the claim does not carry it. `###` groups when there are more than about fifteen. Tables
   for reference data. This is the only place a rule is stated.
3. **Not decided.** One line per open question: what it blocks and where it lands. Omitted when
   nothing is open.
4. **Rejected.** One line per option and why not. Never compressed away.
5. **Log.** One dated line per change, newest first, at most five. No reasoning.

## Status

A status says how much thinking is behind a rule, not whether it may move. Any rule changes when a
better answer appears, in the same pull request as the code, with one `Log` line.

- `proposed`: written from the code or a spec, not yet reviewed by {{owner}}.
- `accepted`: {{owner}} agreed in a pull request review. Harder to move, not fixed: moving it
  takes their agreement in the pull request, and proposing the move is still right.
- `accepted in part`: the header names which rules are which.
- `superseded (YYYY-MM-DD)`: replaced by another file, which the header names. Governs no path.

What is not allowed is building against a rule while leaving it standing, because the next reader
trusts it.

## Rules

- **Write for the next reader, human or model.** Dense, no restating, no hedging, no summary. Keep
  the connectives: `Rejected` carries conditional reasoning that misreads without them.
- **A rule is how the thing works, not how it came to work that way.** No incident narrative, no
  count of files or components, no sentence explaining why a sentence is in the file. That goes in
  the commit message or the spec.
- **Edit in place. Replace, never append.** A changed rule overwrites the old wording. A rule that
  no longer holds is deleted. Git is the record.
- **One place per rule.** Not in the header, not in the log, not restated in a second file. A
  second file that needs the rule points at the file that owns it, in half a line.
- **A file gets shorter when it can.** Merge two rules that always travel together, delete a why
  that restates its claim. If a change makes a file longer, cut something in the same commit.
- **Split by domain, never by size.** A file that stays long because it owns two domains splits
  into two files, each with its own index row and its own map entry.
- **A file is `accepted` only when {{owner}} says so in a pull request review.**
- **`/canon:canon` writes and changes files.** It runs after `/canon:review` and before
  `/canon:staging`. The plugin's `require-canon` hook refuses `gh pr create`, `gh pr ready` and the
  merge into `{{integration}}` when a governed path changed and no canon file did.
  `.claude/canon-domains.json` maps path to file. A new file needs an index row here, a map entry
  or a `$comment` line there, and a regenerated `.claude/canon-index.md`.

## When to write one

Write when the choice is expensive to reverse: a URL, a data model, a component's contract, what a
user is asked for, a third-party service, a tracking event. Not for a library version bump or a
naming preference.
