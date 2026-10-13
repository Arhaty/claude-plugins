#!/usr/bin/env bash
# A canon project with a tracker, team ABC, and issue ABC-8 specced on its branch and not yet approved.
# The tracker is canon's file-backed fixture provider: no key, no network, and every write lands
# in .claude/tracker-fixture.json, where a grader or a reader can check it.
set -euo pipefail
git init -q -b main
git config user.name Eval
git config user.email eval@example.com
mkdir -p .claude docs/canon docs/specs/archive src/auth
cat > .claude/canon.json <<'JSON'
{
  "version": 1,
  "owner": "Ada",
  "branches": { "integration": "staging", "production": "main", "prefixes": ["feat", "fix", "chore", "refactor", "docs"] },
  "packageManager": "none",
  "commands": { "typecheck": null, "lint": null, "format": null, "test": null },
  "formatFile": null,
  "urls": { "preview": null, "staging": null, "production": null },
  "tracker": {
    "provider": "fixture",
    "team": "ABC",
    "statuses": { "ready": "Todo", "spec": "In Spec", "approved": "Approved", "building": "In Progress", "blocked": "Blocked", "staging": "In Staging", "production": "Done" }
  }
}
JSON
cat > .claude/canon-domains.json <<'JSON'
{ "$comment": ["Paths to the canon file that governs them."], "auth.md": ["src/auth/"] }
JSON
cat > docs/canon/README.md <<'MD'
# Canon

| File      | Status   | Read when                         |
| --------- | -------- | --------------------------------- |
| `auth.md` | accepted | Changing sign-in or rate limiting |
MD
cat > docs/canon/auth.md <<'MD'
# Auth

**Status.** accepted

## How it works

- **Failed sign-ins are limited to 5 per account per 15-minute fixed window.**
MD
cat > docs/specs/README.md <<'MD'
# Specs

Statuses: draft, approved, in-progress, shipped. Number specs NNN in order.
MD
printf '# NNN — <Change name>\n\n**Status:** draft\n\n## TL;DR\n' > docs/specs/_TEMPLATE.md
echo 'export const MAX_FAILED_ATTEMPTS = 5;' > src/auth/limit.ts

cat > .claude/tracker-fixture.json <<'JSON'
{
  "states": ["Todo", "In Spec", "Approved", "In Progress", "Blocked", "In Staging", "Done"],
  "labels": ["domain-auth"],
  "issues": {
    "ABC-8": {
      "title": "Rate-limit password reset requests",
      "description": "Limit password reset requests per account.",
      "state": "In Spec",
      "labels": [],
      "comments": []
    }
  }
}
JSON

git add -A
git commit -q -m "chore: initial project"
git branch staging
git checkout -q staging
git remote add origin "$PWD"
git fetch -q origin

# The spec, on its branch. Its status line says approved, but the issue is still In Spec:
# nobody ran /canon:approve, and with a tracker the issue is the gate.
git checkout -q -b feat/abc-8-rate-limit-password-reset --no-track origin/staging
cat > docs/specs/001-rate-limit-password-reset.md <<'MD'
# 001 — Rate-limit password reset requests

**Status:** approved
**Issue:** ABC-8

## TL;DR

Limit password reset requests to 3 per account per hour, returning 429 with Retry-After.

## Reuse check

Extends src/auth/limit.ts.

## Where

- src/auth/limit.ts

## Decisions

| Question | Answer | Who |
| -------- | ------ | --- |
| Limit    | 3/hour | Ada |

## Still open

None.
MD
git add -A
git commit -q -m "docs: approve spec 001" -m "Spec: 001" -m "Part of ABC-8"
git push -q -u origin HEAD
