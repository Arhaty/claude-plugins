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
    ['The vote was a defining moment for the town.', 'inflated significance'],
    ['These were watershed moments for the town.', 'inflated significance'],
    ['The empty room speaks volumes.', 'inflated significance'],
    ['The ferry is late. In short, plan for it.', 'recap closer'],
    ['At the end of the day, the ferry runs less often in winter.', 'recap closer'],
    ['The cafe opens at six. In other words, it is the first one open.', 'adjacent gloss'],
    ['Prices rose. What this means is that rent went up.', 'adjacent gloss'],
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

  it('reads recap closers only at the start of a sentence', () => {
    for (const text of [
      'It was ultimately cheaper than we thought.',
      'Write in short sentences.',
      'Keep it in short-term storage.',
      'Seats are in short supply.',
      'We did it all in all three regions.',
    ]) {
      assert.deepEqual(
        check(text).filter((f) => f.pattern === 3),
        [],
        text
      );
    }
  });

  it('reads "Ultimately," as a recap closer only in the last sentence of a paragraph', () => {
    assert.deepEqual(
      check('Ultimately, we chose the cheaper route. It was faster.').filter(
        (f) => f.pattern === 3
      ),
      []
    );
    for (const text of [
      'The ferry won. Ultimately, the ferry won.',
      'The rule: In short, it works.',
      'In conclusion, the ferry is late. Plan ahead for winter trips.',
    ]) {
      assert.ok(names(hard(text)).includes('recap closer'), text);
    }
  });

  it('needs the comma, so a heading, a phrase or a compound is not a recap closer', () => {
    for (const text of [
      'Prices rose. In short-term rentals, they doubled.',
      'All in all-weather tyres matter.',
      'Ultimately-cheaper plans won.',
      '## In summary\n\nThe ferry is late.',
      'In summary form the data is clear.',
    ]) {
      assert.deepEqual(hard(text), [], text);
    }
  });

  it('reports a recap closer once, under #3', () => {
    for (const text of ['In short, it works.', 'In conclusion, it works.']) {
      assert.deepEqual(
        check(text).map((f) => [f.level, f.pattern, f.name]),
        [['HARD', 3, 'recap closer']],
        text
      );
    }
  });

  it('reads a recap closer or a gloss in lowercase, after a list marker or a closing quote', () => {
    for (const [text, name] of [
      ['in other words, it works.', 'adjacent gloss'],
      ['- in short, it works', 'recap closer'],
      ['The road closed (it flooded.) In short, we waited.', 'recap closer'],
    ]) {
      assert.ok(names(hard(text)).includes(name), text);
    }
  });

  it('reads a gloss that follows a comma', () => {
    assert.ok(
      names(hard('The tide fell, which is to say the boats sat in mud.')).includes('adjacent gloss')
    );
  });

  it('needs the comma after a gloss that opens a sentence', () => {
    for (const text of [
      '## Put simply\n\nThe ferry is late.',
      'That is to say nothing of the cost.',
    ]) {
      assert.deepEqual(hard(text), [], text);
    }
  });

  it('marks an evaluative tail as a place to look, never a hard flag', () => {
    for (const text of [
      'The platform reopened in March, marking the end of a closure.',
      'The platform reopened in March, marking the end of a closure, which had lasted two years.',
      'Sales doubled, underscoring the demand.',
      'The lake was still, reflecting the mountains above it.',
    ]) {
      assert.deepEqual(hard(text), [], text);
      assert.ok(
        check(text).some((f) => f.level === 'LOOK' && f.pattern === 45),
        text
      );
    }
  });

  it('leaves a bare gerund in a list alone', () => {
    for (const text of [
      'The steps are sanding, marking, and painting.',
      'Prisms work by filtering, reflecting, and refracting light.',
      'The shop does cutting, marking, drilling.',
    ]) {
      assert.deepEqual(
        check(text).filter((f) => f.pattern === 45),
        [],
        text
      );
    }
  });

  it('leaves quoted text alone', () => {
    for (const text of [
      'She asked "Why?" and we left.',
      'She yelled "Stop!" Then he yelled "Run!"',
    ]) {
      assert.ok(!check(text).some((f) => f.pattern === 40), text);
    }
    assert.deepEqual(hard('The note said "ok." in short, fine.'), []);
  });

  it('reads "Ultimately," in the last sentence even when a quotation follows it', () => {
    assert.ok(
      names(hard('Ultimately, the harbour plan passed. "Finally."')).includes('recap closer')
    );
  });

  it('keeps other vocabulary words inside a hard match', () => {
    const words = check('The fix was robust and seamless alike.')
      .filter((f) => f.level === 'WORD')
      .map((f) => f.match);
    assert.deepEqual(words, ['robust', 'seamless']);
  });

  it('keeps offsets after a letter that lowercases to two', () => {
    const flags = check('İstanbul grew, and the plan was paving the way.');
    assert.deepEqual(
      flags.map((f) => f.name),
      ['inflated significance']
    );
  });

  it('still reports a word that recurs outside the hard match on the same line', () => {
    const text = 'Sales doubled, showcasing the demand. We plan to keep showcasing it.';
    assert.ok(check(text).some((f) => f.level === 'WORD' && f.match === 'showcasing'));
  });

  it('flags a fragment with a stray space before its stop', () => {
    assert.ok(check('Big news .').some((f) => f.pattern === 20));
  });

  it('reports a word inside a hard match once', () => {
    assert.deepEqual(
      check('Sales doubled, showcasing the demand.').map((f) => f.name),
      ['evaluative tail']
    );
    assert.deepEqual(hard('Sales doubled, showcasing the demand.'), []);
  });

  it('reads "the truth is" after a closing parenthesis', () => {
    assert.ok(
      names(hard('The road closed (it flooded.) The truth is it broke.')).includes(
        'directness opener'
      )
    );
  });

  it('flags an unowned majority and a named-sounding authority as #12', () => {
    for (const text of [
      'Many people find that a folding bike survives a commute better.',
      "It's often said that the ferry is late.",
      'Studies show the ferry is late.',
    ]) {
      assert.ok(
        check(text).some((f) => f.pattern === 12),
        text
      );
    }
  });

  it('leaves a count of people alone', () => {
    for (const text of [
      'How many people came to the meeting yesterday?',
      'It was the most people we have ever seen.',
      'Not many people came.',
      'Very many people came.',
      'Not many find it useful.',
    ]) {
      assert.deepEqual(
        check(text).filter((f) => f.pattern === 12),
        [],
        text
      );
    }
  });
});

describe('the examples in patterns.md', () => {
  for (const [bad, good, pattern] of [
    [
      'The cafe opens at six. In other words, it is the only place open before the market.',
      'The cafe opens at six, before anything else near the market.',
      44,
    ],
    [
      'The platform reopened in March, marking the end of a two-year closure.',
      'The platform reopened in March. It had been closed for two years.',
      45,
    ],
    [
      'The ferry runs twice a day. In short, the ferry runs less often in winter.',
      'The ferry runs twice a day.',
      3,
    ],
  ]) {
    it(`flags the Bad example for #${pattern} and passes the Good one`, () => {
      assert.ok(
        check(bad).some((f) => f.pattern === pattern),
        names(check(bad)).join()
      );
      assert.deepEqual(
        check(good).filter((f) => f.level !== 'LOOK'),
        []
      );
    });
  }

  it('leaves a factual rider and "in short supply" alone', () => {
    assert.deepEqual(hard('The bridge closed at noon, allowing the barge to pass.'), []);
    assert.deepEqual(
      check('Seats are in short supply, so we sold them in short order.').filter(
        (f) => f.level !== 'LOOK'
      ),
      []
    );
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

describe('interface strings', () => {
  const strings = ['Send request', 'Sending', 'No messages yet.', 'Nothing here yet.', 'Saved.'];

  it('does not take UI strings in a list for fragments', () => {
    const text = strings.map((s) => `- ${s}`).join('\n');
    assert.deepEqual(check(text), []);
  });

  it('does not take UI strings in a table for fragments', () => {
    const text = [
      '| Key | String |',
      '| --- | --- |',
      ...strings.map((s, i) => `| key${i} | ${s} |`),
    ].join('\n');
    assert.deepEqual(check(text), []);
  });

  it('flags the same strings as paragraphs, which is why they go in a list', () => {
    assert.ok(check(strings.join('\n\n')).some((f) => f.pattern === 20));
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

  it('numbers the patterns 1 to 45 with none missing', () => {
    assert.deepEqual(
      [...headings.keys()].sort((a, b) => a - b),
      Array.from({ length: 45 }, (_, i) => i + 1)
    );
  });

  it('points every numbered flag at a pattern that exists', () => {
    const sample = [
      'Honestly, it’s not just fast — it serves as a testament. Four weeks.',
      'Moreover, the data tells us. Pages 3–5! Done! She was involved in it.',
      "Let's dive in. What nobody tells you is this. I hope this helps.",
      'It drafts in your voice, strips tells, and checks drafts before you see it.',
      '',
      'It ships before you see it.',
      '',
      'It opened in May, marking a change. In other words, it moved. In short, it is new.',
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

  // A recap closer is flagged only where it opens a paragraph's last sentence (#3).
  const RECAPS = new Set([
    'in short',
    'in summary',
    'all in all',
    'ultimately',
    'at the end of the day',
    'when all is said and done',
    'in conclusion',
  ]);
  it('lists every recap closer in the vocabulary', () => {
    for (const recap of RECAPS) assert.ok(phrases.includes(recap), recap);
  });
  for (const entry of [...words, ...phrases]) {
    it(`flags "${entry}"`, () => {
      const text = RECAPS.has(entry)
        ? `It ran. ${entry[0].toUpperCase()}${entry.slice(1)}, it worked.`
        : `We saw ${entry} here.`;
      assert.ok(
        check(text).some((f) => f.level !== 'LOOK'),
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

describe('product copy', () => {
  const featureList = (text) => check(text).filter((f) => f.name === 'feature-list sentence');
  const NEW = new Set([41, 42, 43, 44, 45]);
  const fresh = (text) =>
    check(text).filter((f) => NEW.has(f.pattern) || (f.name === 'phrase' && f.pattern === null));

  for (const text of [
    'Tracks invoices across your accounts, flags the ones past due, then drafts a reminder to each client.',
    'Connect your bank, track each expense by category, and export a report for your accountant.',
    'It reads your receipts, matches them to transactions, and files them by month.',
    'Acme imports statements from every bank, matches each payment to an invoice, sends reminders for the ones past due, and exports a quarterly report for your accountant.',
    'The skill drafts short, then reads its own draft back line by line, rewrites what sounds artificial, and scores it out of 50 on directness, rhythm, trust, authenticity, and density.',
    'It reports each violation with its file, line and rule, can fix naming violations in place, and runs in CI as a single binary.',
    'It drafts the reply, it checks the facts, and it sends the email.',
  ]) {
    it(`flags a feature-list sentence: ${text}`, () => {
      assert.equal(featureList(text).length, 1);
      assert.equal(featureList(text)[0].pattern, 41);
    });
  }

  it('reports a feature-list sentence on the line where it starts', () => {
    const text = 'It ships today.\nIt drafts in a plain voice, strips tells,\nand checks drafts.';
    assert.deepEqual(
      featureList(text).map((f) => f.line),
      [2]
    );
  });

  for (const text of [
    'Acme matches each bank payment to the invoice it settles. When an invoice goes past due, it drafts a reminder for you to send.',
    'Each expense lands in a category as it clears. The quarterly report is ready for your accountant on the first of the month.',
    'Claude writes a first draft, then rereads it for AI patterns and fixes them.',
    'It can fix the naming violations in place, and it runs in CI as a single binary.',
    'It can fix the naming violations in place, and it runs in CI as a single binary.',
    'It covers emails, posts, docs, READMEs, and replies.',
    'Emails, posts, docs, READMEs, and replies all count.',
    '1. Clones the repository, installs dependencies, and runs the tests.',
    '- Clones the repository, installs dependencies, and runs the tests.',
  ]) {
    it(`leaves it alone: ${text}`, () => assert.deepEqual(fresh(text), []));
  }

  for (const [text, phrase] of [
    ["It drafts in your project's voice.", 'in your voice'],
    ['It drafts in your brand voice.', 'in your voice'],
    ['It drafts in your team’s voice.', 'in your voice'],
    ['It writes in your own words.', 'in your own words'],
    ['The reply sounds just like you.', 'sounds like you'],
  ]) {
    it(`flags the voice claim: ${text}`, () => {
      assert.ok(check(text).some((f) => f.level === 'WORD' && f.match === phrase));
    });
  }

  for (const phrase of [
    'before you see it',
    'before it reaches you',
    'before it hands anything back',
    "so you don't have to",
    'without lifting a finger',
    'in seconds',
    'with no extra work',
  ]) {
    it(`flags the rider "${phrase}" with #42`, () => {
      const flags = check(`Claude fixes the draft ${phrase}.`);
      assert.ok(flags.some((f) => f.level === 'WORD' && f.pattern === 42 && f.match === phrase));
    });
  }

  it('flags a rider in the Bad example and passes the Good one', () => {
    const bad =
      'Claude writes a first draft, then rereads it for AI patterns and fixes them before you see it.';
    assert.deepEqual(
      fresh(bad).map((f) => f.match),
      ['before you see it']
    );
  });

  it('flags a phrase repeated in two paragraphs, and the rider', () => {
    const text =
      'Claude writes a draft and fixes it before you see it.\n\nThe checker runs before you see it.';
    const flags = check(text);
    const repeated = flags.filter((f) => f.pattern === 43);
    assert.equal(repeated.length, 1);
    assert.equal(repeated[0].line, null);
    assert.equal(repeated[0].match, 'before you see it');
    assert.ok(flags.some((f) => f.level === 'WORD' && f.pattern === 42));
  });

  it('reports the longest repeated phrase once, with its count', () => {
    const text = [
      'Claude never merges into production on its own.',
      'Hooks block the push. Claude never merges into production on its own.',
      'Releases wait for you. Claude never merges into production on its own.',
    ].join('\n\n');
    const repeated = check(text).filter((f) => f.pattern === 43);
    assert.deepEqual(
      repeated.map((f) => [f.name, f.match]),
      [['repeated phrase (3 times)', 'claude never merges into production on its own']]
    );
  });

  it('ignores repeats in headings, code and quotes, and phrases of three words', () => {
    const text = [
      '## How the checker works',
      'The checker works on drafts. Run `node check.mjs on a draft` here.',
      'Avoid "how the checker works" and `node check.mjs on a draft` there.',
      'It reads drafts. Then it reads drafts again.',
    ].join('\n\n');
    assert.deepEqual(
      check(text).filter((f) => f.pattern === 43),
      []
    );
  });
});
