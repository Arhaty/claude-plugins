---
name: production
description: Prepare the release from the integration branch to production. Opens or refreshes the release pull request with a manifest of everything that would ship, watches CI, and stops for the owner to merge
argument-hint: (none, always integration into production)
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
---

# Prepare the release

**Do the work. Stop at the button.** Everything up to the merge runs without asking: the manifest,
the pull request, the description, the CI watch. The only thing left for a person is pressing
_Merge_, because that is the step that ships. **Opening a pull request ships nothing**: do not ask
before opening it.

## Before anything

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it fails, stop and pass its message on.
Below, `<owner>`, `<integration>` and `<production>` mean its `owner`, `branches.integration` and
`branches.production`; `urls.staging` and `urls.production` are quoted when set.

## What ships

**Everything currently on `<integration>`**, not just the change the owner was working on. That is
a fact to report in the manifest, not a question to ask first.

## Stop before opening the pull request only if

- **`<integration>` is not ahead of `<production>`.** Nothing to release.
- **`gh` is missing or not authenticated.** Hand over the manifest to paste into a pull request
  opened in the GitHub UI.

Everything else is a **warning that goes at the top of the manifest and the hand-back**, loudly,
with the pull request opened anyway:

- **CI on `<integration>` is red**: `gh run list --branch <integration> --limit 5`. Whatever is
  broken there is what would go live.
- **`<integration>` holds a commit that did not arrive through a pull request:**

  ```bash
  git log --no-merges --first-parent origin/<production>..origin/<integration>
  ```

  List each by subject. This works only while merges into `<integration>` are merge commits; say
  so if the history shows squash merges.

- **An active spec is on `<integration>`** with status `approved` or `in-progress`: started or
  half-merged work whose spec was never closed. A `draft` is a parked idea and is not listed.

  ```bash
  for f in $(git ls-tree --name-only origin/<integration> docs/specs/ | grep -E '/[0-9]{3}-[^/]*\.md$'); do
    printf '%s %s\n' "$f" "$(git show "origin/<integration>:$f" | grep -m1 '^\*\*Status:\*\*')"
  done | grep -E 'approved|in-progress'
  ```

- **Nobody has said they looked at the integration build.** Give `urls.staging` if set. Do not
  block on the answer.

## Steps

**1. Build the manifest.** The most valuable output, more than the pull request itself.

```bash
git fetch origin
git log --oneline --first-parent origin/<production>..origin/<integration>
git diff --stat origin/<production>...origin/<integration>
git diff --name-status origin/<production>...origin/<integration> -- docs/specs/
```

One line per merged pull request, saying what changed for a user rather than the commit subject.
A rename into `docs/specs/archive/` is a spec that shipped: list those by number, title and
status. Warnings at the top. Write the body to a file in a temp directory.

**2. Open or update the release pull request.** No checkout needed: `--head` does the work.

```bash
gh pr list --base <production> --head <integration> --state open
```

If one is open, **replace its description with the fresh manifest** (`gh pr edit <number>
--body-file <file>`): a stale manifest is read as the list of what is going live. Otherwise:

```bash
gh pr create --base <production> --head <integration> --title "release: <date>" --body-file <file>
```

Never `--fill`, which throws the manifest away, and never `--delete-branch`.

**3. Watch CI on the release head**, polling a bounded call with a widening gap rather than an
unbounded watch:

```bash
sha=$(gh pr view <number> --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/commits/$sha/check-runs" --jq '[.check_runs[]
  | select(.status == "completed" and (.conclusion | IN("success", "skipped", "neutral") | not))
  | {name, conclusion, url: .html_url}]'
```

Give up after about fifteen minutes and say where to look. If the head moves twice while polling,
say the release head is still moving and stop chasing it. **Do not fix anything on this branch**:
the route is a new branch from `<integration>`, `/canon:staging`, and the release updates itself.

**4. Never merge.** Not with `gh pr merge`, not with `--auto`, not because CI is green. The
`protect-merge` hook refuses it, and that is the design: this is the one thing handed to a person.

## Hand back

- Warnings first.
- The manifest of what ships, and the specs it carries.
- The pull request URL, and that **it is ready but not merged**.
- `urls.staging`, to open before merging if nobody has.
- That `<owner>` merges it in GitHub, and that production updates on merge.

Never say a word that implies it is live.
