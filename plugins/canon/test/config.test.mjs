import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commandDigest,
  isTrusted,
  loadConfig,
  trust,
  trustFile,
  trustKey,
  validate,
} from '../hooks/lib/config.mjs';
import { CONFIG, describe, expect, it, makeProject, scratchRepo } from './helpers.mjs';

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
    ['an unknown top-level key', (c) => ({ ...c, formatfile: null }), /`formatfile` is not/],
    [
      'an unknown branches key',
      (c) => ({ ...c, branches: { ...c.branches, release: 'x' } }),
      /`branches\.release` is not/,
    ],
    [
      'an unknown commands key',
      (c) => ({ ...c, commands: { ...c.commands, build: 'make' } }),
      /`commands\.build` is not/,
    ],
    [
      'an unknown urls key',
      (c) => ({ ...c, urls: { ...c.urls, docs: null } }),
      /`urls\.docs` is not/,
    ],
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

describe('the formatter trust store', () => {
  it('trusts only the exact command, for the exact root, from outside the repository', () => {
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const project = makeProject();
      const other = makeProject();
      const argv = ['pnpm', 'exec', 'prettier', '--write'];
      expect(isTrusted(project, argv)).toBe(false);
      trust(project, argv);
      expect(trustFile().startsWith(home)).toBe(true);
      expect(statSync(trustFile()).mode & 0o777).toBe(0o600);
      expect(isTrusted(project, argv)).toBe(true);
      expect(isTrusted(project, [...argv, '--ignore-unknown'])).toBe(false);
      expect(isTrusted(other, argv)).toBe(false);
      const stored = JSON.parse(readFileSync(trustFile(), 'utf8'));
      expect(Object.values(stored)[0]).toEqual({ sha256: commandDigest(argv), formatFile: argv });
      writeFileSync(trustFile(), '[');
      expect(isTrusted(project, argv)).toBe(false);
      rmSync(project, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    } finally {
      process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('shares one approval across worktrees of a clone, and not with another clone', () => {
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const saved = process.env.HOME;
    process.env.HOME = home;
    const { dir, git } = scratchRepo();
    const tree = join(tmpdir(), `canon-wt-${process.pid}-${Date.now()}`);
    const clone = mkdtempSync(join(tmpdir(), 'canon-clone-'));
    try {
      git('worktree', 'add', '-q', '-b', 'feat/x', tree, 'staging');
      const cloned = spawnSync('git', ['clone', '-q', dir, clone], { encoding: 'utf8' });
      expect(cloned.status, cloned.stderr).toBe(0);
      const argv = ['pnpm', 'exec', 'prettier', '--write'];

      expect(trustKey(tree)).toBe(trustKey(dir));
      expect(trustKey(clone) === trustKey(dir)).toBe(false);

      trust(tree, argv);
      expect(isTrusted(dir, argv)).toBe(true);
      expect(isTrusted(tree, argv)).toBe(true);
      expect(isTrusted(clone, argv)).toBe(false);
    } finally {
      process.env.HOME = saved;
      git('worktree', 'remove', '--force', tree);
      for (const path of [home, dir, clone]) rmSync(path, { recursive: true, force: true });
    }
  });
});
