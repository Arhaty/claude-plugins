# Working with the issue tracker

Read this when `.claude/canon.json` has a `tracker` block. Without one, none of it applies and the
spec's `**Status:**` line is the gate, as before.

With one, **the issue is the record and the gate.** Each command reads the issue's status and
moves it, and the spec's `**Status:**` line mirrors it. Where the two disagree, the issue wins:
say so in one line and carry on from the issue's status.

## The client

`node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs"` is the only way to talk to the tracker. Never
use an MCP server for it, and never read the API key into the conversation: the client finds it.

```bash
tracker="${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs"
node "$tracker" issue ABC-123                  # title, description, labels, state, role
node "$tracker" comments ABC-123               # every comment, and the blocked question if any
printf '%s' "$body" | node "$tracker" comment ABC-123
printf '%s' "$question" | node "$tracker" comment ABC-123 --blocked
node "$tracker" set-state ABC-123 building     # spec, approved, building or blocked
node "$tracker" label ABC-123 +domain-auth     # add with +, remove with -
```

Output is JSON. Exit 1 is a failure and exit 2 a usage error, with the reason on stderr: stop and
pass it on rather than working around it.

**Every comment canon posts starts with a `canon:` line**, which the client adds: `canon: blocked`
on a question for the owner, `canon: note` on anything else. A comment without one is a person's.

## Roles

Compare `role`, never the status name: names differ per team, and the config maps them.

| Role         | Means                                            | Set by                        |
| ------------ | ------------------------------------------------ | ----------------------------- |
| `ready`      | Prioritised, waiting for a spec                  | the owner                     |
| `spec`       | Being specced, or specced and waiting to be read | `/canon:define`               |
| `approved`   | The owner approved the spec                      | `/canon:approve`              |
| `building`   | Being built                                      | `/canon:build`                |
| `blocked`    | Claude is waiting on the owner, nothing else     | `/canon:build`, `/canon:ship` |
| `staging`    | Merged into the integration branch               | the GitHub integration        |
| `production` | Merged into production                           | the GitHub integration        |

`role: null` is a status the config does not map: say which and stop. **Never set `staging` or
`production`**, even when the board looks stuck: a merge that did not move an issue is a pull
request body to fix, and a status set by hand hides it. The client refuses them anyway.

## Names

- **The identifier** is `ABC-123`, the team key from `tracker.team` and a number.
- **The branch** follows `branches.naming`. Every command that looks for an issue's branch looks
  for it this way, and nothing else:
  - **`prefix`, or unset:** `<prefix>/<identifier in lowercase>-<slug>`, e.g.
    `feat/abc-123-rate-limit-reset`. The GitHub integration links any branch whose name contains
    the identifier, so the prefix rules and the link both hold. Find it with
    `git branch -a --list '*/abc-123-*'`.
  - **`tracker`:** the issue's own `branchName`, as `issue <ID>` returns it, verbatim, e.g.
    `abc-123-rate-limit-reset`: no prefix and no slug of canon's own. A headless run finds the
    branch from the issue alone that way. Find it with
    `git branch -a --list "<branchName>" "origin/<branchName>"`. An empty `branchName` is a stop:
    say so, never make one up.
- **The spec** keeps its number, `docs/specs/NNN-<slug>.md`, and carries the identifier on an
  `**Issue:** ABC-123` line directly under its `**Status:**` line.
- **Commit bodies** carry `Part of ABC-123` beside `Spec: NNN`. It links the commit and moves
  nothing.
- **The pull request body** carries `Fixes ABC-123` on a line of its own from the moment it opens.
  The closing word is what the GitHub integration reads when the pull request merges. `Part of`,
  `ref`, `related to`, `contributes to` and `towards` link without moving, so none of them goes in
  a pull request body next to the identifier.

## Blocked

`blocked` means Claude is waiting on the owner, and nothing else. It is set at one of the stop
conditions `/canon:build` and `/canon:ship` name: a product decision the spec did not settle, a
conflict that is a decision, a gate failing three times, a dependency the spec did not name, or an
irreversible action.

**To block**, in this order:

1. Post the question, with every open point and your recommended answer to each:
   `printf '%s' "$question" | node "$tracker" comment ABC-123 --blocked`. The client starts the
   comment with the line `canon: blocked`, which is what marks it.
2. `node "$tracker" set-state ABC-123 blocked`.
3. **Ask the same question in the chat** with `AskUserQuestion`, recommended option first. The
   comment is for an owner who is not watching the session; it is never the only way to answer.

**An answer in the chat** wins: post it on the issue with `comment` (no `--blocked`), so the issue
holds the decision too, then `set-state building` and carry on from the step that stopped.

**Resuming in a later session**: `node "$tracker" comments ABC-123` returns `blocked.question`, the
newest comment marked `canon: blocked`, and `blocked.answers`, every later comment with no
`canon:` line at all, so a report canon posted after the question is not an answer. Never decide
by who wrote a comment: with the owner's own key, canon's comments and the owner's answers come
from the same user. No answers means the owner has not replied: repeat the question
and stop, still blocked. Answers mean read them, fold a decision into the spec's `## Decisions`
table, `set-state building`, and carry on.
