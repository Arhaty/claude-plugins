# Specs

One file per change in flight, {{specPath}}, on the branch that builds it. A spec owns
the scope, behaviour and verification of that change while it is being built, and nothing after.

**`docs/canon/` is how things work; a spec is why one change was made.** A spec is a dated
argument, not a rule, and never where to look up current behaviour. That is the canon's job, and
a shipped spec is provenance only.

## Lifecycle

{{lifecycle}}

`/canon:approve` refuses a spec whose `## Still open` holds anything but `None.`, that has no
`## Decisions` table, or whose `## Reuse check` is empty. `/canon:ship` builds without stopping,
so an open question there becomes a guess.

{{specNaming}}

## Writing and reading

- Start from [`_TEMPLATE.md`](_TEMPLATE.md). Every spec opens with a `## TL;DR` of at most 15
  lines with a **Where to look** list.
- Never read a whole spec. Read the TL;DR, then jump to the section you need with `grep` or an
  offset read.
- If the build discovers new behaviour or a constraint, update the spec first. Local plan files
  are not authoritative.

## Archive

{{specArchiveRule}} The merged `{{integration}}` holds no active spec for that work, and an active
spec found on `{{integration}}` is unfinished work.
