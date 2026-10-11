---
name: setup
description: Set up canon in this project: write .claude/canon.json and scaffold docs/canon, docs/specs and the CLAUDE.md section, asking before changing any existing file
argument-hint: (none)
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
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
     `["<pm>", "exec", "prettier", "--write", "--ignore-unknown"]` (`npx` for npm). Anything
     else is `null` unless the user names one.
   - **Branches**: `staging` and `main` if both exist; `develop` and `main`, or `dev` and `main`,
     likewise. Otherwise suggest `staging` and the repository's default branch.
   - **Owner**: `git config user.name`.

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
   - **Per-file formatter** (argv list) or none, and **whether to enable canon in the project's
     own `.claude/settings.json`**. Explain the trade in one line: the formatter hook only runs
     when the plugin is enabled there, and enabling it there turns canon on for everyone who
     clones the project and has the plugin installed.

4. **Write the answers to a scratch file and plan.** The answers file is the full config:

   ```json
   {
     "version": 1,
     "owner": "<owner>",
     "branches": { "integration": "<integration>", "production": "<production>", "prefixes": ["feat", "fix", "chore", "refactor", "docs"] },
     "packageManager": "<pm>",
     "commands": { "typecheck": "<cmd or null>", "lint": "<cmd or null>", "format": "<cmd or null>", "test": "<cmd or null>" },
     "formatFile": ["<argv>", "..."] or null,
     "urls": { "preview": "<pattern or null>", "staging": "<url or null>", "production": "<url or null>" }
   }
   ```

   Write it outside the project (your scratchpad or `$TMPDIR`), then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" plan --root <project root> --answers <file> [--enable-plugin]
   ```

   Each line is `create`, `same`, `keep`, `conflict` or `symlink`. `keep` is a file the project
   owns once it exists (the domain map and the two index READMEs) and is never written. `symlink`
   means the path runs through a link, and nothing is written until the user replaces it with a
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

## Hard limits

- **Never overwrite, delete or edit an existing file without the user approving that path.**
- **Never commit, push or create a branch** unless the user asks.
- **Never invent a check command.** A check the project does not have is `null`.
