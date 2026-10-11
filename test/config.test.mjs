import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { enabledInProject, loadConfig, validate } from '../hooks/lib/config.mjs';
import { CONFIG, describe, expect, it, makeProject } from './helpers.mjs';

const valid = () => structuredClone(CONFIG);

describe('validate', () => {
  it('accepts the fixture config and a fully filled one', () => {
    expect(validate(valid())).toEqual([]);
    const full = valid();
    full.commands = {
      typecheck: 'pnpm typecheck',
      lint: 'pnpm lint',
      format: 'pnpm format:check',
      test: 'pnpm test',
    };
    full.formatFile = ['pnpm', 'exec', 'prettier', '--write'];
    full.urls = {
      preview: 'https://{branch}.example.com',
      staging: 'https://s.example.com',
      production: 'https://example.com',
    };
    expect(validate(full)).toEqual([]);
  });

  it.each([
    ['a non-object', () => [], /JSON object/],
    ['a wrong version', (c) => ({ ...c, version: 2 }), /version/],
    ['an empty owner', (c) => ({ ...c, owner: ' ' }), /owner/],
    [
      'a missing production branch',
      (c) => ({ ...c, branches: { ...c.branches, production: undefined } }),
      /production/,
    ],
    [
      'one branch for both',
      (c) => ({ ...c, branches: { ...c.branches, production: 'staging' } }),
      /must differ/,
    ],
    ['no prefixes', (c) => ({ ...c, branches: { ...c.branches, prefixes: [] } }), /prefixes/],
    [
      'an uppercase prefix',
      (c) => ({ ...c, branches: { ...c.branches, prefixes: ['Feat'] } }),
      /prefixes/,
    ],
    [
      'a missing command key',
      (c) => ({ ...c, commands: { lint: null, format: null, test: null } }),
      /typecheck/,
    ],
    ['formatFile as a string', (c) => ({ ...c, formatFile: 'prettier --write' }), /formatFile/],
    ['an empty formatFile', (c) => ({ ...c, formatFile: [] }), /formatFile/],
    [
      'a preview URL with no {branch}',
      (c) => ({ ...c, urls: { ...c.urls, preview: 'https://x' } }),
      /\{branch\}/,
    ],
  ])('rejects %s', (_, change, message) => {
    const errors = validate(change(valid()));
    expect(errors.join('\n')).toMatch(message);
  });
});

describe('loadConfig', () => {
  it('tells absent, missing, invalid and ok apart', () => {
    const absent = makeProject({ config: false, domains: false, canonDir: false });
    expect(loadConfig(absent).status).toBe('absent');
    mkdirSync(join(absent, 'docs/canon'), { recursive: true });
    expect(loadConfig(absent).status).toBe('missing');
    writeFileSync(join(absent, '.claude/canon.json'), '{');
    expect(loadConfig(absent).status).toBe('invalid');
    writeFileSync(join(absent, '.claude/canon.json'), JSON.stringify(CONFIG));
    expect(loadConfig(absent)).toEqual({ status: 'ok', config: CONFIG });
    rmSync(absent, { recursive: true, force: true });
  });
});

describe('enabledInProject', () => {
  it('reads canon@<marketplace> from the project settings only', () => {
    const project = makeProject();
    const settings = (value) =>
      writeFileSync(join(project, '.claude/settings.json'), JSON.stringify(value));
    expect(enabledInProject(project)).toBe(false);
    settings({ enabledPlugins: { 'canon@canon': true } });
    expect(enabledInProject(project)).toBe(true);
    settings({ enabledPlugins: { 'canon@arhaty-fork': true } });
    expect(enabledInProject(project)).toBe(true);
    settings({ enabledPlugins: { 'canon@canon': false, 'other@canon': true } });
    expect(enabledInProject(project)).toBe(false);
    settings('not an object');
    expect(enabledInProject(project)).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });
});
