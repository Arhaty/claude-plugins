# The local gate

The gate is every non-null entry of `commands` in `.claude/canon.json`, run in the order
typecheck, lint, format, test, build. A null or absent entry is a check the project does not
have: say so where the gate is reported, and never count it as a pass. Each runs from the
project root with `set -o pipefail`, and a non-zero exit is a failure.

## The build

`commands.build` is optional. It is a command string, like the others, or an object for a build
that needs more than a command line:

```json
"build": {
  "command": "pnpm build",
  "env": { "SITE_URL": "https://staging.example.com", "DATABASE_URL": "postgres://127.0.0.1:54322/postgres" },
  "requires": "supabase status"
}
```

- **`env`** is set for the build alone: run it as `env NAME=value ... <command>`, each value
  quoted. Copy what CI sets for the same step, so the local build stands in for the CI one.
- **`requires`** is a command that says whether what the build needs is there, such as a local
  database. Run it first, with its output discarded. **Exit 0: run the build.** Anything else:
  skip the build, and say in the hand-back that it was skipped because `<requires>` failed and is
  left to CI. A cloud session with no local services is the usual case. Never skip the build when
  `requires` succeeds, and never skip it when there is no `requires`.

A skipped build is not a pass: CI still has to build the same tree before `/canon:staging`
merges, which `ci.requiredCheck` makes certain when the CI check that builds is named there.
