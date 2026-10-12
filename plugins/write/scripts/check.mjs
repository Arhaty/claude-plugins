#!/usr/bin/env node
/**
 * Mechanical checks for the `write` skill, on English text.
 *
 *   node check.mjs <file>
 *   node check.mjs < draft.md
 *
 * Prints one flag per line. Every flag is a place to look, not a verdict:
 *
 *   HARD  a Tier 1 or Tier 2 pattern, or chatbot debris. Exit 1 when any fires.
 *   WORD  a word or phrase from the vocabulary list.
 *   LOOK  a candidate fragment, curly quote, flat rhythm, punchline habit and the like.
 *
 * `#n` is the pattern's number in `skills/write/references/patterns.md`.
 *
 * Code is not prose: fenced blocks, inline code and front matter are skipped. So is
 * quoted text, in a blockquote or between double quotes (straight or curly), because the skill
 * leaves a pattern alone inside a quotation or a sentence that discusses the phrase.
 * Chatbot debris is the exception and is looked for everywhere outside code.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APOS = "['’]";

/** `[name, pattern number, regex]`. Case-insensitive unless the regex says otherwise. */
const HARD = [
  ['dash', 7, /[—]|(?<!\d\s?)–|–(?!\s?\d)| -- /g],
  [
    'not X but Y',
    1,
    new RegExp(
      `\\bnot (just|only|merely)\\b|\\brather than\\b|\\binstead of\\b|\\bisn${APOS}t about\\b|` +
        `\\bless about\\b|\\b(it|that)${APOS}s not\\b`,
      'gi'
    ),
  ],
  [
    'directness opener',
    8,
    new RegExp(
      `\\bhonestly\\b|\\bto be (honest|frank)\\b|\\blet me be (honest|clear)\\b|` +
        `\\bhere${APOS}s the thing\\b|\\blet${APOS}s be real\\b|` +
        // Only as an opener: "what the thing is" is an ordinary clause.
        `(?<=^(?:[ \\t]*(?:[-*+]|\\d+\\.|#{1,6})[ \\t]+)?|[.!?:]\\s+)(?:but |and |so )?the (thing|truth) is\\b`,
      'gi'
    ),
  ],
  [
    'staged run-up',
    6,
    new RegExp(
      `\\blet${APOS}s (dive|explore|break)\\b|\\bhere${APOS}s what you need to know\\b|` +
        `\\bwithout further ado\\b`,
      'gi'
    ),
  ],
  [
    'faux insight',
    4,
    /\bwhat nobody tells you\b|\bthe part (everyone|most people) miss|\bthe real question is\b|\bat its core\b|\bthe dirty secret\b/gi,
  ],
  [
    'chatbot residue',
    13,
    /\bi hope this helps\b|\blet me know if\b|\bwould you like me to\b|\bfeel free to\b|\bcertainly!/gi,
  ],
  [
    'sycophancy',
    14,
    new RegExp(
      `\\bgreat question\\b|\\byou${APOS}re absolutely right\\b|\\bexcellent point\\b`,
      'gi'
    ),
  ],
  [
    'closing pleasantry',
    16,
    new RegExp(
      `\\bdon${APOS}t hesitate\\b|\\bhappy to chat\\b|\\blooking forward to hearing\\b`,
      'gi'
    ),
  ],
  [
    'announcement opener',
    23,
    /\b(excited|thrilled|proud|delighted) to (announce|share|present)\b/gi,
  ],
  [
    'audience sweep',
    24,
    new RegExp(
      `\\bwhether you${APOS}re\\b|\\bfrom startups to\\b|\\bfrom concept to\\b|\\b\\w+ and \\w+ alike\\b`,
      'gi'
    ),
  ],
  [
    'mechanical transition',
    26,
    /(?<=^(?:[ \t]*(?:[-*+]|\d+\.|#{1,6})[ \t]+)?|[.!?]\s+)(Additionally|Moreover|Furthermore|In conclusion|With that in mind|That said),/g,
  ],
  [
    'read-this-way line',
    19,
    /\blet that sink in\b|\bfull stop\b|\bthis distinction matters\b|\bthe key point is\b|\bmatters more than it sounds\b|\bthe implications are\b|\bthe stakes are\b/gi,
  ],
  [
    'inflated significance',
    10,
    /\btestament to\b|\bpivotal moment\b|\bplays an? (key|vital|crucial|pivotal) role\b|\bunderscores\b|\bever-evolving\b|\bindelible\b|\bsetting the stage\b|\bpaving the way\b/gi,
  ],
  ['copula avoidance', 17, /\b(serves|stands|acts|functions) as\b|\bboasts\b/gi],
  [
    'vague role',
    22,
    /\binvolved in\b|\bcontributed to\b|\bassociated with\b|\bplayed a part in\b/gi,
  ],
  [
    'false agency',
    21,
    /\bthe data (tells|shows|says)\b|\bthe market rewards\b|\b(decision|answer|pattern) emerge[sd]?\b/gi,
  ],
];

/** Looked for on the raw line, quotes included: debris is never a quotation. */
const DEBRIS =
  /utm_source=(chatgpt|openai)|\[cite|oaicite|turn\d+search|\[Your [A-Z]|\d{4}-XX-XX|\[insert/gi;

const VOCAB = `delve delves delving leverage leveraging tapestry landscape vibrant crucial crucially
pivotal robust foster fostering garner showcase showcasing underscore underscores testament
seamless seamlessly elevate unlock unlocks navigate realm intricate myriad boasts nestled
groundbreaking game-changer game-changing cutting-edge best-in-class holistic synergy empower
empowering streamline streamlined harness embark journey resonate resonates curate curated bespoke
meticulous meticulously transformative additionally moreover furthermore bolster interplay utilize
utilizes facilitate facilitates paradigm ecosystem multifaceted paramount spearhead spearheaded
encompass encompasses beacon ever-evolving supercharge quietly genuinely`.split(/\s+/);

const PHRASES = [
  'in order to',
  'due to the fact that',
  `it's important to note`,
  `it's worth noting`,
  'a number of',
  'at the heart of',
  `in today's`,
  'in an era where',
  'the intersection of',
  'paving the way',
  'it remains to be seen',
  'move the needle',
  'double down',
  'lean into',
  'circle back',
  'low-hanging fruit',
  'next level',
  'full potential',
  'deep dive',
  'at scale',
];

const VERBISH = new RegExp(
  '\\b(is|are|was|were|be|been|am|has|have|had|do|does|did|can|could|will|would|should|may|might|must' +
    "|\\w+n't|\\w+'s|\\w+'re|\\w+'ll|\\w+'ve|\\w+'m|\\w+'d|\\w+ed|\\w+es)\\b" +
    '|\\b(go|get|make|take|see|know|think|work|need|want|run|use|build|ship|grow|let|say|feel|look' +
    '|come|give|find|keep|start|stop|try|help|sounds?|works?|ask|cut|tell|read|write|send|call|show' +
    '|put|set|pick|add|drop|check|fix|move|open|close|pay|hold|leave|bring|meet|sell|buy|lead|own' +
    '|join|plan|wait|choose|book|agree|confirm|mean|matter|fold|follow|generate|state|merge|replace' +
    '|name|count|invent|treat|revise|apply|answer|edit|draft|quote|mark|remove|reply|skip|save' +
    '|end|cover|depend|hurt|stay|win|lose)\\b' +
    '|^\\W*(i|we|he|she|they|you|it)\\b',
  'i'
);

/** Lines that are structure, not running prose: headings, lists, tables, quotes, greetings. */
const STRUCTURE =
  /^\s*(#|[-*+] |\d+\. |\||>)|^\s*(hi|hello|dear|hey|thanks|thank you|cheers|best)\b/i;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const whole = (text, suffix = '') =>
  new RegExp(`(?<![\\w-])${escape(text)}${suffix}(?![\\w-])`, 'gi');
const VOCAB_RES = VOCAB.map((word) => [word, whole(word)]);
// A phrase's last word may be inflected: "deep dives", "circled back" is not, "circle backs" is.
const PHRASE_RES = PHRASES.map((phrase) => [phrase, whole(phrase, '(?:s|es|ed|ing)?')]);

/**
 * The lines of `text` that hold prose, numbered from 1 as in the file. Fenced code
 * and front matter are dropped; inline code is blanked so a pattern inside it does
 * not fire.
 */
export function proseLines(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let fence = null;
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (close > 0) start = close + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    out.push({
      n: i + 1,
      raw: line,
      text: line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length)),
    });
  }
  return out;
}

/**
 * The prose in blocks: a paragraph, list item, heading or table row, with its
 * wrapped lines joined by a space so a pattern or a sentence that crosses a line
 * break is still one piece of text. `lineAt(i)` maps an offset back to its line.
 * Blockquote lines and text between double quotes, straight or curly, are blanked, keeping
 * offsets, because the skill leaves quoted text alone.
 */
function blocks(lines) {
  const out = [];
  let current = null;
  for (const line of lines) {
    if (!line.text.trim()) {
      current = null;
      continue;
    }
    const structure = STRUCTURE.test(line.raw);
    const standalone = current && /^\s*(#|\|)/.test(current.lines[0].raw);
    // A line straight after a blockquote line with text is a lazy continuation of the
    // quote; after an empty `>` line it is a new paragraph.
    const lazyEnds = current?.quote && /^\s*>\s*$/.test(current.lines.at(-1).raw);
    if (!current || line.n !== current.lines.at(-1).n + 1 || structure || standalone || lazyEnds) {
      current = { lines: [], starts: [], text: '', structure, quote: /^\s*>/.test(line.raw) };
      out.push(current);
    }
    if (current.text) current.text += ' ';
    current.starts.push(current.text.length);
    current.lines.push(line);
    current.text += current.quote ? ' '.repeat(line.text.length) : line.text;
  }
  for (const block of out) {
    block.text = block.text.replace(/"[^"]*"|\u201c[^\u201c\u201d]*\u201d/g, (m) =>
      ' '.repeat(m.length)
    );
    block.lineAt = (index) => {
      let i = block.starts.length - 1;
      while (i > 0 && block.starts[i] > index) i--;
      return block.lines[i].n;
    };
  }
  return out;
}

/** The sentences in `text`, each as `{ text, index }`. */
const sentencesAt = (text) =>
  [...text.matchAll(/\S[^]*?(?:[.!?](?=\s)|$)/g)].map((m) => ({
    text: m[0].trim(),
    index: m.index,
  }));

/**
 * Every flag for `text`, as `{ line, level, name, pattern, match }`. `line` is null
 * for a flag on the whole document; `pattern` is the number in patterns.md, or null.
 */
export function check(text) {
  const lines = proseLines(text);
  const flags = [];
  const flag = (line, level, name, pattern, match) =>
    flags.push({ line, level, name, pattern, match });

  for (const { n, text: line } of lines) {
    for (const m of line.matchAll(DEBRIS)) flag(n, 'HARD', 'chatbot debris', null, m[0]);
    const curly = line.match(/[\u201c\u201d\u2018\u2019]/);
    if (curly) flag(n, 'LOOK', 'curly quote', 34, curly[0]);
    if (/\d\s?\u2013\s?\d/.test(line)) flag(n, 'LOOK', 'en dash in a range', 7, '\u2013');
  }

  const all = blocks(lines);
  for (const block of all) {
    const { text: prose, lineAt } = block;
    const found = [];
    for (const [name, pattern, re] of HARD) {
      for (const m of prose.matchAll(re)) {
        const lead = m[0].length - m[0].trimStart().length;
        found.push([m.index + lead, 'HARD', name, pattern, m[0].trim()]);
      }
    }
    const seen = new Set();
    for (const [word, re] of VOCAB_RES) {
      for (const m of prose.matchAll(re)) {
        const key = `${lineAt(m.index)} ${word}`;
        if (!seen.has(key)) found.push([m.index, 'WORD', 'vocabulary', null, word]);
        seen.add(key);
      }
    }
    const low = prose.toLowerCase().replace(/\u2019/g, "'");
    for (const [phrase, re] of PHRASE_RES) {
      for (const m of low.matchAll(re)) found.push([m.index, 'WORD', 'phrase', null, phrase]);
    }
    if (!block.structure) {
      for (const s of sentencesAt(prose)) {
        const words = s.text.match(/[\w'%$-]+/g) ?? [];
        if (
          words.length > 0 &&
          words.length <= 6 &&
          /[A-Za-z]{2}/.test(s.text) &&
          /[.!?]$/.test(s.text) &&
          !VERBISH.test(s.text)
        ) {
          found.push([s.index, 'LOOK', 'possible fragment', 20, s.text.replace(/\s+/g, ' ')]);
        }
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    for (const [index, ...rest] of found) flag(lineAt(index), ...rest);
  }
  flags.sort((a, b) => a.line - b.line);

  const body = all.map((b) => b.text).join('\n');
  const bangs = (body.match(/!/g) ?? []).length;
  if (bangs > 1) flag(null, 'LOOK', `${bangs} exclamation marks (budget: 1)`, 40, null);

  const paragraphs = all.filter((b) => !b.structure).map((b) => b.text);
  const prose = paragraphs.join(' ');
  const lengths = sentencesAt(prose).map((s) => s.text.split(/\s+/).length);
  for (let j = 0; j + 4 <= lengths.length; j++) {
    const window = lengths.slice(j, j + 4);
    const mean = window.reduce((a, b) => a + b, 0) / 4;
    if (mean >= 6 && window.every((x) => Math.abs(x - mean) <= 0.3 * mean)) {
      const name = `flat rhythm: sentences ${j + 1}-${j + 4} are ${window.join(', ')} words`;
      flag(null, 'LOOK', name, null, null);
      break;
    }
  }

  if (prose.split(/\s+/).length > 60 && !/\b\w+['\u2019](t|s|re|ll|ve|m|d)\b/.test(prose)) {
    flag(null, 'LOOK', 'no contractions anywhere (fine if the guide is formal)', null, null);
  }

  const punchlines = paragraphs.filter((p) => {
    const ss = sentencesAt(p);
    return ss.length >= 2 && ss.at(-1).text.split(/\s+/).length <= 7;
  }).length;
  if (punchlines > 1) {
    flag(null, 'LOOK', `${punchlines} paragraphs end on a short line (budget: 1)`, 38, null);
  }

  return flags;
}

/** One flag as the line the CLI prints. */
export function format({ line, level, name, pattern, match }) {
  const where = line === null ? 'DOC' : `L${line}`;
  const number = pattern === null ? '' : ` #${pattern}`;
  const what = match === null ? '' : `: '${match}'`;
  return `${where.padEnd(5)} ${level.padEnd(4)}${number} ${name}${what}`;
}

function main(argv) {
  if (argv.length > 1 || argv[0]?.startsWith('-')) {
    process.stderr.write('usage: check.mjs [file]   (or pipe the text on stdin)\n');
    return 2;
  }
  let text;
  try {
    text = readFileSync(argv[0] ?? 0, 'utf8');
  } catch (error) {
    process.stderr.write(`check: cannot read ${argv[0] ?? 'stdin'}: ${error.message}\n`);
    return 2;
  }
  const flags = check(text);
  process.stdout.write(flags.length ? `${flags.map(format).join('\n')}\n` : 'No flags.\n');
  return flags.some((f) => f.level === 'HARD') ? 1 : 0;
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  process.exitCode = main(process.argv.slice(2));
}
