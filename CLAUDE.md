# CLAUDE.md

The Arhaty Claude Code plugin marketplace. `.claude-plugin/marketplace.json` lists the plugins;
each lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json`, README, CHANGELOG and
`test/`. Contributor setup and the per-plugin rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

```bash
pnpm test           # node --test over plugins/*/test
pnpm validate       # claude plugin validate --strict, marketplace and each plugin
pnpm format         # prettier --write; format:check in CI
pnpm lint           # markdownlint
```

Run `pnpm test`, `pnpm validate`, `pnpm format:check` and `pnpm lint` before proposing a commit.

## Hard rules

- **Plugin code imports `node:` built-ins only.** Hooks and scripts are installed without
  `npm install`. The devDependencies are CI tooling and are never imported by a plugin;
  `test/builtins.test.mjs` fails on anything else.
- **Every hook change ships with tests**, including the case it must refuse.
- **macOS and Linux only.** No Windows-specific code paths.
- **Never bump a version or edit a CHANGELOG by hand.** release-please owns both.
- **Actions are pinned to a full commit SHA with a version comment**
  (`uses: owner/action@<sha> # v1.2.3`). A new third-party action must be added to the repository's
  allowed-actions list first: name it when proposing the change.
- **This repository is public.** No personal names, employers, project paths or private URLs in
  plugin content, examples or tests.
- **After changing a skill's `description`**, check its token cost with
  `claude plugin details <plugin>`. Descriptions load into every session.

## Git

`main` is the only long-lived branch. Work on a `feat/`, `fix/`, `chore/`, `refactor/` or `docs/`
branch cut from `main`. Pull requests are squash-merged, so the PR title becomes the commit: it
must be a conventional commit using a type from
[.github/workflows/pr-title.yml](.github/workflows/pr-title.yml) (`feat`, `fix`, `chore`,
`refactor`, `docs`, `style`, `test`, `perf`). The PR body says what changed, why, and how to
verify it.

Commits carry no Co-authored-by trailer and use the GitHub noreply author email
(`5563384+sandrolonardi@users.noreply.github.com`). This overrides the global attribution rule.

## Adding a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json`, README, CHANGELOG and `test/`.
2. Add it to `.claude-plugin/marketplace.json`.
3. Add it to `release-please-config.json` and `.release-please-manifest.json`.
4. Add a row to the catalogue table in the root [README.md](README.md).
