---
name: build
description: Build an approved spec on its branch, behind a draft pull request into the integration branch
argument-hint: <spec number, e.g. 043>
disable-model-invocation: true
---

Build spec **$ARGUMENTS** to what it says.

The spec was argued out in `/canon:define` and approved with `/canon:approve`. Its
`**Status:** approved` line records that, and this command reads the record rather than taking a
typed number on trust. Build the spec rather than redesigning it. The owner being in the room does
not reopen the design; it means a question costs one reply instead of a failed run.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>`, `<integration>` and `<production>` mean its `owner`, `branches.integration` and
`branches.production`. **The gate** is every non-null entry of its `commands`, in the order
typecheck, lint, format, test. A null entry is a check the project does not have: say so where the
gate is reported, never count it as a pass.

## Steps

1. **Find the branch `/canon:approve` pushed, and check it out.** The spec is
   `docs/specs/$ARGUMENTS-<slug>.md` and its branch is `<prefix>/<slug>`.

   ```bash
   git fetch --prune origin
   git branch -r --list "origin/*/<slug>"
   git checkout -B "$branch" "origin/$branch"
   ```

   No match, or more than one, is a stop. Confirm the branch is based on `<integration>`, never on
   `<production>` or another feature branch. `-B` from the remote ref is what picks up an approval
   pushed from another clone.

2. **Read the spec, and refuse unless it is `approved`.** Read the TL;DR, then every section the
   build needs. A correction the owner made in this conversation after approval overrides the
   file: fold it into the spec first, because the spec is the contract `/canon:review` checks.

   - **`draft`**: nobody approved it. Point at `/canon:approve`.
   - **`in-progress`**: a build already started. Say what the branch carries beyond the approval
     and ask whether to resume.
   - **`shipped` or `abandoned`**, or a spec only in `docs/specs/archive/`: finished work.
   - **No spec file**: stop, and ask whether to run `/canon:define`. Never write it yourself.

3. **Set `in-progress` in its own commit, and push it**, before any code. That makes a second
   build of the same number meet a state that refuses. Commit `docs: start building spec NNN`,
   body `Spec: NNN`, then `git push -u origin HEAD`.

4. **Bring `<integration>` in before writing a line of code.**

   ```bash
   git fetch --prune origin
   git merge --no-edit origin/<integration>
   ```

   A merge, never a rebase: the branch is pushed. **A conflict here stops the run** unless the
   resolution is obviously mechanical. Anything touching the spec's own subject means
   `<integration>` moved under the spec: say what conflicted and let the owner decide. Do the same
   again before the gate in step 9 if the build ran long.

5. **Read the canon and every file in `## Where`.** `docs/canon/README.md` first, then each file
   whose `Read when` matches. Build to it and never diverge silently: if the work wants a
   different answer, stop and say which file and line, what the rule costs and what the better
   answer buys. Then read every file the spec's `## Where` lists. If an existing module has to be
   refactored to become usable, do that first as its own commit. **If `## Where` implies more
   structural work than the spec describes, stop and flag it.**

6. **Open a draft pull request into `<integration>`**, before writing code:

   ```bash
   gh pr create --draft --base <integration> --head "$branch" --title "<type>: <subject>" --body-file <file>
   ```

   The body covers what changed, why and how to verify, then a last line `Spec: NNN`.

7. **Decide whether to build in waves, and say which in one line.** Waves apply only when the spec
   names work in three or more distinct layers that write disjoint file sets. Anything else builds
   sequentially. When eligible:

   - **Write the unit table first**: name, spec lines covered, canon file, the exact paths it
     owns, the unit it depends on.
   - **Same wave means no path in two units and no unit reads another's output.**
   - **At most one unit per wave creates a new shared module**, so two agents do not each create
     the same thing in a tree without the other's file.
   - **Ownership governs writes, not reads.** Every unit reads the whole repository.
   - **Dispatch one subagent per unit, all of a wave in one message**, in the foreground. Each
     gets its spec excerpt, owned paths, canon file and the `.claude/rules/` files whose `paths`
     match. Each writes nothing outside its paths, commits nothing, runs no gate, and returns the
     files it wrote.
   - **Integrate before the next wave**: compare `git status --porcelain` with the owned paths,
     then commit each unit as its own change and push.
   - **A unit that overruns its paths voids its wave**; it is rebuilt sequentially.

8. **Build to the spec.** `CLAUDE.md` and `.claude/rules/` govern. No dependency the spec does not
   name, no abstraction for something that exists once, no placeholder text presented as real.
   One logical change per commit, each with `Spec: NNN` in the body and the project's commit
   conventions. Push with `git push -u origin HEAD` as you go.

9. **Run the gate.** Every configured check must pass before the pull request leaves draft. A
   check that is not configured is reported as absent.

10. **Mark the pull request ready**: `gh pr ready <number>`.

    **The canon hook may refuse this** when the branch touched a path mapped in
    `.claude/canon-domains.json` and no `docs/canon/` file. That is expected: the canon is
    written after review, by `/canon:canon`. Leave the pull request in draft and report that it
    is waiting on `/canon:canon`. Do not set the bypass to get past it.

11. **Stop and report** the branch, the pull request URL, whether it is ready or waiting on
    `/canon:canon`, and anything left undone.

    Then say to run `/clear`, then `/canon:review NNN` and `/code-review`, then `/canon:canon`,
    then `/canon:staging`. `/canon:review` reads the branch from git, never from the
    conversation, so it loses nothing by starting cold.

    **Under `/canon:ship` there is no hand-off.** Report the branch, the pull request number,
    ready or waiting on `/canon:canon`, and anything undone, and nothing about what to run next.

## Hard limits

- **One status move: `approved` to `in-progress`, at step 3.**
- **Never push directly to `<integration>` or `<production>`. Never force-push, amend or rebase a
  pushed commit.**
- **Three fix attempts at the gate.** Still failing after three: report the failing command, its
  output and what you tried, and leave the pull request in draft. Never disable, skip or weaken a
  test to pass.
- **No dependency the spec does not name.** If the build cannot proceed without one, ask.
- **Do not modify `CLAUDE.md`, `.claude/settings.json`, `.claude/canon.json` or `docs/canon/`**
  beyond a change the spec named. A wave agent writes none of them, nor `.github/`.
- **No route, page or feature the spec does not define.**
