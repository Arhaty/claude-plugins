# Changelog

## [0.4.1](https://github.com/Arhaty/claude-plugins/compare/canon-v0.4.0...canon-v0.4.1) (2026-10-18)


### Bug Fixes

* watch ci runs by the workflow's own triggers in canon ([#31](https://github.com/Arhaty/claude-plugins/issues/31)) ([32ceca7](https://github.com/Arhaty/claude-plugins/commit/32ceca71c69d5e29f9d31c2179f9bae4aa786f48))

## [0.4.0](https://github.com/Arhaty/claude-plugins/compare/canon-v0.3.0...canon-v0.4.0) (2026-10-18)


### Features

* push the draft spec on every define round ([#22](https://github.com/Arhaty/claude-plugins/issues/22)) ([d08353f](https://github.com/Arhaty/claude-plugins/commit/d08353f2b2bb822272afb9d7eb5bcf923e68b5c9))


### Bug Fixes

* scope canon's pre-approved tools to what each skill needs ([#23](https://github.com/Arhaty/claude-plugins/issues/23)) ([0f8ed18](https://github.com/Arhaty/claude-plugins/commit/0f8ed18ef0c417a91bd1ccecaad73784a2034f35))
* send canon's tracker requests through HTTPS_PROXY ([#25](https://github.com/Arhaty/claude-plugins/issues/25)) ([833ea92](https://github.com/Arhaty/claude-plugins/commit/833ea927a7f6ff80ad91b04606d6cd8838a6e250))

## [0.3.0](https://github.com/Arhaty/claude-plugins/compare/canon-v0.2.0...canon-v0.3.0) (2026-10-13)


### Features

* dispatch ci from /canon:staging when the head commit has no run ([#20](https://github.com/Arhaty/claude-plugins/issues/20)) ([d669d59](https://github.com/Arhaty/claude-plugins/commit/d669d59e14da4bf155ff59e8648e4be6f218a86c))

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
