---
name: setup
description: Set up canon in this project: write .claude/canon.json and scaffold docs/canon, docs/specs and the CLAUDE.md section, asking before changing any existing file
argument-hint: (none)
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" plan *)
  - Bash(git config user.name)
  - Bash(git check-ignore -q .env.local)
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

# Set up canon in this project

This writes the per-project half of canon. The plugin carries the skills and hooks; the project
carries its own canon, specs, domain map, rules and `.claude/canon.json`, which every hook and
skill reads instead of hardcoding a branch, a command or a name.

**Nothing that exists is overwritten without asking.** The scaffolder plans first, lists every
file that exists and differs, and writes nothing until each one is approved by name.

## Steps

1. **Find the project root and what is already there.**

   ```bash
   git rev-parse --show-toplevel
   git branch --show-current
   git branch -a --format='%(refname:short)'
   ls .claude/canon.json docs/canon docs/specs CLAUDE.md .claude/settings.json 2>/dev/null
   ```

   Not a git repository is a stop: say so and offer `git init`.

   If `.claude/canon.json` already exists, read it: its values are the defaults for every
   question below, and this run is a repair or a change, not a first setup.

   If `.claude/commands/` or `.claude/hooks/` holds files with the names this plugin replaces
   (`define`, `approve`, `build`, `ship`, `review`, `canon`, `staging`, `production`, `explain`,
   `protect-branch`, `protect-push`, `protect-merge`, `require-canon`, `branch-notice`,
   `ci-watch` (a `.sh`), `format-file`, and the helpers `merge-command`, `push-command`,
   `writes-to-worktree` with their `.d.mts` declarations), this is a migration. Note them for step 6 and do not touch them.

2. **Work out sensible defaults before asking anything.** Read, do not guess:

   - **Package manager** from the lockfile: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`,
     `bun.lockb` or `bun.lock`. No lockfile and no `package.json` is `none`.
   - **Check commands** from `package.json` scripts: a `typecheck`, `lint`, `format:check` (or
     `format` with `--check`) and `test` script become `<pm> <script>`. For other ecosystems, look
     for the obvious equivalents (`Makefile` targets, `pyproject.toml`, `Cargo.toml`). A check
     the project does not have is `null`, never invented.
   - **Per-file formatter**: prettier in `devDependencies` gives
     `["<pm>", "exec", "prettier", "--write", "--ignore-unknown"]`; for npm,
     `["npm", "exec", "--no", "--", "prettier", "--write", "--ignore-unknown"]`, which never
     downloads a package that is not installed. Anything
     else is `null` unless the user names one.
   - **Branches**: `staging` and `main` if both exist; `develop` and `main`, or `dev` and `main`,
     likewise. Otherwise suggest `staging` and the repository's default branch.
   - **Owner**: `git config user.name`.
   - **CI workflow to dispatch**: an existing `ci` block, unchanged. Otherwise a file in
     `.github/workflows/` whose `on:` has `workflow_dispatch` and runs on no later commit of a
     feature branch: no `push` whose `branches`, `branches-ignore` or `paths` filters let a
     feature branch through, and no `pull_request` or `pull_request_target` whose `types` include
     `synchronize`. Either with no `types` includes `synchronize`, so that workflow already runs
     on every push. Its `workflow_dispatch` input that names the base branch (often
     `base`) is the base input; none is `null`. No such workflow means no `ci` block.

3. **Ask, in one `AskUserQuestion` call where the tool allows, with the defaults as the first,
   recommended option.** Every value below ends up in `.claude/canon.json`:

   - **Owner name**: who approves specs and merges releases.
   - **Integration branch** and **production branch**. They must differ: single-branch
     repositories are not supported in this version. If the user has only one branch, say so and
     offer to create the integration branch from it after setup.
   - **Package manager.**
   - **Typecheck, lint, format-check and test commands**, each a command or none.
   - **Preview URL pattern** with `{branch}`, or none if feature branches get no preview. Also
     the staging and production URLs, or none.
   - **Branch prefixes**: default `feat`, `fix`, `chore`, `refactor`, `docs`.
   - **Per-file formatter** (argv list) or none. If one is set, show the exact argv and ask
     whether to approve running it after every edit. Only that approval, recorded outside the
     repository, lets the hook run it; a changed command needs approving again. Say plainly that
     the approval covers the command line, not the code it runs: a config file or script in the
     repository that the command reads can change later without asking again.
   - **Whether to enable canon in the project's own `.claude/settings.json`.** That turns canon on
     for everyone who clones the project and has the plugin installed.
   - **Whether `/canon:staging` should start CI** when nothing has run on the head commit, and
     with which workflow and base input. Only for CI that skips commits pushed after the pull
     request leaves draft; the workflow must declare `workflow_dispatch`. No means no `ci` block,
     and `/canon:staging` only waits.
   - **Whether to use an issue tracker** as the record and the gate. Linear is the only one
     supported. Without one, the spec's `**Status:**` line is the gate and the config gets no
     `tracker` block; skip the tracker questions below.

   If an existing config has a `tracker` or `ci` block, its values are the defaults too, ahead of
   anything detected.

   **The tracker, when the owner wants one.** Read `${CLAUDE_PLUGIN_ROOT}/references/tracker.md`
   first for what each role means.

   1. **Ask for the team key**, the prefix of the team's issue identifiers (`ABC` for
      `ABC-123`), and **where the API key comes from**: `LINEAR_API_KEY` in the environment,
      `LINEAR_API_KEY=` in `.env.local` at the project root, or a command that prints it, such as
      a password manager's CLI, as an argv list. A personal key is created in Linear under
      Settings, Security & access.
      - **`.env.local`**: check it is ignored (`git check-ignore -q .env.local`). If it is not,
        say so plainly and stop until it is: a committed key is a leaked key.
      - **A command**: a program on `PATH` or an absolute path, never a script in the repository:
        it runs from the home directory and is refused if it names the repository's path. Show
        the exact argv and ask whether to approve running it to read the key.
        The approval is recorded outside the repository, like the formatter's, and covers that
        command line only. A declined command stays in the config and never runs.
   2. **Fetch the team's statuses** so the owner picks from real names. Write a partial answers
      file outside the project, `{"tracker": {"provider": "linear", "team": "<KEY>",
"apiKeyCommand": <argv or null>}}`, record an approved command first (step 5's
      `trust --command apiKeyCommand`, against this file), then:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" --config <partial file> states <KEY>
      ```

      A failure (no key, a wrong team) is said as it is, and asked again; never guessed past.

   3. **Map each role to one of those statuses.** Propose a mapping by name and type (Linear's
      `unstarted`, `started`, `completed` types help: `ready` is usually the first `unstarted`
      status after the backlog, `production` the `completed` one), show it as a table beside the
      full list, and ask the owner to confirm or correct it. Every role needs a status of its
      own. A team with no status that fits `blocked`, or one of the others, needs one added in
      Linear first: say which, and wait.
   4. **The label prefix** for domain routing is `domain-` unless the owner names another.

4. **Write the answers to a scratch file and plan.** The answers file is the full config:

   ```json
   {
     "version": 1,
     "owner": "<owner>",
     "branches": { "integration": "<integration>", "production": "<production>", "prefixes": ["feat", "fix", "chore", "refactor", "docs"] },
     "packageManager": "<pm>",
     "commands": { "typecheck": "<cmd or null>", "lint": "<cmd or null>", "format": "<cmd or null>", "test": "<cmd or null>" },
     "formatFile": ["<argv>", "..."] or null,
     "urls": { "preview": "<pattern or null>", "staging": "<url or null>", "production": "<url or null>" },
     "tracker": { "provider": "linear", "team": "<KEY>", "statuses": { "ready": "<status>", "...": "..." }, "labelPrefix": "domain-", "apiKeyCommand": ["<argv>"] or null },
     "ci": { "workflow": "<file>.yml", "baseInput": "<input or null>" }
   }
   ```

   Leave `tracker` out entirely when the owner wants none, and `ci` likewise.

   Write it outside the project (your scratchpad or `$TMPDIR`), then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" plan --root <project root> --answers <file> [--enable-plugin]
   ```

   Each line is `create`, `same`, `keep`, `conflict` or `symlink`. `keep` is a file the project
   owns once it exists (the domain map and the two index READMEs) and is never written. `symlink`
   means the path runs through a link that leads outside the project or nowhere, and nothing is written until the user replaces it with a
   real file or directory. An invalid answers file exits 2 and names every
   problem: fix the answer, not the check.

5. **Ask about every conflict, by name.** For each `conflict`, say what it is and what would
   change: `CLAUDE.md` gets the canon section between `<!-- canon:begin -->` and
   `<!-- canon:end -->` (appended if the markers are absent; the rest of the file is kept);
   `.claude/settings.json` gets one `enabledPlugins` key merged in; any other file would be
   replaced. Show a diff when it helps (`diff <existing> <(...)` is fine). Then apply with exactly
   the approved paths:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" apply --root <project root> --answers <file> [--enable-plugin] --allow <path> ...
   ```

   If the user approved the formatter, record it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" trust --root <project root> --answers <file>
   ```

   Never run `trust` without that yes. A declined formatter stays in `.claude/canon.json` and
   never runs. An approved API key command is recorded the same way, on its own yes:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" trust --root <project root> --answers <file> --command apiKeyCommand
   ```

   A conflict the user declines stays as it is. If declining it means the setup is incomplete
   (for example an existing `.claude/canon.json` they will not replace), say what that leaves
   inconsistent.

6. **Migrating from local copies.** If step 1 found local commands or hooks this plugin replaces,
   list them and say they should be deleted, along with their entries in
   `.claude/settings.json` `hooks`, so the same hook does not run twice and an old copy does not
   shadow `/canon:*`. Offer to do it; do it only on a yes. Keep any project-specific command,
   hook, rule or skill the plugin does not replace.

7. **Report**, in a few lines: the files created, updated and left alone; that nothing is
   committed; the next steps:

   - Commit the setup on a branch cut from the integration branch (the hooks refuse an edit on a
     protected branch once `.claude/canon.json` exists).
   - Fill `.claude/canon-domains.json` as canon files are written: it maps paths to the canon
     file that governs them, and is empty until then.
   - Turn on GitHub branch protection for both branches. The hooks are a seatbelt; protection is
     the boundary.
   - **With a tracker**, configure Linear's GitHub integration as the plugin README's
     "Configuring Linear" section says, and check the API key works with
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" states`. Without the branch rules, nothing
     moves an issue to its staging or production status.

## Hard limits

- **Never overwrite, delete or edit an existing file without the user approving that path.**
- **Never commit, push or create a branch** unless the user asks.
- **Never invent a check command.** A check the project does not have is `null`.
