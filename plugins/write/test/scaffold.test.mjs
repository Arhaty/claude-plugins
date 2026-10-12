/**
 * The setup scaffolder: valid answers write the config, a filled preset and the
 * samples file; invalid answers are refused; nothing that exists is overwritten
 * without an explicit allow; nothing is written through a symlink out of the
 * project.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
    ['guide and samples the same', config({ samples: CONFIG.guide })],
    ['the config as the guide', config({ guide: CONFIG_PATH })],
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
