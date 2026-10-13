# Changelog

## [0.2.0](https://github.com/Arhaty/claude-plugins/compare/canon-v0.1.0...canon-v0.2.0) (2026-10-13)


### Features

* add optional linear tracker to canon ([#15](https://github.com/Arhaty/claude-plugins/issues/15)) ([396b319](https://github.com/Arhaty/claude-plugins/commit/396b319ee27c0bf9b42a98ae876327a49f27fac8))


### Bug Fixes

* port guard and spec lookup fixes to canon ([#14](https://github.com/Arhaty/claude-plugins/issues/14)) ([ea88728](https://github.com/Arhaty/claude-plugins/commit/ea88728fa20553c0ea8b35058d74994465674371))

## 0.1.0 (2026-10-12)

Initial release.

- Skills for the spec, build, review, canon and ship loop: `/canon:define`, `approve`, `build`, `review`, `canon`, `staging`, `production`, `ship` and `explain`.
- `/canon:setup` scaffolds `.claude/canon.json`, `docs/canon/`, `docs/specs/` and a `CLAUDE.md` section, and never overwrites a file without asking.
- Hooks that keep edits off the protected branches, refuse pushes to them and any force push, leave production merges to the owner, require a canon update for mapped paths, run an approved formatter and report failed CI.
- `scripts/canon-index.mjs` writes `.claude/canon-index.md`, every canon claim on one line, with `--check` for CI.
- Hardened against bypasses: pushes hidden in brace expansions and `gh api` or GraphQL writes that reach production are refused, setup won't write through symlinks that leave the project, the formatter runs only after you approve its exact command, and `canon.json` rejects unknown keys.
