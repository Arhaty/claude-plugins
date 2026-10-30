#!/usr/bin/env bash
# A canon project whose build needs a local service that is not running: `requires` fails.
set -euo pipefail
git init -q -b main
git config user.name Eval
git config user.email eval@example.com
mkdir -p .claude docs/canon docs/specs src
cat > .claude/canon.json <<'JSON'
{
  "version": 1,
  "owner": "Ada",
  "branches": { "integration": "staging", "production": "main", "prefixes": ["feat", "fix"] },
  "packageManager": "none",
  "commands": {
    "typecheck": null,
    "lint": "node lint.mjs",
    "format": null,
    "test": null,
    "build": {
      "command": "node build.mjs",
      "env": { "SITE_URL": "https://staging.example.com" },
      "requires": "node service-up.mjs"
    }
  },
  "formatFile": null,
  "urls": { "preview": null, "staging": null, "production": null }
}
JSON
printf '{ "$comment": ["Paths to the canon file that governs them."] }\n' > .claude/canon-domains.json
printf '# Canon\n' > docs/canon/README.md
printf 'console.log("lint ok");\n' > lint.mjs
printf 'console.error("database is not running"); process.exit(1);\n' > service-up.mjs
printf 'require("fs").writeFileSync("BUILT", process.env.SITE_URL ?? "");\n' > build.mjs
printf 'export const greeting = "hello";\n' > src/greeting.ts
git add -A
git commit -q -m "chore: initial project"
