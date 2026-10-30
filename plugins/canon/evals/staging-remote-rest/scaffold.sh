#!/usr/bin/env bash
# A canon project on a feature branch whose spec is in progress, ready for /canon:staging.
set -euo pipefail
git init -q -b main
git config user.name Eval
git config user.email eval@example.com
mkdir -p .claude docs/canon docs/specs/archive src
cat > .claude/canon.json <<'JSON'
{
  "version": 1,
  "owner": "Ada",
  "branches": { "integration": "staging", "production": "main", "prefixes": ["feat", "fix", "chore", "refactor", "docs"] },
  "packageManager": "none",
  "commands": { "typecheck": null, "lint": null, "format": null, "test": null },
  "formatFile": null,
  "urls": { "preview": null, "staging": null, "production": null }
}
JSON
cat > .claude/canon-domains.json <<'JSON'
{ "$comment": ["Paths to the canon file that governs them."] }
JSON
printf '# Canon\n' > docs/canon/README.md
printf '# Specs\n\nStatuses: draft, approved, in-progress, shipped.\n' > docs/specs/README.md
printf 'export const greeting = "hi";\n' > src/greeting.ts
git add -A
git commit -q -m "chore: initial project"
git branch staging
git clone -q --bare . .git/origin.git
git remote add origin "$PWD/.git/origin.git"
git fetch -q origin
git checkout -q -b feat/greeting origin/staging --no-track
cat > docs/specs/001-greeting.md <<'MD'
# 001 — Greeting

**Status:** in-progress

## TL;DR

Say hello instead of hi.

## Decisions

| Question | Answer | Decided by |
| -------- | ------ | ---------- |
| Word     | hello  | Ada        |

## Still open

None.
MD
git add docs/specs/001-greeting.md
git commit -q -m "docs: draft spec 001"
printf 'export const greeting = "hello";\n' > src/greeting.ts
git commit -q -am "feat: say hello" -m "Spec: 001"
git push -q -u origin HEAD
