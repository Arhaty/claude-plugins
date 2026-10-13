#!/usr/bin/env node
/**
 * The canon, extracted to the claims a review needs and nothing else, plus a check
 * that the index and the domain map are current.
 *
 *   node canon-index.mjs [project]           write .claude/canon-index.md
 *   node canon-index.mjs --check [project]   exit 1 if the index is stale or the map is wrong
 *
 * `project` defaults to the current directory. `/canon:canon` writes the index;
 * `/canon:review` reads it; a project can run `--check` in CI.
 *
 * `/canon:review` reading every canon file a diff touches as prose is most of its
 * context spent on reasoning it does not need until it has a finding. The canon
 * format makes that unnecessary: every rule is a bolded claim with at most a line of
 * why under it, so the rules are mechanically separable from the reasoning. This
 * separates them.
 *
 * What comes out is not a second copy of the canon. It is the rule text itself,
 * written by a script and never by hand. A finding cites the canon file, never this
 * file. Three things are carried:
 *
 *   - Every bolded claim, whole where it wraps across lines. The rules.
 *   - Every table row. A table is reference data rather than prose: a token, a
 *     route, an event name, an environment variable.
 *   - Each file's `**Status.**` line, which is what decides blocker against note.
 *
 * Every line is prefixed with its source file, which makes scoping a grep rather
 * than a judgement:
 *
 *   grep -E '^(seo|auth)\.md' .claude/canon-index.md
 *
 * The map checks are the other half of how a diff finds its rules. A key naming a
 * canon file that was renamed or deleted routes every path under it to nothing, and
 * both readers fail open on that: the hook allows the pull request and the review
 * greps an empty scope, so the run stays green and the governance is silently gone.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { symlinkIn } from '../hooks/lib/config.mjs';

/**
 * Neither holds a project rule. `README.md`'s bolded lines govern how canon is
 * written and the template's are placeholders, so both would read as binding once
 * stripped of context.
 */
const NOT_A_DOMAIN = new Set(['README.md', '_TEMPLATE.md', '_template.md']);

/**
 * Header routing rather than content: `Covers` is a keyword line and `In one line`
 * tells a reader whether to keep reading. `Status` is the one header line that stays.
 */
const HEADER_ROUTING = /^\*\*(?:Covers|In one line)\.\*\*/;

/**
 * A claim opens a line, and `Not decided` and `Rejected` write theirs as a list item,
 * so the marker and any indent come before the `**`. Matching only column zero drops
 * every one of those, and a dropped rule is a rule the review stops checking while
 * the run stays green.
 */
const CLAIM_OPENS = /^[ \t]*(?:[-*] )?\*\*/;

/** `***` and its kin are a horizontal rule, which `CLAIM_OPENS` would otherwise read as a claim. */
const THEMATIC_BREAK = /^\s*(?:\*\s*){3,}$/;

/** What ends a paragraph: a blank line, a heading, a new list item, or a table. */
const ENDS_CLAIM = /^\s*$|^#|^[ \t]*[-*] |^\|/;

/** A line that opens or closes a code fence. */
const FENCE = /^\s*(?:```|~~~)/;

/** `|---|---|` is a table's underline, not a row of it. */
const SEPARATOR_ROW = /^\|[\s:|-]+\|$/;

/** A row of `README.md`'s index table: the file in backticks, the status, then `Read when`. */
const INDEX_ROW = /^\|\s*`([^`]+\.md)`\s*\|[^|]+\|\s*(.+?)\s*\|$/;

export function domainFiles(canon) {
  return readdirSync(canon)
    .filter((f) => f.endsWith('.md') && !NOT_A_DOMAIN.has(f))
    .sort();
}

/**
 * A claim opens with `**` at the start of a line and closes with the next `**`, which
 * is often on a later line, so the claim is joined whole rather than cut mid-sentence.
 */
export function extract(name, source) {
  const lines = source.split('\n');
  const out = [];
  let fenced = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // An example inside a code fence is illustration, never a rule or a row of reference data.
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    if (line.startsWith('|')) {
      if (!SEPARATOR_ROW.test(line)) out.push(`${name}: ${line}`);
      continue;
    }

    const opens = line.match(CLAIM_OPENS);
    if (!opens || HEADER_ROUTING.test(line.trimStart()) || THEMATIC_BREAK.test(line)) continue;

    // A claim wraps inside its own paragraph and nowhere else. An unclosed `**` stops
    // at the paragraph's end and is kept as written, rather than swallowing every
    // claim below it.
    let claim = line.slice(opens[0].length - 2);
    while (
      !/\*\*.+\*\*/.test(claim) &&
      i + 1 < lines.length &&
      !ENDS_CLAIM.test(lines[i + 1] ?? '')
    ) {
      claim = `${claim} ${(lines[++i] ?? '').trim()}`;
    }
    out.push(`${name}: ${claim}`);
  }

  return out;
}

/** The file and its `Read when`, from `README.md`'s index table. */
export function routing(readme) {
  const rows = [];
  for (const line of readme.split('\n')) {
    const [, file, readWhen] = line.match(INDEX_ROW) ?? [];
    if (file && readWhen) rows.push(`| ${file} | ${readWhen} |`);
  }
  return rows;
}

export function build(root) {
  const canon = join(root, 'docs', 'canon');
  const claims = domainFiles(canon).flatMap((f) =>
    extract(f, readFileSync(join(canon, f), 'utf8'))
  );
  const readme = join(canon, 'README.md');
  const rows = existsSync(readme) ? routing(readFileSync(readme, 'utf8')) : [];

  return [
    '# Canon index',
    '',
    'Generated by the canon plugin (`/canon:canon`), never edited by hand.',
    'Every claim and table row in `docs/canon/`, prefixed with the file that owns it. The why',
    'under each claim is not here: open the canon file itself to report a finding, and cite that',
    'file rather than this one.',
    '',
    '## Routing',
    '',
    'Which file governs what, for a path `.claude/canon-domains.json` does not map.',
    '',
    '| File | Read when |',
    '| --- | --- |',
    ...rows,
    '',
    '## Claims',
    '',
    ...claims,
    '',
  ].join('\n');
}

/** Trailing slash is a directory prefix, an inner slash an exact path, a bare name a basename. */
export const matches = (path, pattern) =>
  pattern.endsWith('/')
    ? path.startsWith(pattern)
    : pattern.includes('/')
      ? path === pattern
      : basename(path) === pattern;

/** Every problem with the domain map, as readable lines. */
export function mapProblems(root) {
  const canon = join(root, 'docs', 'canon');
  const file = join(root, '.claude', 'canon-domains.json');
  if (!existsSync(file)) return ['.claude/canon-domains.json does not exist'];

  let map;
  try {
    map = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return [`.claude/canon-domains.json is not valid JSON (${error.message})`];
  }
  const problems = [];
  const keys = Object.keys(map).filter((key) => key !== '$comment');

  for (const key of keys) {
    if (!Array.isArray(map[key]) || !map[key].every((p) => typeof p === 'string' && p !== '')) {
      problems.push(`${key}: patterns must be a list of non-empty strings`);
      continue;
    }
    if (!existsSync(join(canon, key))) {
      problems.push(`${key} is mapped but docs/canon/${key} does not exist`);
      continue;
    }
    const header = readFileSync(join(canon, key), 'utf8').slice(0, 400);
    if (/\*\*Status\.\*\*\s*superseded/.test(header)) {
      problems.push(`${key} is superseded and still governs paths`);
    }
  }

  const owners = new Map();
  for (const key of keys) {
    for (const pattern of Array.isArray(map[key]) ? map[key] : []) {
      if (owners.has(pattern))
        problems.push(`${pattern} is mapped to both ${owners.get(pattern)} and ${key}`);
      owners.set(pattern, key);
    }
  }

  // Two patterns can be different strings and still claim one file, so the patterns
  // are matched against the tracked files the way `require-canon.mjs` matches them.
  let tracked = [];
  try {
    tracked = execFileSync('git', ['-C', root, 'ls-files'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    // Not a git work tree: nothing tracked to check.
  }
  for (const path of tracked) {
    const claimed = keys.filter(
      (key) => Array.isArray(map[key]) && map[key].some((p) => matches(path, p))
    );
    if (claimed.length > 1) problems.push(`${path} is owned by ${claimed.join(' and ')}`);
  }

  return problems;
}

function main(argv) {
  const check = argv.includes('--check');
  const root = resolve(argv.find((arg) => !arg.startsWith('--')) ?? '.');
  const canon = join(root, 'docs', 'canon');
  if (!existsSync(canon)) {
    process.stderr.write(`canon-index: ${canon} does not exist. Run /canon:setup first.\n`);
    return 1;
  }
  const out = join(root, '.claude', 'canon-index.md');
  const index = build(root);

  if (!check) {
    // A link could send the write anywhere the repository's author chose.
    const link = symlinkIn(root, '.claude/canon-index.md');
    if (link !== null) {
      process.stderr.write(`canon-index: ${link} is a symlink. Refusing to write through it.\n`);
      return 1;
    }
    writeFileSync(out, index);
    process.stdout.write(`.claude/canon-index.md: ${index.trimEnd().split('\n').length} lines\n`);
    return 0;
  }

  const problems = mapProblems(root);
  const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
  if (current !== index) {
    problems.unshift(
      '.claude/canon-index.md is stale. Regenerate it with /canon:canon or this script.'
    );
  }
  for (const problem of problems) process.stderr.write(`canon-index: ${problem}\n`);
  return problems.length ? 1 : 0;
}

// Behind an entrypoint guard so the tests can import `build` without writing a file.
const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  process.exitCode = main(process.argv.slice(2));
}
