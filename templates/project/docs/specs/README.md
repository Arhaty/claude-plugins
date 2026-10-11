# Specs

One file per change in flight, `docs/specs/NNN-slug.md`, on the branch that builds it. A spec owns
the scope, behaviour and verification of that change while it is being built, and nothing after.

**`docs/canon/` is how things work; a spec is why one change was made.** A spec is a dated
argument, not a rule, and never where to look up current behaviour. That is the canon's job, and
an archived spec is provenance only.

## Lifecycle

The status is the `**Status:**` line directly under the H1. Commands find it by that prefix,
never by line number.

| Status        | Set by           | Means                                                                    |
| ------------- | ---------------- | ------------------------------------------------------------------------ |
| `draft`       | `/canon:define`  | Being argued out. Not committed until approved.                          |
| `approved`    | `/canon:approve` | {{owner}} read it. `Still open` is `None.`, committed and pushed.        |
| `in-progress` | `/canon:build`   | A build has started, in its own commit.                                  |
| `shipped`     | `/canon:staging` | Merged. Set in the commit that moves the spec to `archive/`.             |
| `abandoned`   | {{owner}} only   | Dropped. Set from any status, in the commit that moves it to `archive/`. |

`/canon:approve` refuses a spec whose `## Still open` holds anything but `None.`, that has no
`## Decisions` table, or whose `## Reuse check` is empty. `/canon:ship` builds without stopping,
so an open question there becomes a guess.

## Numbering

The next number is the highest three-digit prefix across `docs/specs/**` (active and archive, and
on other remote branches) plus one. No `spec-` prefix. A slug that is already taken is refused.

## Writing and reading

- Start from [`_TEMPLATE.md`](_TEMPLATE.md). Every spec opens with a `## TL;DR` of at most 15
  lines with a **Where to look** list.
- Never read a whole spec. Read the TL;DR, then jump to the section you need with `grep` or an
  offset read.
- If the build discovers new behaviour or a constraint, update the spec first. Local plan files
  are not authoritative.

## Archive

`/canon:staging` sets `shipped` and `git mv`s the spec to `docs/specs/archive/` in a commit on the
branch before it merges, so the merged `{{integration}}` holds no active spec for that work. An
active spec found on `{{integration}}` is unfinished work.
