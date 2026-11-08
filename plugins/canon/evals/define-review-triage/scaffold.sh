#!/usr/bin/env bash
# A canon project with spec review on, and spec 001 drafted on its branch with its questions
# answered. Its Decisions table chose a window the canon rules out.
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
  "autonomy": { "specReview": true }
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

**Covers.** sign-in, rate limiting, 429

## How it works

- **Failed sign-ins are limited to 5 per account per 15-minute fixed window.**
- **A limited request gets `429` with `Retry-After` in seconds.**
- **Every rate limit in auth counts in a 15-minute fixed window**, so one `Retry-After` rule holds.
MD
cat > docs/specs/README.md <<'MD'
# Specs

Statuses: draft, approved, in-progress, shipped. Number specs NNN in order.
MD
cat > docs/specs/_TEMPLATE.md <<'MD'
# NNN — <Change name>

**Status:** draft

## TL;DR

## Reuse check

## What

## Where

## Requirements

## Constraints

## Decisions

## Open questions
MD
cat > src/auth/limit.ts <<'TS'
export const MAX_FAILED_ATTEMPTS = 5;
TS
git add -A
git commit -q -m "chore: initial project"
git branch staging
git checkout -q staging
# A bare origin: define pushes its draft, and a non-bare one refuses a push to its checked-out branch.
git clone -q --bare . .git/origin.git
git remote add origin "$PWD/.git/origin.git"
git fetch -q origin
# Spec 001, drafted and pushed on its branch. Ada chose a sliding window on purpose.
git checkout -q -b feat/rate-limit-reset
cat > docs/specs/001-rate-limit-reset.md <<'MD'
# 001 — Rate-limit password reset requests

**Status:** draft

## TL;DR

Password reset requests are limited per account, so that the reset email cannot be used to flood
an inbox.

## Reuse check

`src/auth/limit.ts` holds the sign-in limit. The reset limit is added beside it and reuses its
429 response.

## What

A reset request over the limit gets `429` with `Retry-After`.

## Where

- `src/auth/limit.ts`

## Requirements

1. At most 3 reset requests per account in a 10-minute sliding window.
2. A request over the limit gets `429` with `Retry-After` in seconds.

## Verification

- Send 4 reset requests for one account within a minute: the fourth gets `429`.

## Constraints

None.

## Decisions

| Question            | Answer                                    | Decided by |
| ------------------- | ----------------------------------------- | ---------- |
| Window for resets   | 10-minute sliding window, 3 requests      | Ada        |
| Count per account   | Per account, not per IP                   | Ada        |

## Still open

None.
MD
git add -A
git -c user.name=Eval -c user.email=eval@example.com commit -q -m "docs: draft spec 001" -m "Spec: 001"
git push -q -u origin HEAD
