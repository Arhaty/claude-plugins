<!-- canon:begin -->

## Workflow (canon)

This project uses the [canon](https://github.com/arhaty/claude-plugins/tree/main/plugins/canon) plugin. `.claude/canon.json` holds
the branch names and check commands; `/canon:setup` changes them.

### Where things are written

- **`docs/canon/`** is how the project works today and why, one file per domain.
  [docs/canon/README.md](docs/canon/README.md) is the index, with a `Read when` trigger per file.
  Read the file that governs the area you are working in, not all of them. The canon is the
  default you build to, not law: when a better answer exists, say which rule, what it costs and
  what the better answer buys, and propose the change. Never diverge from it quietly. The canon
  changes in the same pull request as the code that depends on it.
- **`docs/specs/`** holds one spec per change in flight, `NNN-slug.md`, and `archive/` holds the
  rest. A spec is a dated argument for one change, not a rule: never read an archived spec to
  learn how something works today. [docs/specs/README.md](docs/specs/README.md) owns the
  lifecycle.
- **`.claude/rules/`** holds the engineering principles and any per-area rules. A rule file with a
  `paths` frontmatter applies only to matching files.

### The loop

A spec's status is the `**Status:**` line under its title, and each command makes one move:

1. **`/canon:define <idea>`** cuts a branch from `origin/{{integration}}`, researches, and writes
   the spec. It asks {{owner}} questions in rounds until `Still open` is empty.
2. **`/canon:approve`** refuses an open spec, then sets `approved`, commits and pushes it.
3. **`/canon:build NNN`** sets `in-progress` and builds to the spec behind a draft pull request.
4. **`/canon:review`** checks the branch against this project's own rules and the spec.
   `/code-review` finds correctness bugs; run both.
5. **`/canon:canon`** writes what the branch settled into `docs/canon/`.
6. **`/canon:staging`** sets `shipped`, archives the spec, waits for CI and merges into
   `{{integration}}`.
7. **`/canon:production`** opens the release pull request into `{{production}}` and stops. That
   merge is {{owner}}'s.

`/canon:ship NNN` runs build, review and fix rounds, canon and staging in one go, asking only what
the spec did not settle. `/canon:explain` describes the work in flight in a few short sections.

Small fixes and tweaks do not need a spec. Feature work does: if there is none, run
`/canon:define` rather than building. If the build discovers new behaviour, update the spec first.{{tracker}}

### Branches and commits

- `{{production}}` is production. `{{integration}}` is integration. Neither takes a direct push or
  a direct edit.
- Branch from `origin/{{integration}}`, never from `{{production}}` or another feature branch.
  Branch names: {{prefixes}} followed by a kebab-case description.
- Push with `git push -u origin HEAD`, never a bare `git push`.
- Pull requests go into `{{integration}}`. The release pull request from `{{integration}}` into
  `{{production}}` is merged by {{owner}} and nobody else.
- One logical change per commit. Conventional commit messages.
- Before committing, run the checks: {{checks}}. If one fails, fix it or report it.

### What the hooks refuse

The plugin's hooks refuse an edit while `{{integration}}` or `{{production}}` is checked out, a push
to either, any force push, any merge into `{{production}}`, and a pull request that changes a
governed path with no canon update. Each refusal names its bypass. Setting a bypass without saying
in one line which change it covers and why defeats the check. The hooks are a seatbelt, not a
boundary: branch protection on GitHub is what actually prevents a bad change reaching
`{{production}}`.

<!-- canon:end -->
