/**
 * Shared by the test files: a thin `describe`/`it`/`expect` layer over `node:test`
 * and `node:assert`, and the fixtures that run a hook as Claude Code would, against
 * a scratch project with its own `.claude/canon.json`.
 *
 * The `expect` layer exists so the matcher cases read as a list of examples, which
 * is what they are, rather than as a wall of `assert.deepStrictEqual` calls. It
 * covers the handful of matchers the suites use and nothing else.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it as nodeIt } from 'node:test';
import { fileURLToPath } from 'node:url';

export { afterEach, beforeEach, describe };

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HOOKS = join(ROOT, 'hooks');

/** `it(name, fn, timeout?)` and `it.each(rows)(name, fn, timeout?)`, with `%s` filled in order. */
export const it = Object.assign(
  (name, fn, timeout) => nodeIt(name, timeout ? { timeout } : {}, fn),
  {
    each: (rows) => (name, fn, timeout) => {
      for (const row of rows) {
        const args = Array.isArray(row) ? row : [row];
        let i = 0;
        const title = name.replace(/%[sdj]/g, () => JSON.stringify(args[i++]));
        nodeIt(title, timeout ? { timeout } : {}, () => fn(...args));
      }
    },
  }
);

/** Does `actual` contain every key of `expected`, recursively? */
function matches(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  return Object.keys(expected).every((key) => matches(actual[key], expected[key]));
}

export function expect(actual, message) {
  const positive = {
    toBe: (expected) => assert.strictEqual(actual, expected, message),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected, message),
    toMatchObject: (expected) =>
      assert.ok(matches(actual, expected), message ?? `${JSON.stringify(actual)} does not match`),
    toContain: (item) => assert.ok(actual.includes(item), message ?? `missing ${item}`),
    toMatch: (pattern) => assert.match(actual, pattern, message),
    toBeUndefined: () => assert.strictEqual(actual, undefined, message),
    toBeNull: () => assert.strictEqual(actual, null, message),
    toBeLessThan: (n) => assert.ok(actual < n, message ?? `${actual} is not less than ${n}`),
    toBeGreaterThanOrEqual: (n) => assert.ok(actual >= n, message ?? `${actual} < ${n}`),
    toThrow: () => assert.throws(actual, message),
  };
  const negative = {
    toContain: (item) => assert.ok(!actual.includes(item), message ?? `contains ${item}`),
    toMatch: (pattern) => assert.doesNotMatch(actual, pattern, message),
    toThrow: () => assert.doesNotThrow(actual, message),
  };
  return { ...positive, not: negative };
}

/** The `.claude/canon.json` every fixture project starts from. */
export const CONFIG = {
  version: 1,
  owner: 'Ada',
  branches: {
    integration: 'staging',
    production: 'main',
    prefixes: ['feat', 'fix', 'chore', 'refactor', 'docs'],
  },
  packageManager: 'pnpm',
  commands: { typecheck: null, lint: null, format: null, test: null },
  formatFile: null,
  urls: { preview: null, staging: null, production: null },
};

/** The domain map every fixture project starts from. */
export const DOMAINS = {
  $comment: ['Fixture map for the hook tests.'],
  'architecture.md': ['src/'],
  'data-model.md': ['supabase/migrations/'],
};

/**
 * A scratch project directory. `config` and `domains` replace the defaults; `false`
 * leaves that file out. `canonDir` creates `docs/canon/`.
 */
export function makeProject({ config = CONFIG, domains = DOMAINS, canonDir = true, dir } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'canon-project-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  if (canonDir) mkdirSync(join(root, 'docs/canon'), { recursive: true });
  if (config !== false) {
    writeFileSync(
      join(root, '.claude/canon.json'),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2)
    );
  }
  if (domains !== false) {
    writeFileSync(
      join(root, '.claude/canon-domains.json'),
      typeof domains === 'string' ? domains : JSON.stringify(domains, null, 2)
    );
  }
  return root;
}

/** Clear every bypass, so the developer's own shell cannot change a result. */
const NO_BYPASS = {
  ALLOW_FORCE_PUSH: '',
  ALLOW_PROTECTED_PUSH: '',
  ALLOW_PROTECTED_BRANCH_EDIT: '',
  ALLOW_UNDECIDED_MERGE: '',
};

/**
 * Run a hook with a stub `gh` on PATH. A string is a Bash command; an object is the
 * whole payload. `git`, when given, is stubbed too, so a hook reading the branch diff
 * sees one the test chose. `project` defaults to a fresh fixture project.
 *
 * Returns `{ status, stdout, stderr }`.
 */
export function run(hook, command, gh = 'exit 1', options = {}) {
  const { cwd, git, env = {}, hooksDir = HOOKS } = options;
  const project = options.project ?? makeProject();
  const bin = mkdtempSync(join(tmpdir(), 'canon-bin-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${gh}\n`, { mode: 0o755 });
  if (git !== undefined) writeFileSync(join(bin, 'git'), `#!/bin/sh\n${git}\n`, { mode: 0o755 });
  const payload =
    typeof command === 'string'
      ? { tool_name: 'Bash', tool_input: { command }, cwd: cwd ?? project }
      : command;
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [join(hooksDir, hook)], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CLAUDE_PROJECT_DIR: project,
      ...NO_BYPASS,
      ...env,
    },
  });
  rmSync(bin, { recursive: true, force: true });
  if (!options.project) rmSync(project, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** `run`, returning only the exit code. */
export const runHook = (hook, command, gh, cwd, git) => run(hook, command, gh, { cwd, git }).status;

/**
 * A copy of the hooks directory with one helper module replaced, for the crash
 * tests. The caller removes it.
 */
export function brokenHooks(module, source) {
  const dir = mkdtempSync(join(tmpdir(), 'canon-broken-'));
  cpSync(HOOKS, dir, { recursive: true });
  writeFileSync(join(dir, 'lib', module), source);
  return dir;
}

/** A throwaway git repository on `feature`, with `staging` and `main` beside it. */
export function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'canon-repo-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '-b', 'feature');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('branch', 'staging');
  git('branch', 'main');
  git('config', 'branch.feature.merge', 'refs/heads/feature');
  git('config', 'branch.staging.merge', 'refs/heads/staging');
  makeProject({ dir });
  return { dir, git };
}
