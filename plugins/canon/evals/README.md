# canon evals

Local only: they run Claude on your account and cost money, so CI does not run them. See
[CONTRIBUTING.md](../../../CONTRIBUTING.md#evals) for the command.

| Case                         | Checks                                                                  |
| ---------------------------- | ----------------------------------------------------------------------- |
| `build-refuses-not-approved` | With a tracker, build refuses an issue that is not approved.            |
| `define-near-miss-spec`      | A spec asked for in prose does not run define, which is user-only.      |
| `define-near-miss-word`      | Defining a word does not run define.                                    |
| `define-refuses-not-ready`   | With a tracker, define refuses an issue not in its ready status.        |
| `define-stops-at-draft`      | `/canon:define` pushes a draft and stops: no approval, no pull request. |
| `review-cites-spec`          | Review runs on a prose request and cites the spec and the canon rule.   |
| `review-canon-paths`         | Checking paths against `docs/canon` runs review.                        |
| `review-near-miss-bugs`      | A bug review of pasted code does not run canon's review.                |
| `review-near-miss-prose`     | Reviewing a sentence for tone does not run review.                      |

The cases with a `scaffold.sh` build a throwaway canon project in the eval workspace, so they need
`--scaffold`, and their skills need `--allow-tools Bash Write Edit`.

The tracker cases use the `fixture` provider, a tracker held in `.claude/tracker-fixture.json`, so
they make no network call and need no key. An eval does not apply the scaffolded project's
`.claude/settings.json` `env`, so a stub cannot be preloaded that way.
