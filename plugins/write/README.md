# write

A Claude Code skill for text someone other than you will read: emails, posts, docs, READMEs, site
copy, reports and replies. It drafts in the project's voice, edits your drafts with the smallest
change that works, and strips the patterns that make text read as machine-written. Ask it whether
a draft "reads as AI" and it quotes each line that does, names the pattern and leaves the rewrite
to you.

It does not apply to Claude's replies to you in chat.

## Prerequisites

- Claude Code
- macOS or Linux
- Node 20 or later, for the checker. It uses only Node built-ins; nothing is installed.

## Install

```text
/plugin marketplace add arhaty/claude-plugins
/plugin install write@arhaty
/write:setup
```

Setup is optional. Without it the skill writes in a plain default voice and suggests setup once.

## What setup asks and writes

`/write:setup` looks for a style guide the project already has, then asks:

- the language the project writes in
- which guide to use: the existing one, a new one from a preset, a URL, or none
- whether to keep a samples file

| File                              | What it is                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `.claude/write.json`              | The language, the guide's path or URL, and the samples path.                     |
| `docs/tone-of-voice.md` (default) | The guide, from the `plain`, `formal` or `casual` preset. Only if you chose one. |
| `docs/writing-samples.md`         | Text the project has sent or published, one sample per `##` heading.             |

The guide overrides the skill wherever the two disagree: spelling, punctuation, sign-offs,
register, banned words. Edit it until it sounds like the project. Three or four real samples do
more for length and tone than any rule.

Setup never replaces an existing file without asking for that file by name, keeps an existing
samples file as it is, and won't write through a symlink that leads out of the project.

| Preset   | For                                                                       |
| -------- | ------------------------------------------------------------------------- |
| `plain`  | General use: documentation, web copy, email.                              |
| `formal` | Reports, policies, contracts, letters to institutions. No contractions.   |
| `casual` | Community posts, chat, newsletters, changelogs, product copy with an "I". |

## The checker

The skill runs `scripts/check.mjs` on English drafts before handing them over. You can run it
yourself:

```bash
node ~/.claude/plugins/marketplaces/arhaty/plugins/write/scripts/check.mjs draft.md
```

```text
L3    HARD #7 dash: '—'
L3    HARD #1 not X but Y: 'it's not'
L5    WORD vocabulary: 'seamless'
DOC   LOOK #38 3 paragraphs end on a short line (budget: 1)
```

`HARD` is a pattern from Tier 1 or 2 of the [pattern list](skills/write/references/patterns.md),
and the exit code is 1 when one fires. `WORD` is a listed word or phrase. `LOOK` is a candidate:
a verbless fragment, flat sentence rhythm, a punchline closing every paragraph. `#n` is the
pattern's number in the list. Every flag is a place to look, not a verdict. Code, blockquotes and
text in double quotes are skipped.

## Limitations

- **The pattern list and the checker are English only.** In another language the skill keeps its
  method (cut what is there for effect, two passes, a score) and relies on the guide.
- **The checker matches text, not meaning.** It flags "rather than" whether or not the contrast is
  invented, and misses a tell phrased in words it doesn't list. It reads a listed phrase with a
  plain ending ("deep dives") but not every inflection ("deep diving", "doubled down"), and it
  reads Markdown loosely, not to the CommonMark spec.
