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
  merge pull requests through its REST calls, `gh api`, so they also run in a Claude Code cloud
  session. See [Cloud sessions](#cloud-sessions).
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
- a per-file formatter, and whether you approve running it
- whether to enable canon in the project's `.claude/settings.json`
- whether `/canon:staging` should start CI when nothing has run on the head commit, and with
  which workflow. See [CI that skips later commits](#ci-that-skips-later-commits).
- whether to use an issue tracker: the team key, where the API key comes from, and which of the
  team's statuses each step of the loop moves an issue to. See
  [Configuring Linear](#configuring-linear).

It then writes:

| File                                              | What it is                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `.claude/canon.json`                              | The answers. Every hook and skill reads it; nothing is hardcoded.            |
| `docs/canon/README.md`, `docs/canon/_TEMPLATE.md` | The canon index and the format each canon file follows.                      |
| `docs/specs/README.md`, `docs/specs/_TEMPLATE.md` | The spec lifecycle and template.                                             |
| `docs/specs/archive/`                             | Where shipped specs go.                                                      |
| `CLAUDE.md`                                       | A workflow section between `<!-- canon:begin -->` and `<!-- canon:end -->`.  |
| `.claude/canon-domains.json`                      | Maps repository paths to the canon file that governs them. Starts empty.     |
| `~/.claude/canon/trusted.json`                    | Outside the project, only if you approved a formatter or an API key command. |
| `.claude/canon-index.md`                          | Every canon claim on one line, generated, for scoped reviews.                |
| `.claude/rules/principles.md`                     | Starter engineering principles.                                              |
| `.claude/settings.json`                           | Only if you said yes: `enabledPlugins["canon@arhaty"]: true`, merged in.     |

**Setup never overwrites a file without asking.** It plans first, lists every file that exists
and would change, and writes nothing until you approve each one by name. In `CLAUDE.md` it only
touches its own marked section. An existing `.claude/canon-domains.json`, `docs/canon/README.md`
or `docs/specs/README.md` is kept as it is, never offered for replacement. It refuses to write
through a symlink that leads outside the project or nowhere. It doesn't commit.

[templates/canon.schema.json](templates/canon.schema.json) documents every field of
`.claude/canon.json`.

## Commands

| Command                    | What it does                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/canon:setup`             | Asks the questions above and scaffolds the project files.                                                                 |
| `/canon:define <idea>`     | Cuts a branch, researches, writes `docs/specs/NNN-slug.md`, pushes it each round, and asks questions until none are open. |
| `/canon:approve`           | Checks the spec on the current branch, sets `approved`, commits and pushes it.                                            |
| `/canon:build NNN`         | Builds an approved spec behind a draft pull request into the integration branch.                                          |
| `/canon:review [scope]`    | Checks a branch, spec or paths against the canon, the rule files and the spec. Read-only.                                 |
| `/canon:canon [file]`      | Writes what the branch settled into `docs/canon/`, or says in one line that nothing did.                                  |
| `/canon:staging`           | Archives the spec, waits for CI, and merges the branch into the integration branch.                                       |
| `/canon:production`        | Opens the release pull request with a manifest of what ships, and stops. The owner merges it.                             |
| `/canon:ship NNN`          | Runs build, up to three review-and-fix rounds, canon and staging, and reports in five lines.                              |
| `/canon:explain [subject]` | Explains the work in flight in three or four short sections.                                                              |

`/canon:review` checks project rules. Run `/code-review` beside it for correctness bugs.

With a tracker configured, `/canon:define`, `/canon:build` and `/canon:ship` take an issue ID such
as `ABC-123` where they would take an idea or a spec number. See
[Configuring Linear](#configuring-linear).

## Walkthrough

TODO: a real run from define to production, taken from a project that has migrated to the plugin.

## Hooks

The hooks run only in a project with `.claude/canon.json` or `docs/canon/`, so a user-scope
install leaves other repositories alone. If `docs/canon/` exists and the config is missing or
invalid, the push, merge and canon guards refuse what they guard and say to run `/canon:setup`.

| Hook             | When                                                    | Refuses                                                                                                                                                                                                                                                                                                                                             | Bypass                                         |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `protect-branch` | Before Edit, Write, NotebookEdit, and Bash that writes  | Any change to the project while the integration or production branch is checked out.                                                                                                                                                                                                                                                                | `ALLOW_PROTECTED_BRANCH_EDIT=1`                |
| `branch-notice`  | On each prompt                                          | Nothing. Says a protected branch is checked out before the first write.                                                                                                                                                                                                                                                                             |                                                |
| `protect-push`   | Before Bash                                             | A push landing on either protected branch, however it is spelled (refspec, upstream, `push.default`, `--all`, `--mirror`). Any force push, to any branch.                                                                                                                                                                                           | `ALLOW_PROTECTED_PUSH=1`, `ALLOW_FORCE_PUSH=1` |
| `protect-merge`  | Before Bash and any MCP `merge_pull_request`            | Any merge into the production branch: `gh pr merge`, `gh api` merges and auto-merge, the MCP tool, or a direct ref write. Any `gh api` write naming that branch, a contents write with no branch, and a GraphQL mutation that moves a branch or can't be read. A pull request it cannot read is refused too.                                        | None. The owner merges in the GitHub UI.       |
| `require-canon`  | Before Bash and any MCP `merge_pull_request`            | `gh pr create`, `gh pr ready` or a merge into the integration branch, or their `gh api` REST forms, when the change touches a path in `.claude/canon-domains.json` and no file in `docs/canon/`.                                                                                                                                                    | `ALLOW_UNDECIDED_MERGE=1`                      |
| `format-file`    | After Edit, Write and NotebookEdit                      | Nothing. Runs the configured formatter on the one file written.                                                                                                                                                                                                                                                                                     |                                                |
| `ci-watch`       | After a command that starts a CI run, in the background | Nothing. If a CI run for that commit fails, it wakes Claude with the failing step and log. It reads the workflows' `on:` triggers to tell which of `git push`, `gh pr create`, `gh pr ready` and `gh pr reopen`, or their REST forms, start a run, and watches a `workflow_dispatch`; with none it can read, GitHub's default `pull_request` types. |                                                |

Each refusal says why and names its bypass. Set a bypass in front of the one command it is for,
and say which change it covers.

`protect-merge`, `protect-push` and `require-canon` fail closed if they crash. `protect-branch`
fails open, since a wrong edit is cheap to move to a branch.

**The hooks catch the routine mistake, one command early.** They read shell commands, and a
determined command can get past a string matcher. Branch protection on GitHub, for both branches,
is what stops a bad change reaching production. `protect-merge` reads the common `gh api` and
GraphQL ways to move a branch, not every one the API offers: it catches mistakes, and branch
protection is the boundary.

### The formatter

`format-file` runs `formatFile` from `.claude/canon.json`, an argv list such as
`["pnpm", "exec", "prettier", "--write", "--ignore-unknown"]`. The edited file's path is appended
as one argument and the command runs with no shell, so a path can't inject anything.

It runs only a command you approved. `formatFile` comes from the repository, so a cloned project
could name any program there, and any switch kept in the repository can be committed beside it.
`/canon:setup` shows the command and asks; on a yes it records the approval in
`~/.claude/canon/trusted.json`, outside every repository: under the repository's git directory, it
stores the argv list in full and its sha256. The hook runs only on an exact match. If the command
changes, through a pull, a branch switch or an edit, the hook stays off until you re-run
`/canon:setup` and approve the new one. Worktrees of one clone share its approval; another clone of
the same project needs its own. Set `formatFile` to `null` to turn the hook off.

## Permissions

A command pre-approves the plugin's scripts, a short list of exact commands, read-only `git`
lookups that take no output file, and edits under `docs/specs/`, `docs/canon/` and
`.claude/canon-domains.json`, the map that decides which paths the canon gates. The lookups
include `git diff` and `git log`, whose `--output` can write a file. A compound command prompts
unless every part of it is granted, so some of `/canon:approve`'s checks still ask. Three of those reach past the machine without a prompt:
`git push -u origin HEAD` pushes the current branch, `gh pr ready` marks the branch's draft pull
request ready for review (or back to draft), and the tracker script moves, labels and comments on
Linear issues. Everything else asks, as it would without the plugin: commits,
every `gh api` write (a grant on `gh api` would cover writes as well as reads, so staging and
production read GitHub through the plugin's GET-only `gh-get.mjs` instead), merges, the project's own checks, and any command Claude composes
itself. To run `/canon:ship` or `/canon:staging` unattended, add allow rules for those to your own
settings or run in a permission mode that allows them.

## Configuring Linear

canon can use Linear as the record and the gate instead of the spec file. Leave the `tracker`
block out of `.claude/canon.json` and nothing below applies.

With a tracker, each command reads the issue's status and moves it, and the spec's `**Status:**`
line mirrors it. Status names differ per team, so `.claude/canon.json` maps canon's roles to
yours, and `/canon:setup` offers your team's real names:

| Role         | Moved there by                                    | canon refuses                                     |
| ------------ | ------------------------------------------------- | ------------------------------------------------- |
| `ready`      | you                                               | `/canon:define` on a new spec in any other status |
| `spec`       | `/canon:define`, when it starts                   | `/canon:approve` in any other status              |
| `approved`   | `/canon:approve`, after it pushes the approval    | `/canon:build` in any other status but `blocked`  |
| `building`   | `/canon:build`, when it starts or resumes         |                                                   |
| `blocked`    | `/canon:build` or `/canon:ship`, waiting on you   |                                                   |
| `staging`    | Linear's GitHub integration, on the merge         |                                                   |
| `production` | Linear's GitHub integration, on the release merge |                                                   |

```json
"tracker": {
  "provider": "linear",
  "team": "ABC",
  "statuses": {
    "ready": "Todo",
    "spec": "In Spec",
    "approved": "Approved",
    "building": "In Progress",
    "blocked": "Blocked",
    "staging": "In Staging",
    "production": "Done"
  },
  "labelPrefix": "domain-",
  "apiKeyCommand": null
}
```

- **Branches** are `<prefix>/abc-123-<slug>`: the identifier in the name is what links the branch
  in Linear. Specs keep their number and carry an `**Issue:** ABC-123` line.
- **Labels.** `/canon:define` adds the `domain-*` label for each canon file the spec's `## Where`
  routes to through `.claude/canon-domains.json` (`auth.md` is `domain-auth`). It never creates a
  label; a missing one is reported.
- **Blocked** means Claude is waiting on you, and nothing else. At a stop condition, `/canon:build`
  and `/canon:ship` post the question as a comment starting `canon: blocked`, set the status, and
  ask in the session too. Answer in the session and the run carries on. Answer on the issue, in a
  comment below the question, and re-run the command: it reads the answer and moves the issue back
  to building. Every comment canon posts starts with a `canon:` line, and only a comment without
  one counts as your answer.
- **The client** is `scripts/tracker.mjs`, over Linear's GraphQL API with a personal API key. Not
  the Linear MCP server, whose OAuth needs a browser that a cloud session doesn't have.

### The API key

`scripts/tracker.mjs` takes the first of:

1. `LINEAR_API_KEY` in the environment.
2. `LINEAR_API_KEY=` in `.env.local` at the project root. Only that key is read. Keep the file
   ignored by git; setup checks, and a `.env.local` the repository commits is never read.
3. `tracker.apiKeyCommand`, a command that prints the key, such as
   `["op", "read", "op://Vault/Item/field"]`. It runs with no shell, from your home directory,
   and only after you approve that exact command in `/canon:setup`. The approval stores the argv
   list in full, in `~/.claude/canon/trusted.json` beside the formatter's. The program is a name
   found on `PATH` or an absolute path, and the command may not name the repository's own path
   anywhere: an approval covers the command line, and anything the repository holds could change
   under it.

The key is never printed, and an API error reports its HTTP status, not the response body. A 401
names where the key was read from, so you know which one to change.

Behind an egress proxy, as in a cloud session where `LINEAR_API_KEY` is a placeholder the proxy
swaps for the real key, the request has to go through `HTTPS_PROXY`. Node's `fetch` does that only
with `NODE_USE_ENV_PROXY=1` set at startup (Node 22.21, 24 or later). When a proxy is set and the
flag is not, the script turns the proxy on in-process where Node can (24.14 and later), and
otherwise re-runs itself once with the flag. `NO_PROXY` is respected, and a flag you set yourself,
to any value, is left alone. A 401 with a placeholder key says whether the request skipped the
proxy or went through it.

### Linear's GitHub integration

canon never sets `staging` or `production`. The GitHub integration does, from the merges, so it
has to be configured once per team, in Linear's team settings under the Git workflow
automations:

- **Default rules: "No action"** for every event, including the merge. Otherwise opening a draft
  pull request, or a merge into a feature branch, moves an issue that canon is still building.
- **A rule for the integration branch** (`staging`, say): on merge, move to your `staging`
  status.
- **A rule for the production branch** (`main`, say): on merge, move to your `production` status.

The rules act on the closing word in the pull request body:

- **`Fixes ABC-123`** moves the issue when the pull request merges. `/canon:build` writes it into
  the feature pull request's body from the moment it opens, and `/canon:staging` checks it is there
  before merging.
- **`Part of ABC-123`** (or `ref`, `related to`, `contributes to`, `towards`) links without
  moving. Commit bodies use it. In a pull request body it stops the move, so `/canon:staging`
  rewrites it.
- **The release pull request carries its own `Fixes` line per issue.** Each merge reads only its
  own pull request's body, and the feature pull request's line was spent on the merge into
  staging. `/canon:production` rebuilds the block from the merge log every time it writes the
  body.

A merge event doesn't replay: an issue the merge didn't move stays where it is, and the fix is the
rule or the body, next time. canon reports it and leaves the status alone.

## CI that skips later commits

Some projects run CI only when a pull request opens or leaves draft, and on `workflow_dispatch`,
with no `push` or `synchronize`, to keep the Actions bill down. Nothing then runs on a commit
pushed later, including the merge commit `/canon:staging` pushes itself, and it would wait for a
success that never comes. A `ci` block in `.claude/canon.json` lets it start the run:

```json
"ci": { "workflow": "ci.yml", "baseInput": "base" }
```

When nothing of that workflow has run, is running or is queued on the head commit,
`/canon:staging` dispatches it once on the pull request's branch and waits. `baseInput` names the
`workflow_dispatch` input that takes the base branch, and gets the integration branch, for a
workflow that diffs against the base: a dispatched run has no `pull_request.base.sha`. Set it to
`null` when the workflow declares no such input, since GitHub refuses an undeclared one. The
workflow must declare `workflow_dispatch` and be on the default branch. With a `ci` block, a merge
also needs that workflow's success on the head, not only some check's.

Leave the block out to only wait, which is right for CI that runs on every push.

## Project extensions

A project keeps its own commands, skills, rules and hooks beside the plugin's. Names that do not
collide with the plugin's (`/security`, `/localhost`, `/write`) stay as they are, and so do label
axes of its own beside the `domain-*` ones, such as `surface-*`: canon only adds and checks labels
with `tracker.labelPrefix`.

**Checks `/canon:review` runs too.** List the project's own review skills or commands in the
config, and `/canon:review` runs each on the same scope and folds its findings into its report,
under the same bar for what counts as a finding. `/canon:ship` reviews through `/canon:review`, so
its rounds run them as well:

```json
"review": { "extraSkills": ["security", "performance"] }
```

A name the session has no skill or command for is reported in one line, and the review goes on.

**Hooks.** The plugin's hooks run in every canon project. A hook the project keeps in its own
`.claude/settings.json` that does the same job (`protect-branch`, `branch-notice`, `protect-push`,
`protect-merge`, `require-canon`, `format-file`, `ci-watch`) runs as well, so the call is checked
twice and a refusal can come from either. Delete the project's copy, or keep only hooks that do
something the plugin does not, such as starting a dev server.

## Cloud sessions

A Claude Code cloud session reaches GitHub through a proxy that refuses GraphQL, which every
`gh pr` command uses. So the skills make every GitHub call through `gh api` REST: pull requests
are opened with `POST pulls`, read and edited by number, merged with `PUT pulls/<n>/merge`, and
commented on through the issues endpoint. Checks are read from the head commit's check runs.

Two calls differ by where the session runs:

- **Marking a draft ready** has no REST endpoint. With `CLAUDE_CODE_REMOTE=true` the skills use
  the proxy's `POST pulls/<n>/ccr/ready_for_review`; elsewhere, `gh pr ready`.
- **Deleting the merged branch** gets a `403` from the proxy. `/canon:staging` deletes it with
  `DELETE git/refs/heads/<branch>` and reports a failure as a warning, since the merge has
  already landed. Set `branches.deleteAfterMerge` to `false` to skip the deletion, for a project
  that deletes merged branches another way, such as a scheduled workflow.

The hooks read the REST forms as they read `gh pr`, and still read `gh pr` for a command a person
types: `require-canon` judges `POST pulls`, the ready call and the merge, and `ci-watch` wakes on
them and on a `workflow_dispatch`.

## Migrating an existing project

If the project already has local copies of these commands and hooks (the setup this plugin was
extracted from kept them in `.claude/commands/` and `.claude/hooks/`):

1. Run `/canon:setup`. It keeps your existing `.claude/canon-domains.json`,
   `docs/canon/README.md` and `docs/specs/README.md` as they are, leaves every other file in
   `docs/canon/` and `docs/specs/` alone, and asks before changing anything else that differs.
2. Delete the local copies the plugin replaces: `.claude/commands/{define,approve,build,ship,review,canon,staging,production,explain}.md`
   `.claude/hooks/{protect-branch,branch-notice,protect-push,protect-merge,require-canon,format-file,merge-command,push-command,writes-to-worktree}.mjs`,
   `.claude/hooks/ci-watch.sh`, and the type declarations beside the helpers,
   `.claude/hooks/{merge-command,push-command,writes-to-worktree}.d.mts`. Remove their entries
   from the `hooks` block of `.claude/settings.json`. Otherwise every hook runs twice.
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

## Privacy

Canon has no server and no telemetry. What it stores stays on your machine or in your
repository:

- **The owner's name.** Setup offers `git config user.name` as the default and saves the name you
  confirm in `.claude/canon.json`, which you commit with the project.
- **Approvals.** An approved formatter or API key command is stored in full, in plain text, in
  `~/.claude/canon/trusted.json`, as described in [The formatter](#the-formatter) and
  [The API key](#the-api-key). Every argument is kept, such as a config path or a vault path.
  Canon creates the file readable only by your user account (mode `0600`, in a `0700`
  directory), so other users on the machine can't read it, but any program you run can.

Canon itself sends data to two services, both under your own account:

- **GitHub**, through your signed-in `gh` CLI: pull requests, checks, CI runs and merges.
- **Linear**, only when you configure a tracker: issues, comments, statuses and labels, sent to
  `api.linear.app`. The key is the first of `LINEAR_API_KEY` in the environment, an uncommitted
  `.env.local` at the project root, or an approved `tracker.apiKeyCommand`, so a key already set
  in your shell for another project sends to that workspace. Canon never prints the key or writes
  it anywhere.

`.claude/canon.json` names its schema by URL on `raw.githubusercontent.com`, so an editor that
validates JSON may fetch the schema from GitHub when you open the file.

## Uninstalling

```text
/plugin uninstall canon@arhaty
```

That stops the skills and hooks. Then delete what setup wrote that only the plugin reads:

- `.claude/canon.json`
- `.claude/canon-index.md`
- `.claude/canon-domains.json`
- the section between `<!-- canon:begin -->` and `<!-- canon:end -->` in `CLAUDE.md`
- the `canon@arhaty` key under `enabledPlugins` in `.claude/settings.json`, if setup added it
- this repository's entry in `~/.claude/canon/trusted.json`, if you approved a formatter or an
  API key command. It is keyed by the repository's git directory; delete the file if canon is not
  used anywhere else.

Keep `docs/canon/` and `docs/specs/`. They are the project's own documentation: the canon records
how the code works today and the specs record what was built and why, and both read fine without
the plugin. `.claude/rules/principles.md` is the project's rules file now; keep it or delete it as
you would any other.

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
