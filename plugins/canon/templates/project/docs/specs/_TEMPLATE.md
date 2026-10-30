# Spec template

Use this structure for every spec in `docs/specs/`. Specs are the only durable planning artefact
for implementation work. A spec must be decision-complete before implementation starts, and any
behaviour discovered during implementation is folded back into the spec instead of a separate
local plan.

See `README.md` for the status lifecycle, {{specRules}} and archive rules. {{statusLineRule}}

---

```markdown
# {{specTitle}} — <Change name>

**Status:** draft

## TL;DR

Two to four sentences: the goal and the approach. Keep this block at most 15 lines. A reader
should be able to answer most questions from this alone.

**Where to look:**

- High-level scope: `## What`
- File-level scope: `## Where`
- Per-requirement detail: `## Requirements`
- Non-negotiables: `## Constraints`

## Reuse check

Mandatory. A spec without it is not ready to build.

- Searched: <the exact searches run and what they returned, as candidate files>
- Reuse as-is: <per candidate, yes or no, with the reason>
- Extend to reuse: <per candidate, yes or no, with the reason; a new parameter beats a new module>
- Building new is justified because: <the gap, in one paragraph>

If this spec introduces no new module, component, utility or type, write `N/A` and say why.

## What

One paragraph. What is being built and why.

## Dependencies

What must already exist, be merged or be approved before the build starts. `N/A` if none.

## Where

Every file listed here is in scope and gets a meaningful change. Files that need reading but not
changing belong in Dependencies.

New files:

- `path/to/new-file` — purpose

Changed files:

- `path/to/existing-file` — what changes

## Requirements

A numbered list. Each requirement is testable.

## Constraints

Non-negotiable rules, limits and "must not" behaviour: who can reach a new route and what it
accepts, what it costs to load, and the alternatives rejected, each with the real case for it.

## Edge cases

Each empty, error or ambiguous state and the expected behaviour.

## Interfaces and data

New or changed routes, request and response shapes, types, environment variables or external
dependencies. `N/A` if none.

## Out of scope

What this change explicitly does not include.

## Decisions

One row per decision settled while writing the spec. `/canon:build` and `/canon:ship` build to
this table and never reopen a row. A call made because the owner said "your call" is marked
`Claude, recommended`.

| Question   | Answer                             | By    |
| ---------- | ---------------------------------- | ----- |
| <decision> | <answer, with the one-line reason> | <who> |

## Still open

Anything not yet decided. Must be `None.` before `/canon:approve` accepts the spec.

None.

## Verification

Specific steps or commands. Each item names the requirement numbers it proves.
```
