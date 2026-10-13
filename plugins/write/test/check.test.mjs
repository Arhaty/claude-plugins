/**
 * The checker: each hard pattern fires, the places the skill exempts (code, quotes,
 * front matter) stay quiet, every flag points at a real entry in patterns.md, and
 * the vocabulary list there is covered.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { check, format } from '../scripts/check.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHECK = join(ROOT, 'scripts', 'check.mjs');
const PATTERNS = readFileSync(join(ROOT, 'skills/write/references/patterns.md'), 'utf8');

const hard = (text) => check(text).filter((f) => f.level === 'HARD');
const names = (flags) => flags.map((f) => f.name);

function cli(args, input) {
  const result = spawnSync(process.execPath, [CHECK, ...args], { input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('hard patterns', () => {
  const cases = [
    ['The release is out — go get it.', 'dash'],
    ['The release is out -- go get it.', 'dash'],
    ["It's not just fast, it's smart.", 'not X but Y'],
    ['The trends come from tickets rather than surveys.', 'not X but Y'],
    ['Honestly, the plan works.', 'directness opener'],
    ["Here's the thing: it works.", 'directness opener'],
    ["Let's dive in.", 'staged run-up'],
    ['What nobody tells you is that it works.', 'faux insight'],
    ['I hope this helps you decide.', 'chatbot residue'],
    ["You're absolutely right about the cost.", 'sycophancy'],
    ["Don't hesitate to call.", 'closing pleasantry'],
    ['We are thrilled to announce version 2.', 'announcement opener'],
    ["Whether you're new or not, it works.", 'audience sweep'],
    ['The tool works. Moreover, it is cheap.', 'mechanical transition'],
    ['Let that sink in.', 'read-this-way line'],
    ['The launch is a testament to the team.', 'inflated significance'],
    ['The page serves as an index.', 'copula avoidance'],
    ['She was involved in the migration.', 'vague role'],
    ['The data tells us to wait.', 'false agency'],
    ['Sources: https://example.com/?utm_source=chatgpt.com', 'chatbot debris'],
    ['Signed, [Your Name]', 'chatbot debris'],
  ];
  for (const [text, name] of cases) {
    it(`flags ${name}: ${text}`, () =>
      assert.ok(names(hard(text)).includes(name), names(hard(text))));
  }

  it('matches a curly apostrophe as well as a straight one', () => {
    assert.ok(names(hard('It’s not just fast.')).includes('not X but Y'));
  });

  it('reads mechanical transitions only at the start of a sentence', () => {
    assert.deepEqual(names(hard('We added it, moreover, by hand.')), []);
  });
});

describe('what it leaves alone', () => {
  it('passes plain text', () => {
    assert.deepEqual(hard('We ship on Friday. The fix cuts load time from 3 s to 1 s.'), []);
  });

  it('skips fenced code and keeps line numbers', () => {
    const text = [
      'Intro line here.',
      '```bash',
      'echo -- rather than',
      '```',
      'Honestly, no.',
    ].join('\n');
    const flags = hard(text);
    assert.deepEqual(
      flags.map((f) => [f.line, f.name]),
      [[5, 'directness opener']]
    );
  });

  it('skips a tilde fence and an indented one', () => {
    assert.deepEqual(hard('~~~\nhonestly\n~~~\n  ```\n  rather than\n  ```\n'), []);
  });

  it('skips inline code', () => {
    assert.deepEqual(hard('Pass `--rather-than` or `honestly` as a flag.'), []);
  });

  it('skips blockquotes and double-quoted text', () => {
    assert.deepEqual(hard('> Honestly, a quote.\nAvoid "rather than" in reports.'), []);
  });

  it('still finds debris inside quotes', () => {
    assert.deepEqual(names(hard('See "https://a.example/?utm_source=openai".')), [
      'chatbot debris',
    ]);
  });

  it('skips front matter', () => {
    assert.deepEqual(hard('---\ntitle: Honestly\n---\nPlain text.'), []);
  });

  it('treats an en dash in a numeric range as a look, not a hard flag', () => {
    const flags = check('Pages 3–5 cover it.');
    assert.deepEqual(hard('Pages 3–5 cover it.'), []);
    assert.ok(flags.some((f) => f.level === 'LOOK' && f.name === 'en dash in a range'));
  });

  it('treats a curly quote as a look, not a hard flag', () => {
    const flags = check('He said “no”.');
    assert.deepEqual(hard('He said “no”.'), []);
    assert.ok(flags.some((f) => f.name === 'curly quote'));
  });
});

describe('document checks', () => {
  it('counts exclamation marks past one', () => {
    assert.ok(check('Done! Shipped!').some((f) => f.name.startsWith('2 exclamation marks')));
    assert.ok(!check('Done! Shipped.').some((f) => f.name.includes('exclamation')));
  });

  it('flags a verbless fragment and passes a sentence', () => {
    assert.ok(check('Four weeks.').some((f) => f.name === 'possible fragment'));
    assert.ok(!check('It took four weeks.').some((f) => f.name === 'possible fragment'));
  });

  it('flags flat rhythm', () => {
    const text = Array.from(
      { length: 4 },
      () => 'The team shipped the new build on time today.'
    ).join(' ');
    assert.ok(check(text).some((f) => f.name.startsWith('flat rhythm')));
  });

  it('flags a punchline closing more than one paragraph', () => {
    const p = 'The migration moved every table to the new cluster over a weekend. It held.';
    assert.ok(check(`${p}\n\n${p}`).some((f) => f.pattern === 38));
    assert.ok(!check(p).some((f) => f.pattern === 38));
  });
});

describe('patterns.md agrees with the checker', () => {
  const headings = new Map(
    [...PATTERNS.matchAll(/^### (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]])
  );

  it('numbers the patterns 1 to 40 with none missing', () => {
    assert.deepEqual(
      [...headings.keys()],
      Array.from({ length: 40 }, (_, i) => i + 1)
    );
  });

  it('points every numbered flag at a pattern that exists', () => {
    const sample = [
      'Honestly, it’s not just fast — it serves as a testament. Four weeks.',
      'Moreover, the data tells us. Pages 3–5! Done! She was involved in it.',
      "Let's dive in. What nobody tells you is this. I hope this helps.",
    ].join('\n');
    for (const flag of check(sample)) {
      if (flag.pattern !== null) assert.ok(headings.has(flag.pattern), format(flag));
    }
  });

  const section = (title) => {
    const start = PATTERNS.indexOf(`## ${title}`);
    const end = PATTERNS.indexOf('\n## ', start + 1);
    return PATTERNS.slice(start, end === -1 ? undefined : end);
  };
  const vocabulary = section('Vocabulary: cut or replace');
  const entries = (text) =>
    text
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .split(/,\s*/)
      .map((entry) => entry.replace(/\.$/, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

  const words = entries(vocabulary.split('\n\n')[1]);
  const phrases = entries(vocabulary.split('\n\n')[2].replace(/^Phrases:\s*/, ''));

  it('parses the vocabulary section', () => {
    assert.ok(words.length > 50, `${words.length} words`);
    assert.ok(phrases.length > 10, `${phrases.length} phrases`);
  });

  for (const entry of [...words, ...phrases]) {
    it(`flags "${entry}"`, () => {
      assert.ok(
        check(`We saw ${entry} here.`).some((f) => f.level !== 'LOOK'),
        entry
      );
    });
  }
});

describe('command line', () => {
  it('exits 1 on a hard flag and prints it with its pattern number', () => {
    const result = cli([], "Let's dive in.\n");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^L1 +HARD #6 staged run-up: 'Let's dive'$/m);
  });

  it('exits 0 and says so on clean text', () => {
    const result = cli([], 'We ship it on Friday.\n');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'No flags.\n');
  });

  it('reads a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-check-'));
    try {
      writeFileSync(join(dir, 'draft.md'), 'Honestly, it works.\n');
      assert.equal(cli([join(dir, 'draft.md')]).status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on a missing file or a stray flag', () => {
    assert.equal(cli(['/nonexistent/draft.md']).status, 2);
    assert.equal(cli(['--strict']).status, 2);
  });
});

describe('wrapped lines', () => {
  it('finds a pattern split across a line break, on the line where it starts', () => {
    const flags = hard('The trends come from tickets rather\nthan surveys.');
    assert.deepEqual(
      flags.map((f) => [f.line, f.name]),
      [[1, 'not X but Y']]
    );
  });

  it('reports a sentence-initial pattern on its own line', () => {
    assert.deepEqual(
      hard('It broke on Monday.\nThe thing is, nobody saw it.').map((f) => f.line),
      [2]
    );
  });

  it('skips a quotation that wraps', () => {
    assert.deepEqual(hard('Avoid phrases like "it is not just\nX, it is Y" in reports.'), []);
  });

  it('does not take the end of a wrapped sentence for a fragment', () => {
    const text = 'It quotes each line that does, names the pattern and leaves the rewrite\nto you.';
    assert.ok(!check(text).some((f) => f.name === 'possible fragment'));
  });

  it('keeps list items apart', () => {
    assert.deepEqual(hard('- tickets rather\n- than surveys'), []);
  });

  it('leaves "the thing is" alone mid-sentence', () => {
    assert.deepEqual(hard('State what the thing is and stop.'), []);
  });
});

describe('quotations', () => {
  it('skips text in curly double quotes', () => {
    assert.deepEqual(hard('We tried and \u201chonestly\u201d it worked.'), []);
  });

  it('blanks no more than one quotation when a curly quote is left open', () => {
    const flags = hard('He said \u201chonestly ok. Then \u201cfine\u201d honestly.');
    assert.equal(flags.filter((f) => f.name === 'directness opener').length, 2);
  });

  it('treats a lazy continuation of a blockquote as part of the quote', () => {
    assert.deepEqual(hard('> A quote here\nAdditionally, we ship.'), []);
  });

  it('ends the quote at an empty ">" line', () => {
    assert.deepEqual(names(hard('> quote\n>\nAdditionally, we ship.')), ['mechanical transition']);
  });

  it('does not take the end of a blanked quotation for the start of a sentence', () => {
    assert.deepEqual(hard('"We tried" Additionally, we ship.'), []);
  });
});

describe('phrases and inflected forms', () => {
  it('matches phrases as whole words only', () => {
    const words = check('Clean into the room. That scale of work was big. A number offset.')
      .filter((f) => f.name === 'phrase')
      .map((f) => f.match);
    assert.deepEqual(words, []);
    assert.ok(check('We lean into it at scale.').some((f) => f.match === 'lean into'));
  });

  it('flags a plain -s ending on the last word of a phrase', () => {
    for (const [text, phrase] of [
      ['We ran three deep dives last week.', 'deep dive'],
      ['Two circle backs later, it shipped.', 'circle back'],
    ]) {
      assert.ok(
        check(text).some((f) => f.match === phrase),
        text
      );
    }
  });

  it('flags "emerges" as false agency', () => {
    assert.ok(names(hard('A pattern emerges here.')).includes('false agency'));
  });
});

describe('sentence openers', () => {
  for (const text of [
    '- Additionally, we ship weekly.',
    '1. Moreover, it is cheap.',
    '- The truth is it broke.',
    '## The thing is, it broke',
    'Additionally, we ship.',
  ]) {
    it(`flags an opener at the start of a paragraph, list item or heading: ${text}`, () => {
      assert.equal(hard(text).length, 1, names(hard(text)).join());
    });
  }
});
