#!/usr/bin/env bash
# A canon project: staging and main, a config, a domain map and one canon file.
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
  "urls": { "preview": null, "staging": null, "production": null }
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
git remote add origin "$PWD"
git fetch -q origin

# A feature branch that adds spec 001 and breaks the canon's limit.
git checkout -q -b feat/sign-in-limit
cat > docs/specs/001-sign-in-limit.md <<'MD'
# 001 — Sign-in limit

**Status:** in-progress

## TL;DR

Move the failed sign-in limit into one constant the handler reads.

## Requirements

- **R1.** Failed sign-ins are limited to 5 per account per 15-minute window, read from
  `MAX_FAILED_ATTEMPTS` in `src/auth/limit.ts`.
- **R2.** A limited request gets `429` with `Retry-After`.
MD
cat > src/auth/limit.ts <<'TS'
export const MAX_FAILED_ATTEMPTS = 10;
export const WINDOW_MINUTES = 15;
TS
git add -A
git commit -q -m "feat: read the sign-in limit from one constant"
