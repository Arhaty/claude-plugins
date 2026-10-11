# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so the
change can be discussed before it is built.

Each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json`, README,
CHANGELOG and tests. `.claude-plugin/marketplace.json` at the root lists them.

## Setup

Requires macOS or Linux, Node 20 or later, and pnpm.

```bash
pnpm install
pnpm test           # node --test over plugins/*/test, no dependencies
pnpm validate       # claude plugin validate --strict on the marketplace and each plugin
pnpm format:check   # prettier
pnpm lint           # markdownlint
```

The three devDependencies are the tools CI runs, pinned by the lockfile and kept current by
Dependabot: `prettier`, `markdownlint-cli2`, and `@anthropic-ai/claude-code` for the plugin
validator. The plugins themselves install nothing.

CI also runs typos over the repository, and actionlint and zizmor over `.github/workflows/`, as
release binaries pinned by version and SHA-256 in
[.github/scripts/install-tool.sh](.github/scripts/install-tool.sh). The same script installs them
locally on Linux x86_64 or macOS arm64:

```bash
.github/scripts/install-tool.sh typos ~/.local/bin
```

Dependabot doesn't update those pins; bump them by hand from each tool's release page.

To try a plugin from a checkout, add the checkout as a local marketplace in a throwaway
repository:

```text
/plugin marketplace add /path/to/claude-plugins
/plugin install canon@arhaty
```

## Rules for changes

- **Hooks and scripts import Node built-ins only** (`node:` specifiers) and each other. Each
  plugin's `test/builtins.test.mjs` fails on anything else. Plugins are installed without
  `npm install`, so a package import works on your machine and breaks on every install.

### canon

Paths below are relative to `plugins/canon/`.

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

## Evals

`plugins/<name>/evals/` holds `claude plugin eval` cases: does a skill trigger on the prompts it
should, stay quiet on near-misses, and behave once it runs. **They are local only.** Each case runs
Claude on your own account several times and an LLM judge grades the result, so a run costs money
and CI never runs them. Run them before changing a skill's `description` or its stopping rules:

```bash
pnpm exec claude plugin eval plugins/canon --scaffold --allow-tools Bash Write Edit --ablation none
```

`--scaffold` lets a case build its throwaway fixture repository from its `scaffold.sh`, and
`--allow-tools` lets the skill under test run git and write the spec. Calibrate first with one
case and one run (`--case review-cites-spec --runs 1`), and cap a full run with
`--max-cost-usd`. Results go to `evals/results/`, which is ignored.

## Pull requests and releases

Pull request titles are conventional commits (`feat:`, `fix:`, `docs:` and so on). Merges are
squashed, so the title becomes the commit, and release-please reads it.

release-please runs in monorepo mode. A commit that touches `plugins/<name>/` counts toward that
plugin's next release. release-please opens one release pull request per plugin; merging it bumps
`version` in that plugin's `.claude-plugin/plugin.json`, updates its `CHANGELOG.md`, and tags
`<name>-vX.Y.Z`.
