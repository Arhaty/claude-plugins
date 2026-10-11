# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so the
change can be discussed before it is built.

## Setup

Requires macOS or Linux, Node 20 or later, and pnpm.

```bash
pnpm install
pnpm test           # node --test, no dependencies
pnpm validate       # claude plugin validate . --strict
pnpm format:check   # prettier
pnpm lint           # markdownlint
```

The three devDependencies are the tools CI runs, pinned by the lockfile and kept current by
Dependabot: `prettier`, `markdownlint-cli2`, and `@anthropic-ai/claude-code` for the plugin
validator. The plugin itself installs nothing.

CI also runs typos over the repository, and actionlint and zizmor over `.github/workflows/`, as
release binaries pinned by version and SHA-256 in
[.github/scripts/install-tool.sh](.github/scripts/install-tool.sh). The same script installs them
locally on Linux x86_64 or macOS arm64:

```bash
.github/scripts/install-tool.sh typos ~/.local/bin
```

Dependabot doesn't update those pins; bump them by hand from each tool's release page.

To try the plugin from a checkout, add it as a local marketplace in a throwaway repository:

```text
/plugin marketplace add /path/to/canon
/plugin install canon@canon
```

## Rules for changes

- **Hooks and scripts import Node built-ins only** (`node:` specifiers) and each other.
  `test/builtins.test.mjs` fails on anything else. The plugin is installed without `npm install`,
  so a package import works on your machine and breaks on every install.
- **Every hook change comes with a test** in `test/hooks.test.mjs` or `test/matchers.test.mjs`:
  the command that should be refused and the one that should not. A guard that fails open is a
  security bug; a guard that refuses ordinary work gets bypassed out of habit. Both directions
  matter.
- **Guards on what ships fail closed** when they crash (`protect-push`, `protect-merge`,
  `require-canon`). Keep everything that can throw inside the hook's `try`.
- **Nothing project-specific in the plugin.** Branch names, commands, names and URLs come from
  `.claude/canon.json`. A new setting goes in `templates/canon.schema.json` with a description,
  in `hooks/lib/config.mjs` validation, and in `/canon:setup`.
- **Templates use `{{placeholders}}`** filled by `scripts/scaffold.mjs`. An unknown placeholder
  throws, and `test/templates.test.mjs` checks none survive.
- **Pull request titles are conventional commits** (`feat:`, `fix:`, `docs:` and so on). Merges
  are squashed, so the title becomes the commit, and release-please reads it to version the
  plugin and write `CHANGELOG.md`.

## Releases

release-please opens a release pull request when `main` has releasable commits. Merging it tags
the release and bumps the version in `.claude-plugin/plugin.json` and `package.json`.
