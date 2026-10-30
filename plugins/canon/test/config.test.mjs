import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commandDigest,
  isKeyCommandTrusted,
  isTrusted,
  loadConfig,
  trust,
  trustKeyCommand,
  trustFile,
  trustKey,
  validate,
} from '../hooks/lib/config.mjs';
import {
  CONFIG,
  TRACKER,
  describe,
  expect,
  fakeHome,
  it,
  makeProject,
  scratchRepo,
} from './helpers.mjs';

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

  it('takes deleteAfterMerge either way, and leaves it out by default', () => {
    for (const deleteAfterMerge of [true, false]) {
      const config = valid();
      config.branches.deleteAfterMerge = deleteAfterMerge;
      expect(validate(config)).toEqual([]);
    }
    expect('deleteAfterMerge' in valid().branches).toBe(false);
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
      'a deleteAfterMerge that is not a boolean',
      (c) => ({ ...c, branches: { ...c.branches, deleteAfterMerge: 'no' } }),
      /deleteAfterMerge/,
    ],
    [
      'branches that is not an object',
      (c) => ({ ...c, branches: 'main' }),
      /branches\.integration/,
    ],
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

describe('validate the tracker block', () => {
  const withTracker = (change = (t) => t) => ({
    ...valid(),
    tracker: change(structuredClone(TRACKER)),
  });

  it('accepts a config without one, and a full one', () => {
    expect('tracker' in valid()).toBe(false);
    expect(validate(withTracker())).toEqual([]);
    expect(
      validate(
        withTracker((t) => ({ ...t, labelPrefix: 'area-', apiKeyCommand: ['op', 'read', 'x'] }))
      )
    ).toEqual([]);
    expect(validate(withTracker((t) => ({ ...t, apiKeyCommand: null })))).toEqual([]);
  });

  it.each([
    ['a non-object', () => 'linear', /`tracker` must be an object/],
    ['an unknown provider', (t) => ({ ...t, provider: 'jira' }), /tracker\.provider/],
    ['no provider', ({ provider, ...t }) => t, /tracker\.provider/],
    ['a lowercase team', (t) => ({ ...t, team: 'abc' }), /tracker\.team/],
    ['no team', ({ team, ...t }) => t, /tracker\.team/],
    ['no statuses', ({ statuses, ...t }) => t, /tracker\.statuses/],
    [
      'a missing role',
      (t) => ({ ...t, statuses: { ...t.statuses, blocked: undefined } }),
      /tracker\.statuses\.blocked/,
    ],
    [
      'an empty status name',
      (t) => ({ ...t, statuses: { ...t.statuses, spec: ' ' } }),
      /tracker\.statuses\.spec/,
    ],
    [
      'one status for two roles',
      (t) => ({ ...t, statuses: { ...t.statuses, blocked: 'In Progress' } }),
      /repeated: In Progress/,
    ],
    [
      'an unknown role',
      (t) => ({ ...t, statuses: { ...t.statuses, review: 'In Review' } }),
      /tracker\.statuses\.review` is not a known key/,
    ],
    ['an unknown key', (t) => ({ ...t, apikey: 'x' }), /tracker\.apikey` is not a known key/],
    ['an uppercase label prefix', (t) => ({ ...t, labelPrefix: 'Domain-' }), /labelPrefix/],
    ['a string key command', (t) => ({ ...t, apiKeyCommand: 'op read x' }), /apiKeyCommand/],
    ['an empty key command', (t) => ({ ...t, apiKeyCommand: [] }), /apiKeyCommand/],
  ])('rejects %s', (_, change, pattern) => {
    const errors = validate(withTracker(change));
    expect(
      errors.some((error) => pattern.test(error)),
      errors.join('\n')
    ).toBe(true);
  });
});

describe('validate the ci block', () => {
  const withCi = (ci) => ({ ...valid(), ci });

  it('accepts a config without one, and one with or without a base input', () => {
    expect('ci' in valid()).toBe(false);
    expect(validate(valid())).toEqual([]);
    expect(validate(withCi({ workflow: 'ci.yml', baseInput: 'base' }))).toEqual([]);
    expect(validate(withCi({ workflow: 'checks.yaml', baseInput: null }))).toEqual([]);
  });

  it.each([
    ['a non-object', 'ci.yml', /`ci` must be an object/],
    ['null', null, /`ci` must be an object/],
    ['no workflow', { baseInput: null }, /ci\.workflow/],
    ['a workflow path', { workflow: '.github/workflows/ci.yml', baseInput: null }, /ci\.workflow/],
    ['a workflow with no extension', { workflow: 'ci', baseInput: null }, /ci\.workflow/],
    ['a workflow id', { workflow: 1234, baseInput: null }, /ci\.workflow/],
    ['no base input key', { workflow: 'ci.yml' }, /ci\.baseInput/],
    ['an empty base input', { workflow: 'ci.yml', baseInput: '' }, /ci\.baseInput/],
    ['a base input with a bracket', { workflow: 'ci.yml', baseInput: 'a]' }, /ci\.baseInput/],
    [
      'an unknown key',
      { workflow: 'ci.yml', baseInput: null, ref: 'staging' },
      /`ci\.ref` is not a known key/,
    ],
  ])('rejects %s', (_, ci, pattern) => {
    const errors = validate(withCi(ci));
    expect(
      errors.some((error) => pattern.test(error)),
      errors.join('\n')
    ).toBe(true);
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

describe('the trust store', () => {
  it('trusts only the exact command, for the exact root, from outside the repository', () => {
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const restore = fakeHome(home);
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
      restore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the formatter and the key command apart, and reads an older entry', () => {
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const restore = fakeHome(home);
    const project = makeProject();
    try {
      const format = ['pnpm', 'exec', 'prettier', '--write'];
      const key = ['op', 'read', 'op://Vault/Item/field'];

      // The shape every approval had before the key command existed.
      mkdirSync(join(home, '.claude/canon'), { recursive: true });
      writeFileSync(
        trustFile(),
        JSON.stringify({
          [trustKey(project)]: { sha256: commandDigest(format), formatFile: format },
        })
      );
      expect(isTrusted(project, format)).toBe(true);
      expect(isKeyCommandTrusted(project, format)).toBe(false);

      trustKeyCommand(project, key);
      expect(isKeyCommandTrusted(project, key)).toBe(true);
      expect(isKeyCommandTrusted(project, [...key, '--changed'])).toBe(false);
      // Approving one neither approves the same argv as the other nor drops it.
      expect(isTrusted(project, key)).toBe(false);
      expect(isTrusted(project, format)).toBe(true);

      trust(project, ['prettier', '--write']);
      expect(isKeyCommandTrusted(project, key)).toBe(true);
      expect(isTrusted(project, format)).toBe(false);
    } finally {
      restore();
      rmSync(project, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('shares one approval across worktrees of a clone, and not with another clone', () => {
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const restore = fakeHome(home);
    const { dir, git } = scratchRepo();
    const trees = [1, 2].map((n) => join(tmpdir(), `canon-wt${n}-${process.pid}-${Date.now()}`));
    const clones = [1, 2].map(() => mkdtempSync(join(tmpdir(), 'canon-clone-')));
    try {
      git('worktree', 'add', '-q', '-b', 'feat/a', trees[0], 'staging');
      git('worktree', 'add', '-q', '-b', 'feat/b', trees[1], 'staging');
      for (const clone of clones) {
        const cloned = spawnSync('git', ['clone', '-q', dir, clone], { encoding: 'utf8' });
        expect(cloned.status, cloned.stderr).toBe(0);
      }
      const argv = ['pnpm', 'exec', 'prettier', '--write'];

      expect(trustKey(trees[0])).toBe(trustKey(dir));
      expect(trustKey(trees[1])).toBe(trustKey(dir));
      expect(trustKey(clones[0]) === trustKey(clones[1])).toBe(false);

      trust(trees[0], argv);
      expect(isTrusted(trees[1], argv)).toBe(true);
      expect(isTrusted(dir, argv)).toBe(true);
      expect(isTrusted(clones[0], argv)).toBe(false);

      trust(clones[0], argv);
      expect(isTrusted(clones[0], argv)).toBe(true);
      expect(isTrusted(clones[1], argv)).toBe(false);
    } finally {
      restore();
      for (const tree of trees) git('worktree', 'remove', '--force', tree);
      for (const path of [home, dir, ...clones]) rmSync(path, { recursive: true, force: true });
    }
  });
});
