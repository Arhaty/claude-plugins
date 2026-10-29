#!/usr/bin/env bash
# A canon project that adds its own check to /canon:review: a project command that finds secrets
# written into code. The file under review holds one, and nothing else is wrong with it.
set -euo pipefail
git init -q -b main
git config user.name Eval
git config user.email eval@example.com
mkdir -p .claude/commands docs/canon src
cat > .claude/canon.json <<'JSON'
{
  "version": 1,
  "owner": "Ada",
  "branches": { "integration": "staging", "production": "main", "prefixes": ["feat", "fix"] },
  "packageManager": "none",
  "commands": { "typecheck": null, "lint": null, "format": null, "test": null },
  "formatFile": null,
  "urls": { "preview": null, "staging": null, "production": null },
  "review": { "extraSkills": ["hardcoded-urls"] }
}
JSON
printf '{ "$comment": ["Paths to the canon file that governs them."] }\n' > .claude/canon-domains.json
printf '# Canon\n' > docs/canon/README.md
cat > .claude/commands/hardcoded-urls.md <<'MD'
---
description: Find hardcoded http(s) URLs in code that should come from configuration
---

Check the files in scope for any `http://` or `https://` URL written into code. Each one is a
finding: the deployment's address belongs in configuration, and a hardcoded one points staging at
production. Report each with its file and line.
MD
cat > src/client.ts <<'TS'
export const api = 'https://api.example.com/v1';
export const timeoutMs = 5000;
TS
git add -A
git commit -q -m "chore: initial project"
