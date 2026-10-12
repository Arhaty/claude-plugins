#!/usr/bin/env node
/**
 * Writes a project's `write` files, for `/write:setup`.
 *
 *   node scaffold.mjs plan  --root <dir> --answers <file> [--preset <name>] [--json]
 *   node scaffold.mjs apply --root <dir> --answers <file> [--preset <name>]
 *                          [--allow <path>]... [--skip <path>]...
 *
 * `--answers` is a JSON file holding the `.claude/write.json` to write:
 *
 *   { "version": 1, "language": "English", "guide": "docs/tone-of-voice.md", "samples": null }
 *
 * `guide` is a path relative to the project root, an `https://` URL, or null.
 * `samples` is a path or null. `--preset` (plain, formal or casual) writes that
 * preset, with `{{language}}` filled in, to the guide's path; without it the
 * guide is taken to exist already and nothing is written there.
 *
 * **Nothing that exists is overwritten without asking.** `plan` lists every file
 * with what would happen to it: `create`, `same` (already identical), `keep` (the
 * samples file, which is the project's own once it exists) or `conflict` (exists
 * and differs). Each conflict must be named by `--allow` (replace it) or `--skip`
 * (leave it as it is); `apply` refuses, writing nothing at all, while any is named
 * by neither, or by both.
 *
 * Nothing is written through a symlink that leads outside the project or nowhere,
 * or where a directory or a file is in the way. Such a path is `symlink` or
 * `blocked` in the plan, and `apply` writes nothing while any is.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(new URL('../', import.meta.url));
const TEMPLATES = join(PLUGIN, 'templates');
const SCHEMA_URL =
  'https://raw.githubusercontent.com/arhaty/claude-plugins/main/plugins/write/templates/write.schema.json';

export const CONFIG_PATH = '.claude/write.json';
export const PRESETS = readdirSync(join(TEMPLATES, 'presets'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.slice(0, -3))
  .sort();

const KEYS = ['version', 'language', 'guide', 'samples'];

/** `./docs/a.md` is `docs/a.md`: the spelling a write lands on. */
export const normalize = (path) => posix.normalize(path);

/**
 * Do two project paths name the same file? Compared without case, because the
 * default macOS filesystem ignores it and `.claude/Write.json` is the config.
 */
const sameFile = (a, b) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

/** Is `a` a directory above `b`, so that writing one makes the other impossible? */
const contains = (a, b) =>
  normalize(b)
    .toLowerCase()
    .startsWith(`${normalize(a).toLowerCase()}/`);

/** A project-relative path that stays inside the project, or why it is not. */
function pathProblem(key, value) {
  if (typeof value !== 'string' || value.trim() === '') return `${key} must be a non-empty string`;
  if (value.startsWith('/') || value.startsWith('~'))
    return `${key} must be relative to the project root`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return `${key} must be a project path`;
  if (/[\\\x00-\x1f\x7f\x85\u2028\u2029]/.test(value)) {
    return `${key} must use forward slashes and no control characters`;
  }
  const parts = value.replace(/^\.\//, '').split('/');
  if (parts.includes('..')) return `${key} must stay inside the project`;
  // Only a leading `./` may be spelled out, so `docs/.`, `docs/` and `a//b` are refused
  // and the schema can say the same thing as this check.
  if (parts.some((part) => part === '' || part === '.')) {
    return `${key} must name a file, with no empty or "." part`;
  }
  if (sameFile(value, CONFIG_PATH)) return `${key} must not be ${CONFIG_PATH}`;
  if (contains(value, CONFIG_PATH)) return `${key} must not be a directory holding ${CONFIG_PATH}`;
  return null;
}

/** Every problem with a parsed config, as readable lines. Empty means valid. */
export function validate(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return ['the config must be a JSON object'];
  }
  const errors = [];
  for (const key of Object.keys(config)) {
    if (!KEYS.includes(key) && key !== '$schema') errors.push(`unknown key ${key}`);
  }
  if (config.version !== 1) errors.push('version must be 1');
  if (typeof config.language !== 'string' || !/^\S.{0,49}$/.test(config.language)) {
    errors.push('language must be a name such as "English", at most 50 characters');
  }
  if (!('guide' in config)) errors.push('guide is required (a path, an https:// URL, or null)');
  else if (config.guide !== null && !/^https:\/\/\S+$/.test(config.guide ?? '')) {
    const problem = pathProblem('guide', config.guide);
    if (problem) errors.push(`${problem}, an https:// URL, or null`);
  }
  if (!('samples' in config)) errors.push('samples is required (a path or null)');
  else if (config.samples !== null) {
    const problem = pathProblem('samples', config.samples);
    if (problem) errors.push(`${problem}, or null`);
  }
  return errors;
}

/** Fill every `{{name}}`. An unknown name throws, so a typo in a template cannot ship. */
export function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`unknown placeholder {{${name}}}`);
    return values[name];
  });
}

/**
 * What a write to `path`, relative to `root`, would meet, in one walk over its
 * parts:
 *
 *   { kind: 'absent' }            nothing there yet
 *   { kind: 'file' }              a file, to compare or replace
 *   { kind: 'symlink', at }       a link a write must not follow
 *   { kind: 'blocked', at, why }  a directory where the file goes, or a file where a
 *                                 directory must be
 *
 * A link that resolves inside the project is followed: `docs -> handbook` is fine.
 * A dangling one, or one that leaves `realpath(root)`, is `symlink`, because a
 * cloned repository can aim a link anywhere. That is decided before anything is
 * said about what the link points at.
 */
export function inspect(root, path) {
  const base = realpathSync(root);
  const inside = (real) => real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  const parts = path.split('/').filter(Boolean);
  let at = root;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const name = parts.slice(0, i + 1).join('/');
    let stat = lstatSync(at, { throwIfNoEntry: false });
    if (!stat) return { kind: 'absent' };
    if (stat.isSymbolicLink()) {
      let real;
      try {
        real = realpathSync(at);
      } catch {
        return { kind: 'symlink', at: name };
      }
      if (!inside(real)) return { kind: 'symlink', at: name };
      stat = statSync(real);
    }
    const last = i === parts.length - 1;
    if (!last && !stat.isDirectory()) return { kind: 'blocked', at: name, why: 'is a file' };
    if (last && stat.isDirectory()) return { kind: 'blocked', at: name, why: 'is a directory' };
  }
  return { kind: 'file' };
}

/**
 * Every file setup would write, as `{ path, content }` relative to the project
 * root. Throws on a preset that cannot be written where the config says.
 */
export function render(config, { preset = null } = {}) {
  const files = [
    {
      path: CONFIG_PATH,
      content: `${JSON.stringify({ $schema: SCHEMA_URL, ...config }, null, 2)}\n`,
    },
  ];
  if (preset !== null) {
    if (!PRESETS.includes(preset)) {
      throw new Error(`unknown preset ${preset}; choose one of ${PRESETS.join(', ')}`);
    }
    if (typeof config.guide !== 'string' || config.guide.startsWith('https://')) {
      throw new Error('a preset is written to the guide path, so guide must be a project path');
    }
    const text = readFileSync(join(TEMPLATES, 'presets', `${preset}.md`), 'utf8');
    files.push({
      path: normalize(config.guide),
      content: fill(text, { language: config.language }),
    });
  }
  if (config.samples !== null) {
    files.push({
      path: normalize(config.samples),
      content: readFileSync(join(TEMPLATES, 'samples.md'), 'utf8'),
      keep: true,
    });
  }
  return files;
}

/**
 * The absolute path a write to `path` lands on: every link that exists along it
 * followed, the parts not created yet appended. Two paths that resolve to the same
 * place are one file however they are spelled.
 */
function resolved(root, path) {
  let at = realpathSync(root);
  const parts = path.split('/').filter(Boolean);
  for (const [i, part] of parts.entries()) {
    try {
      at = realpathSync(join(at, part));
    } catch {
      return join(at, ...parts.slice(i));
    }
  }
  return at;
}

/** Compared the way the default macOS filesystem compares names: without case or form. */
const fold = (path) => path.normalize('NFC').toLowerCase();

/**
 * `render`, with what would happen to each file: `create`, `same`, `keep`,
 * `conflict`, `symlink` (with `link`) or `blocked` (with `link` and `why`).
 *
 * Throws when two of the files are one file, or one would sit inside the other:
 * the second write would fail, or land on the first. Paths are compared by where
 * they resolve, through links inside the project, and without case or Unicode
 * form, as on macOS. This is checked on the paths about to be written, so it holds
 * whatever `validate` let through.
 */
export function plan(root, config, options) {
  const files = render(config, options).map((file) => ({
    ...file,
    real: resolved(root, file.path),
  }));
  for (const [i, a] of files.entries()) {
    for (const b of files.slice(i + 1)) {
      const [x, y] = [fold(a.real), fold(b.real)];
      if (x === y) throw new Error(`${a.path} and ${b.path} are the same file`);
      const [outer, inner] = y.startsWith(x + sep) ? [a, b] : [b, a];
      if (fold(inner.real).startsWith(fold(outer.real) + sep)) {
        throw new Error(`${inner.path} would be inside ${outer.path}, which is also written`);
      }
    }
  }
  return files.map(({ keep, ...file }) => {
    const found = inspect(root, file.path);
    if (found.kind === 'symlink') return { ...file, action: 'symlink', link: found.at };
    if (found.kind === 'blocked') {
      return { ...file, action: 'blocked', link: found.at, why: found.why };
    }
    if (found.kind === 'absent') return { ...file, action: 'create' };
    if (keep) return { ...file, action: 'keep' };
    const current = readFileSync(join(root, file.path), 'utf8');
    return { ...file, action: current === file.content ? 'same' : 'conflict' };
  });
}

/**
 * Write the plan. Refuses, writing nothing, on any symlink or on a conflict that
 * is neither allowed nor skipped, or is both. A skipped path is never written, even
 * if it stopped being a conflict since the user was asked.
 *
 * Every file is first written beside its target under a temporary name; only when
 * all of them are staged is each renamed into place. A failure while staging (a
 * directory that is not writable, a full disk) removes what was staged and the
 * directories made for it, and rethrows, so the project is left as it was.
 */
export function apply(root, config, { allow = [], skip = [], ...options } = {}) {
  allow = allow.map(normalize);
  skip = skip.map(normalize);
  const steps = plan(root, config, options);
  const none = { symlinks: [], blocked: [], both: [], refused: [] };
  const links = steps.filter((s) => s.action === 'symlink').map((s) => s.link);
  if (links.length) return { ...none, ok: false, symlinks: [...new Set(links)], steps };
  const blocked = steps.filter((s) => s.action === 'blocked').map((s) => `${s.link} ${s.why}`);
  if (blocked.length) return { ...none, ok: false, blocked: [...new Set(blocked)], steps };
  const conflicts = steps.filter((s) => s.action === 'conflict').map((s) => s.path);
  const both = conflicts.filter((p) => allow.includes(p) && skip.includes(p));
  const refused = conflicts.filter((p) => !allow.includes(p) && !skip.includes(p));
  if (both.length || refused.length) return { ...none, ok: false, both, refused, steps };

  for (const step of steps) if (skip.includes(step.path)) step.action = 'skipped';
  const writes = steps.filter((s) => s.action === 'create' || s.action === 'conflict');
  const made = [];
  const staged = [];
  try {
    for (const { real, content } of writes) {
      const created = mkdirSync(dirname(real), { recursive: true });
      if (created) made.push(created);
      const temp = join(dirname(real), `.${basename(real)}.${process.pid}.tmp`);
      writeFileSync(temp, content, { flag: 'wx' });
      staged.push([temp, real]);
    }
  } catch (error) {
    for (const [temp] of staged) rmSync(temp, { force: true });
    for (const dir of made.reverse()) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  for (const [temp, real] of staged) renameSync(temp, real);
  return { ...none, ok: true, steps };
}

function parse(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, allow: [], skip: [], preset: null, json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new Error(`${arg} needs a value`);
      return rest[++i];
    };
    if (arg === '--root') options.root = value();
    else if (arg === '--answers') options.answers = value();
    else if (arg === '--preset') options.preset = value();
    else if (arg === '--allow') options.allow.push(value());
    else if (arg === '--skip') options.skip.push(value());
    else if (arg === '--json') options.json = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!['plan', 'apply'].includes(mode)) throw new Error('first argument must be plan or apply');
  if (!options.root || !options.answers) throw new Error('--root and --answers are required');
  return options;
}

function main(argv) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    process.stderr.write(`scaffold: ${error.message}\n`);
    return 2;
  }
  // Resolved, so a symlinked checkout (macOS `/var`) is the root rather than a link in it.
  let root = resolve(options.root);
  try {
    root = realpathSync(root);
  } catch {
    process.stderr.write(`scaffold: ${options.root} does not exist\n`);
    return 2;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(options.answers, 'utf8'));
  } catch (error) {
    process.stderr.write(`scaffold: cannot read ${options.answers}: ${error.message}\n`);
    return 2;
  }
  const errors = validate(config);
  if (errors.length) {
    process.stderr.write(
      `scaffold: the answers are not a valid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`
    );
    return 2;
  }
  delete config.$schema;

  let result;
  try {
    result =
      options.mode === 'plan'
        ? plan(root, config, options).map(({ path, action }) => ({ path, action }))
        : apply(root, config, options);
  } catch (error) {
    process.stderr.write(`scaffold: ${error.message}\n`);
    return 2;
  }

  if (options.mode === 'plan') {
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else
      for (const { path, action } of result) process.stdout.write(`${action.padEnd(8)} ${path}\n`);
    return 0;
  }

  if (result.symlinks.length) {
    process.stderr.write(
      'scaffold: nothing written. These are symlinks, and a write through one lands wherever it\n' +
        `points. Replace each with a real file or directory first:\n${result.symlinks.map((p) => `  ${p}`).join('\n')}\n`
    );
    return 1;
  }
  const list = (paths) => paths.map((p) => `  ${p}`).join('\n');
  if (result.blocked.length) {
    process.stderr.write(
      `scaffold: nothing written. These paths are in the way of a write:\n${list(result.blocked)}\n`
    );
    return 1;
  }
  if (result.both.length) {
    process.stderr.write(
      'scaffold: nothing written. These were passed to both --allow and --skip; name each once,\n' +
        `as the user decided:\n${list(result.both)}\n`
    );
    return 1;
  }
  if (!result.ok) {
    process.stderr.write(
      'scaffold: nothing written. These exist and differ; pass --allow <path> for each one the user\n' +
        `approved and --skip <path> for each one they declined:\n${list(result.refused)}\n`
    );
    return 1;
  }
  const label = {
    same: 'unchanged',
    keep: 'kept',
    create: 'created',
    conflict: 'updated',
    skipped: 'skipped',
  };
  for (const { path, action } of result.steps) {
    process.stdout.write(`${label[action].padEnd(9)} ${path}\n`);
  }
  return 0;
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  process.exitCode = main(process.argv.slice(2));
}
