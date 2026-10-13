# write evals

Local only: they run Claude on your account and cost money, so CI does not run them. See
[CONTRIBUTING.md](../../../CONTRIBUTING.md#evals) for the command.

| Case                  | Checks                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| `email-triggers`      | An email for someone else runs the skill and comes back without tells.     |
| `detect-quotes-lines` | "Is this slop?" quotes each offending line, names the pattern, no rewrite. |
| `near-miss-chat`      | An explanation for the user in chat does not run the skill.                |

None needs `--scaffold`. Run them with `--allow-tools Bash Write` so the skill can save a draft and
run the checker.
