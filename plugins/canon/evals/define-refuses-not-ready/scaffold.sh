#!/usr/bin/env bash
# A canon project with a Linear tracker, team ABC, and issue ABC-7 already being built.
# Linear is a stub: the project's settings preload it into every node process, it answers
# from the issue below, and it logs every write to .git/linear-stub/writes.log.
set -euo pipefail
git init -q -b main
git config user.name Eval
git config user.email eval@example.com
mkdir -p .claude docs/canon docs/specs/archive src/auth .git/linear-stub
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
    "provider": "linear",
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

cat > .git/linear-stub/issue.json <<'JSON'
{ "id": "uuid-7", "identifier": "ABC-7", "title": "Rate-limit password reset requests",
  "description": "Limit password reset requests per account.", "state": "In Progress" }
JSON
cat > .git/linear-stub/stub.mjs <<'JS'
import { appendFileSync, readFileSync } from 'node:fs';
const dir = new URL('./', import.meta.url);
const issue = JSON.parse(readFileSync(new URL('issue.json', dir), 'utf8'));
const names = ['Todo', 'In Spec', 'Approved', 'In Progress', 'Blocked', 'In Staging', 'Done'];
const reply = (data) => new Response(JSON.stringify({ data }), { status: 200 });
globalThis.fetch = async (_, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
  const node = {
    id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description,
    url: `https://linear.app/example/issue/${issue.identifier}`, team: { key: 'ABC' },
    state: { name: issue.state }, labels: { nodes: [] },
  };
  if (/^(SetState|Comment|Label)$/.test(op)) {
    appendFileSync(new URL('writes.log', dir), `${op} ${JSON.stringify(variables)}\n`);
  }
  switch (op) {
    case 'Issue': return reply({ issue: variables.id === issue.identifier ? node : null });
    case 'Comments': return reply({ issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } });
    case 'States': return reply({ workflowStates: { nodes: names.map((name, i) => ({ id: `s${i}`, name, type: 'started', position: i })) } });
    case 'SetState': return reply({ issueUpdate: { success: true } });
    case 'Comment': return reply({ commentCreate: { success: true } });
    case 'Labels': return reply({ issueLabels: { nodes: [] } });
    case 'Label': return reply({ issueUpdate: { success: true, issue: node } });
    default: return reply(null);
  }
};
JS
cat > .claude/settings.json <<JSON
{ "env": { "LINEAR_API_KEY": "lin_api_eval", "NODE_OPTIONS": "--import=$PWD/.git/linear-stub/stub.mjs" } }
JSON

git add -A
git commit -q -m "chore: initial project"
git branch staging
git checkout -q staging
git remote add origin "$PWD"
git fetch -q origin
