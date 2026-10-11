# canon

A Claude Code plugin for one workflow: write a spec, build it, review it, record what it settled,
ship it. Specs in `docs/specs/` plan the work in flight and get archived when it ships.
`docs/canon/` is the living record of how the project works today, written from the code and
updated in the same pull request as the code it describes. Skills drive the loop, and hooks
enforce the git rules around it.

```text
 /canon:define ──▶ /canon:approve ──▶ /canon:build ──▶ /canon:review ──▶ /canon:canon ──▶ /canon:staging ──▶ /canon:production
  write spec        commit spec        draft PR          check rules       update docs/      merge into          open release PR,
  (draft)           (approved)         (in-progress)     and spec          canon             integration         owner merges
                                                                                             (shipped, archived)
                     └──────────────────── /canon:ship runs build → review → canon → staging ──────────────────┘
```

## Prerequisites

- Claude Code
- macOS or Linux (see [Limitations](#limitations)).
- Node 20 or later. The hooks and scripts use only Node built-ins; nothing is installed.
- The GitHub CLI, `gh`, authenticated. The build, staging and production steps open, read and
  merge pull requests through it.
- A git repository with two long-lived branches: an integration branch (for example `staging`)
  and a production branch (for example `main`). See [Limitations](#limitations).

## Install

```text
/plugin marketplace add arhaty/claude-plugins
/plugin install canon@arhaty
/canon:setup
```

## What setup asks and writes

`/canon:setup` reads the repository first (lockfile, `package.json` scripts, existing branches,
`git config user.name`) and offers what it finds as the default for each question:

- the owner's name: who approves specs and merges releases
- the integration branch and the production branch
- the branch prefixes (default `feat`, `fix`, `chore`, `refactor`, `docs`)
- the package manager
- the typecheck, lint, format-check and test commands, each one optional
- a per-branch preview URL pattern with `{branch}`, and the staging and production URLs, each
  optional
- a per-file formatter, and whether to enable canon in the project's `.claude/settings.json`

It then writes:

| File                                              | What it is                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `.claude/canon.json`                              | The answers. Every hook and skill reads it; nothing is hardcoded.           |
| `docs/canon/README.md`, `docs/canon/_TEMPLATE.md` | The canon index and the format each canon file follows.                     |
| `docs/specs/README.md`, `docs/specs/_TEMPLATE.md` | The spec lifecycle and template.                                            |
| `docs/specs/archive/`                             | Where shipped specs go.                                                     |
| `CLAUDE.md`                                       | A workflow section between `<!-- canon:begin -->` and `<!-- canon:end -->`. |
| `.claude/canon-domains.json`                      | Maps repository paths to the canon file that governs them. Starts empty.    |
| `.claude/canon-index.md`                          | Every canon claim on one line, generated, for scoped reviews.               |
| `.claude/rules/principles.md`                     | Starter engineering principles.                                             |
| `.claude/settings.json`                           | Only if you said yes: `enabledPlugins["canon@arhaty"]: true`, merged in.    |

**Setup never overwrites a file without asking.** It plans first, lists every file that exists
and would change, and writes nothing until you approve each one by name. In `CLAUDE.md` it only
touches its own marked section. It doesn't commit.

[templates/canon.schema.json](templates/canon.schema.json) documents every field of
`.claude/canon.json`.

## Commands

| Command                    | What it does                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `/canon:setup`             | Asks the questions above and scaffolds the project files.                                           |
| `/canon:define <idea>`     | Cuts a branch, researches, writes `docs/specs/NNN-slug.md`, and asks questions until none are open. |
| `/canon:approve`           | Checks the spec on the current branch, sets `approved`, commits and pushes it.                      |
| `/canon:build NNN`         | Builds an approved spec behind a draft pull request into the integration branch.                    |
| `/canon:review [scope]`    | Checks a branch, spec or paths against the canon, the rule files and the spec. Read-only.           |
| `/canon:canon [file]`      | Writes what the branch settled into `docs/canon/`, or says in one line that nothing did.            |
| `/canon:staging`           | Archives the spec, waits for CI, and merges the branch into the integration branch.                 |
| `/canon:production`        | Opens the release pull request with a manifest of what ships, and stops. The owner merges it.       |
| `/canon:ship NNN`          | Runs build, up to three review-and-fix rounds, canon and staging, and reports in five lines.        |
| `/canon:explain [subject]` | Explains the work in flight in three or four short sections.                                        |

`/canon:review` checks project rules. Run `/code-review` beside it for correctness bugs.

## Hooks

The hooks run only in a project with `.claude/canon.json` or `docs/canon/`, so a user-scope
install leaves other repositories alone. If `docs/canon/` exists and the config is missing or
invalid, the push, merge and canon guards refuse what they guard and say to run `/canon:setup`.

| Hook             | When                                                   | Refuses                                                                                                                                                                 | Bypass                                         |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `protect-branch` | Before Edit, Write, NotebookEdit, and Bash that writes | Any change to the project while the integration or production branch is checked out.                                                                                    | `ALLOW_PROTECTED_BRANCH_EDIT=1`                |
| `branch-notice`  | On each prompt                                         | Nothing. Says a protected branch is checked out before the first write.                                                                                                 |                                                |
| `protect-push`   | Before Bash                                            | A push landing on either protected branch, however it is spelled (refspec, upstream, `push.default`, `--all`, `--mirror`). Any force push, to any branch.               | `ALLOW_PROTECTED_PUSH=1`, `ALLOW_FORCE_PUSH=1` |
| `protect-merge`  | Before Bash and any MCP `merge_pull_request`           | Any merge into the production branch: `gh pr merge`, `gh api` merges and auto-merge, the MCP tool, or a direct ref write. A pull request it cannot read is refused too. | None. The owner merges in the GitHub UI.       |
| `require-canon`  | Before Bash and any MCP `merge_pull_request`           | `gh pr create`, `gh pr ready` or a merge into the integration branch when the change touches a path in `.claude/canon-domains.json` and no file in `docs/canon/`.       | `ALLOW_UNDECIDED_MERGE=1`                      |
| `format-file`    | After Edit and Write                                   | Nothing. Runs the configured formatter on the one file written.                                                                                                         |                                                |
| `ci-watch`       | After `git push` and `gh pr create`, in the background | Nothing. If the CI run for that commit fails, it wakes Claude with the failing step and log.                                                                            |                                                |

Each refusal says why and names its bypass. Set a bypass in front of the one command it is for,
and say which change it covers.

`protect-merge`, `protect-push` and `require-canon` fail closed if they crash. `protect-branch`
fails open, since a wrong edit is cheap to move to a branch.

**The hooks catch the routine mistake, one command early.** They read shell commands, and a
determined command can get past a string matcher. Branch protection on GitHub, for both branches,
is what stops a bad change reaching production.

### The formatter

`format-file` runs `formatFile` from `.claude/canon.json`, an argv list such as
`["pnpm", "exec", "prettier", "--write", "--ignore-unknown"]`. The edited file's path is appended
as one argument and the command runs with no shell, so a path can't inject anything.

It runs only when the project's own `.claude/settings.json` enables the plugin:

```json
{ "enabledPlugins": { "canon@arhaty": true } }
```

A user-scope install alone is not enough. Running a command named in a repository's files should
be that repository's decision, made in its committed settings. Setup offers to add the key. Set
`formatFile` to `null` to turn the hook off.

## Migrating an existing project

If the project already has local copies of these commands and hooks (the setup this plugin was
extracted from kept them in `.claude/commands/` and `.claude/hooks/`):

1. Run `/canon:setup`. It keeps your existing `docs/canon/`, `docs/specs/` and
   `.claude/canon-domains.json`, and asks before changing anything that differs.
2. Delete the local copies the plugin replaces: `.claude/commands/{define,approve,build,ship,review,canon,staging,production,explain}.md`
   and `.claude/hooks/{protect-branch,branch-notice,protect-push,protect-merge,require-canon,ci-watch,format-file,merge-command,push-command,writes-to-worktree}.mjs`
   (and `ci-watch.sh`), and remove their entries from the `hooks` block of
   `.claude/settings.json`. Otherwise every hook runs twice.
3. Keep anything project-specific: other commands, skills, rules, and any hook the plugin doesn't
   replace.

Setup lists what it finds in step 2 and offers to delete it.

If your canon index came from a `canon:index` script, the plugin's
`node <plugin>/scripts/canon-index.mjs` writes the same `.claude/canon-index.md`, and
`--check` exits 1 when it is stale or the domain map points at a missing file. You can run that
in CI.

## Updating

```text
/plugin marketplace update arhaty
/plugin update canon@arhaty
```

Re-run `/canon:setup` after an update that changes the templates. It shows what would change and
asks before writing.

## Limitations

- **Two branches are required.** A repository with only `main` isn't supported in this version.
- **macOS and Linux only.** Windows isn't supported in v0.1 and isn't in the CI matrix. The hook
  tests stub `gh` and `git` with POSIX shell scripts, `ci-watch` is a bash script, and the
  scaffolder hasn't been checked with Windows path separators.
- **GitHub only.** The pull request steps use `gh`.
- **Merge commits into the integration branch.** `/canon:staging` merges with a merge commit, and
  `/canon:production` relies on that to spot commits that skipped a pull request. A repository
  that only allows squash merges still works, but loses that check.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](../../SECURITY.md). The [examples](examples/) show a filled-in spec and the
canon file it produced.

## License

MIT. See [LICENSE](../../LICENSE).
