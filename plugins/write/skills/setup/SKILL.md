---
name: setup
description: Set up the write skill in this project: write .claude/write.json and a tone-of-voice guide from the plain, formal or casual preset, asking before changing any existing file
argument-hint: (none)
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion
---

# Set up write in this project

The `write` skill works without setup, on its defaults. Setup gives it the project's own voice:
`.claude/write.json` names the language, the style guide and a file of samples, and the guide can
start from one of three presets.

**Nothing that exists is overwritten without asking.** The scaffolder plans first, lists every
file that exists and differs, and writes nothing until each one is approved by name.

## Steps

1. **Find the project root and what is already there.**

   ```bash
   git rev-parse --show-toplevel 2>/dev/null || pwd
   ls .claude/write.json 2>/dev/null
   ```

   If `.claude/write.json` exists, read it: its values are the defaults for every question
   below, and this run is a change, not a first setup.

   Look for a style guide the project already has: `Glob` for `**/*{style,voice,tone,writing}*.md`
   outside `node_modules`, and check `CONTRIBUTING.md` and `docs/` for a writing section. Read
   what you find.

2. **Ask, in one `AskUserQuestion` call, with the defaults as the first, recommended option:**

   - **Language**: the one the project writes in. Default `English`, or the language of the
     existing README if it is clearly another one.
   - **Guide**: one of
     - an existing guide found in step 1, used as it is (recommended when one exists);
     - a new guide from the **plain** preset (general purpose: docs, web copy, email), the
       **formal** preset (reports, policies, contracts, institutional mail) or the **casual**
       preset (community posts, chat, newsletters, changelogs), written to a path, default
       `docs/tone-of-voice.md`;
     - a URL to a guide published elsewhere (`https://` only);
     - none: the skill's defaults.
   - **Samples**: whether to keep a file of sent or published text for the skill to match,
     default `docs/writing-samples.md`, or none.

3. **Write the answers to a scratch file and plan.** The answers file is the config:

   ```json
   {
     "version": 1,
     "language": "English",
     "guide": "docs/tone-of-voice.md",
     "samples": "docs/writing-samples.md"
   }
   ```

   `guide` and `samples` are paths relative to the project root, or `null`; `guide` may also be
   an `https://` URL. Write the file outside the project (your scratchpad or `$TMPDIR`), then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" plan --root <project root> --answers <file> [--preset plain|formal|casual]
   ```

   Pass `--preset` only when the user chose a new guide from a preset. Each line is `create`,
   `same`, `keep`, `conflict`, `symlink` or `blocked`. `keep` is a samples file that already
   exists, which is never written. `symlink` means the path runs through a link that leads
   outside the project or nowhere; `blocked` means a directory sits where the file goes, or a
   file where a directory must be. Nothing is written until the user clears either. An invalid answers file exits 2
   and names every problem: fix the answer, not the check.

4. **Ask about every conflict, by name.** For each `conflict`, say what it is and what would
   change: an existing guide would be replaced by the preset, an existing `.claude/write.json` by
   the new answers. Show a diff when it helps. Then apply, naming every conflict once: `--allow`
   for each the user approved, `--skip` for each they declined, with the paths as the plan
   printed them:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" apply --root <project root> --answers <file> [--preset <name>] --allow <path> ... --skip <path> ...
   ```

   A skipped conflict stays as it is and the rest is written. If that leaves the setup
   inconsistent (a config pointing at a guide that is not the preset they picked), say so.

5. **Report** in a few lines: the files created, updated and left alone; that nothing is
   committed; and the next steps: edit the guide until it sounds like the project (it overrides
   the skill wherever they disagree), and paste three or four real samples into the samples file.

## Hard limits

- **Never overwrite or edit an existing file without the user approving that path.**
- **Never commit or push.**
- **Never write a guide's content yourself in this skill.** The guide comes from a preset or
  already exists; the user edits it.
