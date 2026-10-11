---
name: explain
description: Explain what is being built, specced or stuck on, in three or four short sections, so the owner can decide from it
argument-hint: <spec number, file, path, or a question; nothing explains the work in flight>
allowed-tools: Bash, Read, Grep, Glob
---

# Explain it, short, so a decision can be made

This produces an explanation, never a change. Do not edit, commit or run anything that writes. It
exists for the moment before a decision: the answer has to fit on a screen.

**Length is the point.** Three sections, four when a decision is open. If it does not fit in about
a screen, cut it. The reader asks when they want more.

## Work out what to explain

`$ARGUMENTS` decides the subject:

| Argument            | Subject                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| A spec number       | That spec, its status and TL;DR, and the code that implements it             |
| A path or glob      | That code                                                                    |
| A question in prose | The answer to it, in the sections below                                      |
| Nothing             | What this session is in the middle of; failing that, the branch and its spec |

Read only what the subject needs. `.claude/canon-domains.json` routes a path to the one canon file
that governs it. **Never read a whole spec**: start at its `## TL;DR`. For how something works
today, read `docs/canon/`, never an archived spec.

## The sections

**Context** and **Content** always. **Options** and **Suggestion** only when a decision is open;
otherwise close on a one-line **Next**. Each heading on its own line, with a blank line before it.

**Context**: one or two sentences on what is being built and why it matters. Not process state: a
pull request opening or CI going green happened _to_ the work and does not say what it is.

**Content**: how the thing works, in plain words, for someone who has not read the code. Reach for
a table, a list or a small diagram before a paragraph. Repository bookkeeping (which commit is the
head, how many files changed) is not content.

**Options**: one row per option with its pro and con. Only a decision that is genuinely open and
genuinely the owner's.

**Suggestion**: which one, and the one reason it wins. Commit to it.

**Next**: the one-line replacement for the pair above when nothing is open.

If the subject is genuinely ambiguous, ask one question and stop.
