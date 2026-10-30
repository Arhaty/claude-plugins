# Changelog

## [0.5.2](https://github.com/Arhaty/claude-plugins/compare/canon-v0.5.1...canon-v0.5.2) (2026-10-30)


### Bug Fixes

* keep canon's starting points and follow the tracker in setup ([#64](https://github.com/Arhaty/claude-plugins/issues/64)) ([7ad3453](https://github.com/Arhaty/claude-plugins/commit/7ad34537e793ab670b44fd591b2873cf8722d28c))

## [0.5.1](https://github.com/Arhaty/claude-plugins/compare/canon-v0.5.0...canon-v0.5.1) (2026-10-30)


### Bug Fixes

* make canon setup follow the build and specs settings ([#61](https://github.com/Arhaty/claude-plugins/issues/61)) ([2b70f25](https://github.com/Arhaty/claude-plugins/commit/2b70f25903d48328b5656511728819ef653c9559))

## [0.5.0](https://github.com/Arhaty/claude-plugins/compare/canon-v0.4.4...canon-v0.5.0) (2026-10-30)


### Features

* add a build step and a required check to canon's gate ([#57](https://github.com/Arhaty/claude-plugins/issues/57)) ([2ba58c3](https://github.com/Arhaty/claude-plugins/commit/2ba58c317f7dc4916bb24c6347ddb446d42200be))
* let a cloud environment approve canon's formatter ([#58](https://github.com/Arhaty/claude-plugins/issues/58)) ([8eecfd9](https://github.com/Arhaty/claude-plugins/commit/8eecfd9e6dfb20660abcaf9c3c8ac4c00a68d97a))
* let a project add its own checks to canon's review ([#59](https://github.com/Arhaty/claude-plugins/issues/59)) ([30ad6f8](https://github.com/Arhaty/claude-plugins/commit/30ad6f84b23a176605be905990044971e335cfd0))
* let canon archive specs to the tracker ([#56](https://github.com/Arhaty/claude-plugins/issues/56)) ([c905a70](https://github.com/Arhaty/claude-plugins/commit/c905a709e4fdddb97c3f6d7e6544a705a4d1fba9))
* make canon's GitHub calls work in a Claude Code cloud session ([#53](https://github.com/Arhaty/claude-plugins/issues/53)) ([540f345](https://github.com/Arhaty/claude-plugins/commit/540f3458f28a67bed89b4457c0a40ecb9a627bed))
* make canon's urls block optional ([#54](https://github.com/Arhaty/claude-plugins/issues/54)) ([5db759b](https://github.com/Arhaty/claude-plugins/commit/5db759bf4d6c8cc00499be47d49fef7d38a6aba1))
* name canon branches after the tracker issue ([#55](https://github.com/Arhaty/claude-plugins/issues/55)) ([8310e6b](https://github.com/Arhaty/claude-plugins/commit/8310e6b8a044d028a702403b3c62f7f18004d949))

## [0.4.4](https://github.com/Arhaty/claude-plugins/compare/canon-v0.4.3...canon-v0.4.4) (2026-10-25)

### Bug Fixes

- clear canon's allowed-tools and download-and-run directory warnings ([#41](https://github.com/Arhaty/claude-plugins/issues/41)) ([d8b9339](https://github.com/Arhaty/claude-plugins/commit/d8b9339a953d5841410d9b846c7ab58c0c2ae3bf))

## [0.4.3](https://github.com/Arhaty/claude-plugins/compare/canon-v0.4.2...canon-v0.4.3) (2026-10-18)

### Bug Fixes

- harden ci-watch's shutdown and quiet-push reading in canon ([#36](https://github.com/Arhaty/claude-plugins/issues/36)) ([6015028](https://github.com/Arhaty/claude-plugins/commit/6015028c582c1a6b67275c2936ed9bacde857836))

## [0.4.2](https://github.com/Arhaty/claude-plugins/compare/canon-v0.4.1...canon-v0.4.2) (2026-10-18)

### Bug Fixes

- watch every commit a command starts a ci run on in canon ([#34](https://github.com/Arhaty/claude-plugins/issues/34)) ([0079761](https://github.com/Arhaty/claude-plugins/commit/007976127261b0912d772a454323e0462887f324))

## [0.4.1](https://github.com/Arhaty/claude-plugins/compare/canon-v0.4.0...canon-v0.4.1) (2026-10-18)

### Bug Fixes

- watch ci runs by the workflow's own triggers in canon ([#31](https://github.com/Arhaty/claude-plugins/issues/31)) ([32ceca7](https://github.com/Arhaty/claude-plugins/commit/32ceca71c69d5e29f9d31c2179f9bae4aa786f48))

## [0.4.0](https://github.com/Arhaty/claude-plugins/compare/canon-v0.3.0...canon-v0.4.0) (2026-10-18)

### Features

- push the draft spec on every define round ([#22](https://github.com/Arhaty/claude-plugins/issues/22)) ([d08353f](https://github.com/Arhaty/claude-plugins/commit/d08353f2b2bb822272afb9d7eb5bcf923e68b5c9))

### Bug Fixes

- scope canon's pre-approved tools to what each skill needs ([#23](https://github.com/Arhaty/claude-plugins/issues/23)) ([0f8ed18](https://github.com/Arhaty/claude-plugins/commit/0f8ed18ef0c417a91bd1ccecaad73784a2034f35))
- send canon's tracker requests through HTTPS_PROXY ([#25](https://github.com/Arhaty/claude-plugins/issues/25)) ([833ea92](https://github.com/Arhaty/claude-plugins/commit/833ea927a7f6ff80ad91b04606d6cd8838a6e250))

## [0.3.0](https://github.com/Arhaty/claude-plugins/compare/canon-v0.2.0...canon-v0.3.0) (2026-10-13)

### Features

- dispatch ci from /canon:staging when the head commit has no run ([#20](https://github.com/Arhaty/claude-plugins/issues/20)) ([d669d59](https://github.com/Arhaty/claude-plugins/commit/d669d59e14da4bf155ff59e8648e4be6f218a86c))

## [0.2.0](https://github.com/Arhaty/claude-plugins/compare/canon-v0.1.0...canon-v0.2.0) (2026-10-13)

### Features

- add optional linear tracker to canon ([#15](https://github.com/Arhaty/claude-plugins/issues/15)) ([396b319](https://github.com/Arhaty/claude-plugins/commit/396b319ee27c0bf9b42a98ae876327a49f27fac8))

### Bug Fixes

- port guard and spec lookup fixes to canon ([#14](https://github.com/Arhaty/claude-plugins/issues/14)) ([ea88728](https://github.com/Arhaty/claude-plugins/commit/ea88728fa20553c0ea8b35058d74994465674371))

## 0.1.0 (2026-10-12)

Initial release.

- Skills for the spec, build, review, canon and ship loop: `/canon:define`, `approve`, `build`, `review`, `canon`, `staging`, `production`, `ship` and `explain`.
- `/canon:setup` scaffolds `.claude/canon.json`, `docs/canon/`, `docs/specs/` and a `CLAUDE.md` section, and never overwrites a file without asking.
- Hooks that keep edits off the protected branches, refuse pushes to them and any force push, leave production merges to the owner, require a canon update for mapped paths, run an approved formatter and report failed CI.
- `scripts/canon-index.mjs` writes `.claude/canon-index.md`, every canon claim on one line, with `--check` for CI.
- Hardened against bypasses: pushes hidden in brace expansions and `gh api` or GraphQL writes that reach production are refused, setup won't write through symlinks that leave the project, the formatter runs only after you approve its exact command, and `canon.json` rejects unknown keys.
