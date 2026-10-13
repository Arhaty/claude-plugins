/**
 * The setup scaffolder: valid answers write the config, a filled preset and the
 * samples file; invalid answers are refused; nothing that exists is overwritten
 * without an explicit allow; nothing is written through a symlink out of the
 * project.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONFIG_PATH, PRESETS, apply, fill, plan, render, validate } from '../scripts/scaffold.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCAFFOLD = join(ROOT, 'scripts', 'scaffold.mjs');

const CONFIG = {
  version: 1,
  language: 'English',
  guide: 'docs/tone-of-voice.md',
  samples: 'docs/writing-samples.md',
};
const config = (overrides = {}) => ({ ...CONFIG, ...overrides });
const read = (root, path) => readFileSync(join(root, path), 'utf8');

describe('validate', () => {
  it('accepts a full config, a URL guide and nulls', () => {
    assert.deepEqual(validate(config()), []);
    assert.deepEqual(validate(config({ guide: 'https://example.com/style', samples: null })), []);
    assert.deepEqual(validate(config({ guide: null, samples: null })), []);
    assert.deepEqual(validate(config({ $schema: 'x', guide: './STYLE.md' })), []);
  });

  const refused = [
    ['not an object', []],
    ['an unknown key', config({ tone: 'casual' })],
    ['a missing guide', { version: 1, language: 'English', samples: null }],
    ['a missing samples', { version: 1, language: 'English', guide: null }],
    ['the wrong version', config({ version: 2 })],
    ['an empty language', config({ language: '' })],
    ['an absolute guide', config({ guide: '/etc/passwd' })],
    ['a home guide', config({ guide: '~/style.md' })],
    ['a guide outside the project', config({ guide: 'docs/../../style.md' })],
    ['a plain http guide', config({ guide: 'http://example.com/style' })],
    ['a file: guide', config({ guide: 'file:///etc/passwd' })],
    ['a backslash path', config({ samples: 'docs\\samples.md' })],
    ['a samples URL', config({ samples: 'https://example.com/samples' })],
    ['the config as the guide', config({ guide: CONFIG_PATH })],
    ['the config spelled another way', config({ guide: '././.claude//write.json' })],
    ['the config in another case', config({ guide: '.claude/Write.json' })],
    ['a newline in a path', config({ samples: 'docs/samples\n.md' })],
    ['a tab in a path', config({ guide: 'docs/\tguide.md' })],
    ['a directory', config({ guide: 'docs/' })],
    ['the project root', config({ samples: './' })],
    ['a path ending in "."', config({ guide: 'docs/.' })],
    ['a "." part in the middle', config({ guide: 'docs/./a.md' })],
    ['an empty part', config({ guide: 'docs//a.md' })],
    ['a directory holding the config', config({ guide: '.claude' })],
    ['whitespace only', config({ samples: '   ' })],
  ];
  for (const [label, value] of refused) {
    it(`refuses ${label}`, () => assert.notDeepEqual(validate(value), []));
  }
});

describe('templates', () => {
  it('has the three presets', () => {
    assert.deepEqual(PRESETS, ['casual', 'formal', 'plain']);
  });

  for (const preset of PRESETS) {
    it(`fills ${preset} with no placeholder left`, () => {
      const files = render(config({ language: 'Italian' }), { preset });
      const guide = files.find((f) => f.path === CONFIG.guide).content;
      assert.match(guide, /Write in Italian/);
      assert.doesNotMatch(guide, /\{\{\s*\w+\s*\}\}/);
    });
  }

  it('throws on an unknown placeholder', () => {
    assert.throws(() => fill('{{language}} {{tone}}', { language: 'English' }), /\{\{tone\}\}/);
  });

  it('throws on an unknown preset or a preset with nowhere to go', () => {
    assert.throws(() => render(config(), { preset: 'shouty' }), /unknown preset/);
    assert.throws(() => render(config({ guide: null }), { preset: 'plain' }), /project path/);
    assert.throws(
      () => render(config({ guide: 'https://example.com/g' }), { preset: 'plain' }),
      /project path/
    );
  });

  it('agrees with validate on every path rule the schema can express', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'templates/write.schema.json'), 'utf8'));
    const re = new RegExp(schema.properties.samples.oneOf[1].pattern, 'u');
    const paths = [
      'docs/a.md',
      './STYLE.md',
      'a',
      '.github/style.md',
      'docs/a..md',
      '..md',
      '',
      '   ',
      '/a',
      '~/a',
      'file:a',
      'https://x/y',
      'docs\\a',
      'a\nb',
      'a\tb',
      'docs/',
      'docs/.',
      'docs/./a',
      'a//b',
      './',
      '.',
      '..',
      '../a',
      'a/../b',
      '.claude/write.json',
      './.claude/Write.JSON',
      '.claude',
      '.Claude',
      '.claude/other.json',
      '\u2028a.md',
      'a\u2029b.md',
      'a\u0085b.md',
      '\u00a0',
      'café.md',
    ];
    for (const path of paths) {
      const valid = validate(config({ guide: null, samples: path })).length === 0;
      assert.equal(re.test(path), valid, JSON.stringify(path));
    }
  });

  it('points the config at the published schema', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'templates/write.schema.json'), 'utf8'));
    const written = JSON.parse(render(config())[0].content);
    assert.equal(written.$schema, schema.$id);
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ['$schema', ...Object.keys(CONFIG)].sort()
    );
  });
});

describe('scaffold', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'write-scaffold-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes the config, the preset guide and the samples file into an empty project', () => {
    const result = apply(root, config(), { preset: 'plain' });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(read(root, CONFIG_PATH)).guide, CONFIG.guide);
    assert.match(read(root, CONFIG.guide), /^# Tone of voice/);
    assert.match(read(root, CONFIG.samples), /^# Writing samples/);
  });

  it('writes only the config without a preset or samples', () => {
    apply(root, config({ guide: 'https://example.com/style', samples: null }));
    assert.deepEqual(readdirSync(join(root)), ['.claude']);
  });

  it('reports same on a second run and writes nothing new', () => {
    apply(root, config(), { preset: 'formal' });
    const steps = plan(root, config(), { preset: 'formal' });
    assert.deepEqual(
      steps.map((s) => s.action),
      ['same', 'same', 'keep']
    );
  });

  it('refuses to replace an existing guide without an allow, and writes nothing at all', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, CONFIG.guide), 'Our own guide.\n');
    const result = apply(root, config(), { preset: 'plain' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.refused, [CONFIG.guide]);
    assert.equal(read(root, CONFIG.guide), 'Our own guide.\n');
    assert.equal(existsSync(join(root, CONFIG_PATH)), false);
    assert.equal(existsSync(join(root, CONFIG.samples)), false);
  });

  it('replaces an existing guide when it is allowed by name', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, CONFIG.guide), 'Our own guide.\n');
    const result = apply(root, config(), { preset: 'plain', allow: [CONFIG.guide] });
    assert.equal(result.ok, true);
    assert.match(read(root, CONFIG.guide), /^# Tone of voice/);
  });

  it('leaves an existing guide alone when no preset is chosen', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, CONFIG.guide), 'Our own guide.\n');
    assert.equal(apply(root, config()).ok, true);
    assert.equal(read(root, CONFIG.guide), 'Our own guide.\n');
  });

  it('keeps an existing samples file, even with an allow', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, CONFIG.samples), '## Email\n\nSent text.\n');
    const result = apply(root, config(), { allow: [CONFIG.samples] });
    assert.equal(result.ok, true);
    assert.equal(read(root, CONFIG.samples), '## Email\n\nSent text.\n');
  });

  it('writes the approved conflicts and leaves the skipped ones', () => {
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, CONFIG.guide), 'Our own guide.\n');
    writeFileSync(join(root, CONFIG_PATH), '{}\n');
    const result = apply(root, config(), {
      preset: 'plain',
      allow: [CONFIG_PATH],
      skip: [CONFIG.guide],
    });
    assert.equal(result.ok, true);
    assert.equal(read(root, CONFIG.guide), 'Our own guide.\n');
    assert.equal(JSON.parse(read(root, CONFIG_PATH)).guide, CONFIG.guide);
    assert.equal(result.steps.find((s) => s.path === CONFIG.guide).action, 'skipped');
  });

  it('matches --allow and --skip spelled as in the answers', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, CONFIG.guide), 'Ours.\n');
    const answers = config({ guide: './docs/tone-of-voice.md' });
    assert.equal(
      apply(root, answers, { preset: 'plain', skip: ['./docs/tone-of-voice.md'] }).ok,
      true
    );
    assert.equal(read(root, CONFIG.guide), 'Ours.\n');
    assert.equal(
      apply(root, answers, { preset: 'plain', allow: ['./docs/tone-of-voice.md'] }).ok,
      true
    );
    assert.match(read(root, CONFIG.guide), /^# Tone of voice/);
  });

  it('never writes a skipped path, even once it is no longer a conflict', () => {
    const result = apply(root, config({ samples: null }), {
      preset: 'plain',
      skip: [CONFIG.guide],
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(root, CONFIG.guide)), false);
  });

  const collisions = [
    ['guide and samples the same file', { samples: CONFIG.guide }],
    ['the same file spelled two ways', { guide: './docs/a.md', samples: 'docs/a.md' }],
    ['the same file in two cases', { guide: 'docs/A.md', samples: 'docs/a.md' }],
    ['samples inside the guide', { guide: 'docs/a.md', samples: 'docs/a.md/s.md' }],
    ['the guide inside samples', { guide: 'docs/S.md/g.md', samples: 'docs/s.md' }],
    ['samples inside the config', { samples: '.claude/write.json/s.md' }],
    ['the guide inside the config, in another case', { guide: '.claude/Write.json/g.md' }],
  ];
  for (const [label, overrides] of collisions) {
    it(`refuses, writing nothing, ${label}`, () => {
      assert.throws(() => apply(root, config(overrides), { preset: 'plain' }), /same file|inside/);
      assert.deepEqual(readdirSync(root), []);
    });
  }

  it('refuses two paths that are one file through a link inside the project', () => {
    mkdirSync(join(root, '.claude'));
    symlinkSync('.claude', join(root, 'cfg'));
    assert.throws(
      () => apply(root, config({ guide: 'cfg/write.json', samples: null }), { preset: 'plain' }),
      /same file/
    );
    assert.deepEqual(readdirSync(join(root, '.claude')), []);
  });

  it('refuses a guide that links to the config, so a skipped config stays skipped', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, CONFIG_PATH), '{"old":true}\n');
    symlinkSync('.claude/write.json', join(root, 'g.md'));
    assert.throws(
      () =>
        apply(root, config({ guide: 'g.md', samples: null }), {
          preset: 'plain',
          allow: ['g.md'],
          skip: [CONFIG_PATH],
        }),
      /same file/
    );
    assert.equal(read(root, CONFIG_PATH), '{"old":true}\n');
  });

  it('refuses two names that differ only in Unicode form', () => {
    const nfc = 'café.md';
    const nfd = 'cafe\u0301.md';
    assert.throws(
      () => plan(root, config({ guide: nfc, samples: nfd }), { preset: 'plain' }),
      /same file/
    );
  });

  it('writes through a link inside the project to the file it names', () => {
    mkdirSync(join(root, 'handbook'));
    writeFileSync(join(root, 'handbook/voice.md'), 'old\n');
    symlinkSync('handbook/voice.md', join(root, 'VOICE.md'));
    const result = apply(root, config({ guide: 'VOICE.md', samples: null }), {
      preset: 'plain',
      allow: ['VOICE.md'],
    });
    assert.equal(result.ok, true);
    assert.equal(lstatSync(join(root, 'VOICE.md')).isSymbolicLink(), true);
    assert.match(read(root, 'handbook/voice.md'), /^# Tone of voice/);
  });

  it(
    'leaves the project as it was when a write fails partway',
    { skip: process.getuid?.() === 0 && 'root ignores directory permissions' },
    () => {
      mkdirSync(join(root, 'docs'));
      chmodSync(join(root, 'docs'), 0o555);
      try {
        assert.throws(() => apply(root, config(), { preset: 'plain' }), /EACCES/);
        assert.deepEqual(readdirSync(root).sort(), ['docs']);
        assert.deepEqual(readdirSync(join(root, 'docs')), []);
      } finally {
        chmodSync(join(root, 'docs'), 0o755);
      }
    }
  );

  it('reports a directory where the file goes as blocked, writing nothing', () => {
    mkdirSync(join(root, 'docs/tone-of-voice.md'), { recursive: true });
    const result = apply(root, config(), { preset: 'plain' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.blocked, ['docs/tone-of-voice.md is a directory']);
    assert.equal(existsSync(join(root, CONFIG_PATH)), false);
  });

  it('reports a file where a directory must be as blocked, writing nothing', () => {
    writeFileSync(join(root, 'docs'), 'a file\n');
    const result = apply(root, config(), { preset: 'plain' });
    assert.deepEqual(result.blocked, ['docs is a file']);
    assert.equal(existsSync(join(root, CONFIG_PATH)), false);
  });

  it('reports a link to a file outside the project as a symlink, not as blocked', () => {
    const outside = mkdtempSync(join(tmpdir(), 'write-outside-'));
    try {
      writeFileSync(join(outside, 'f'), 'x\n');
      symlinkSync(join(outside, 'f'), join(root, 'docs'));
      const result = apply(root, config(), { preset: 'plain' });
      assert.deepEqual(result.symlinks, ['docs']);
      assert.deepEqual(result.blocked, []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a conflict that is both allowed and skipped', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, CONFIG_PATH), '{}\n');
    const result = apply(root, config(), { allow: [CONFIG_PATH], skip: [CONFIG_PATH] });
    assert.deepEqual(result.both, [CONFIG_PATH]);
    assert.deepEqual(result.refused, []);
    assert.equal(read(root, CONFIG_PATH), '{}\n');
  });

  it('plans and writes a guide at its normalized path', () => {
    const steps = plan(root, config({ guide: './docs/guide.md' }), { preset: 'plain' });
    assert.equal(steps[1].path, 'docs/guide.md');
  });

  it('refuses to replace an existing config without an allow', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, CONFIG_PATH), '{}\n');
    assert.deepEqual(apply(root, config()).refused, [CONFIG_PATH]);
    assert.equal(read(root, CONFIG_PATH), '{}\n');
  });

  it('refuses to write through a symlink that leaves the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'write-outside-'));
    try {
      symlinkSync(outside, join(root, 'docs'));
      const result = apply(root, config(), { preset: 'plain' });
      assert.equal(result.ok, false);
      assert.deepEqual(result.symlinks, ['docs']);
      assert.deepEqual(readdirSync(outside), []);
      assert.equal(existsSync(join(root, CONFIG_PATH)), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a dangling symlink', () => {
    symlinkSync(join(root, 'nowhere'), join(root, '.claude'));
    assert.deepEqual(apply(root, config()).symlinks, ['.claude']);
  });

  it('writes through a symlink that stays inside the project', () => {
    mkdirSync(join(root, 'handbook'));
    symlinkSync(join(root, 'handbook'), join(root, 'docs'));
    assert.equal(apply(root, config(), { preset: 'casual' }).ok, true);
    assert.match(read(root, 'handbook/tone-of-voice.md'), /Preset: casual/);
  });
});

describe('command line', () => {
  let root;
  let answers;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'write-cli-'));
    answers = join(mkdtempSync(join(tmpdir(), 'write-answers-')), 'answers.json');
    writeFileSync(answers, JSON.stringify(CONFIG));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (...args) => spawnSync(process.execPath, [SCAFFOLD, ...args], { encoding: 'utf8' });

  it('plans, then applies', () => {
    const planned = run('plan', '--root', root, '--answers', answers, '--preset', 'plain');
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /^create +\.claude\/write\.json$/m);
    assert.match(planned.stdout, /^create +docs\/tone-of-voice\.md$/m);
    assert.equal(existsSync(join(root, CONFIG_PATH)), false);

    const applied = run('apply', '--root', root, '--answers', answers, '--preset', 'plain');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /^created +docs\/writing-samples\.md$/m);
  });

  it('exits 1 and names the conflict', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, CONFIG.guide), 'Ours.\n');
    const result = run('apply', '--root', root, '--answers', answers, '--preset', 'plain');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/tone-of-voice\.md/);
  });

  it('applies with --skip and reports the skipped file', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, CONFIG.guide), 'Ours.\n');
    const result = run(
      'apply',
      '--root',
      root,
      '--answers',
      answers,
      '--preset',
      'plain',
      '--skip',
      CONFIG.guide
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^skipped +docs\/tone-of-voice\.md$/m);
    assert.equal(read(root, CONFIG.guide), 'Ours.\n');
  });

  it('says so when a conflict is passed to both --allow and --skip', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, CONFIG_PATH), '{}\n');
    const result = run(
      'apply',
      '--root',
      root,
      '--answers',
      answers,
      '--allow',
      CONFIG_PATH,
      '--skip',
      CONFIG_PATH
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /both --allow and --skip/);
  });

  it('exits 1 and names what is in the way', () => {
    writeFileSync(join(root, 'docs'), 'a file\n');
    const result = run('apply', '--root', root, '--answers', answers, '--preset', 'plain');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /in the way[\s\S]*docs is a file/);
  });

  it('exits 2 when two paths collide', () => {
    writeFileSync(answers, JSON.stringify({ ...CONFIG, samples: '.claude/write.json/s.md' }));
    const result = run('apply', '--root', root, '--answers', answers);
    assert.equal(result.status, 2);
    assert.deepEqual(readdirSync(root), []);
  });

  it('exits 2 on invalid answers and names every problem', () => {
    writeFileSync(answers, JSON.stringify({ ...CONFIG, guide: '/etc/x', extra: 1 }));
    const result = run('plan', '--root', root, '--answers', answers);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown key extra/);
    assert.match(result.stderr, /guide must be relative/);
  });

  it('exits 2 on a bad mode, a missing value or an unknown preset', () => {
    assert.equal(run('write', '--root', root, '--answers', answers).status, 2);
    assert.equal(run('plan', '--root', root, '--answers').status, 2);
    assert.equal(run('plan', '--root', root, '--answers', answers, '--preset', 'shouty').status, 2);
  });
});
