# Engineering principles

One line each: when it applies, then what to do. These are habits, not procedures. The
procedures live in `CLAUDE.md`, the canon and the canon commands, and where one of those decides
a case, it wins. Adapted from pstack (MIT, github.com/cursor/plugins).

## Deciding

- **Never block on the human.** On reversible work, proceed, present the result and let {{owner}}
  correct it after. Confirm only the irreversible: a deleted file, a push to a shared branch, a
  dependency, a published page or a sent message.
- **Attack the premise.** When two fixes that share one assumption have failed the same check,
  question the assumption before writing a third fix.
- **Experience first.** On a product or scope trade-off, choose what the user experiences over
  what is convenient to build. Fewer polished things over more rough ones.
- **Redesign from first principles.** Fit a new requirement as if it had been there from day one,
  not bolted on beside the old shape.
- **Exhaust the design space.** On a decision with no precedent in the codebase, build two or
  three small competing versions and compare, rather than committing to the first.

## Shaping code

- **Foundational thinking.** Choose the core types and data structures before the logic, so the
  downstream code becomes obvious.
- **Model the domain.** When logic branches a lot or repeats a shape assumption across files, put
  the domain in a structure: a state machine over scattered booleans, a table over an if-cascade.
- **Type-system discipline.** Illegal states unrepresentable, external data parsed at the
  boundary, variants exhausted, no lying to the compiler.
- **Boundary discipline.** Validate at the edges: route handlers, forms, config, external APIs.
  Trust internal types and keep business logic in pure functions.
- **Laziness protocol.** Bias toward deletion and the smallest change that solves the problem. No
  abstraction, layer or option for a need that does not exist yet.
- **Reuse before creating.** Search for what exists, reuse it, extend it with one optional
  parameter, generalise two copies into one, and only then create. Two similar things may stay
  separate; the third triggers extraction.
- **Subtract before you add.** Remove dead code, redundant guards and stub references first, then
  build on the simpler base.
- **Minimise reader load.** Count the layers between a question and its answer. Collapse a
  wrapper with one caller and shrink mutable scope.
- **Migrate callers, then delete the legacy.** A new internal API replaces the old one in the same
  change. No compatibility layer left behind.
- **Separate before serialising shared state.** When two actors might write the same file or
  branch, remove the sharing first. A lock is for a real invariant, not a convenience.
- **Make operations idempotent.** A command, a script or a loop that can be retried converges to
  the same end state whatever ran before it.

## Working

- **Fix root causes.** Reproduce first, ask why until the cause is reached, and fix it there. No
  null check that silences a crash.
- **Prove it works.** Before saying done, verify against the real artefact: run the route, read
  the actual value, inspect the diff. "It compiles" and a green self-report are not proof.
- **Test behaviour, not implementation.** Call the code the way its users do and assert the result
  they observe against a literal value. A test that still passes when every import returns
  `undefined` is deleted or rewritten.
- **Sequence verifiable units.** Multi-step work lands as small units that each end in a checked
  state, in an order that proves itself to a reader. One logical change per commit is this rule.
- **Outcome-oriented execution.** In a planned rewrite or migration, converge on the target. Do
  not spend effort on throwaway intermediate states.
- **Build the lever.** For any repeated edit, migration or check, write the script or codemod and
  run it. The script is what a reviewer can rerun.
- **Encode lessons in structure.** When writing the same instruction a second time, or seeing the
  same correction twice, make it a lint, a hook, a test or a type instead of more prose.
- **Guard the context window.** Route bulk reads, long outputs and fan-out to subagents, and keep
  only the conclusions in the main thread.
