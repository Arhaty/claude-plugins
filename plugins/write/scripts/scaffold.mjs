#!/usr/bin/env node
/**
 * Writes a project's `write` files, for `/write:setup`.
 *
 *   node scaffold.mjs plan  --root <dir> --answers <file> [--preset <name>] [--json]
 *   node scaffold.mjs apply --root <dir> --answers <file> [--preset <name>] [--allow <path>]...
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
 * and differs). `apply` refuses, writing nothing at all, while any conflict is not
 * named by an `--allow`.
 *
 * Nothing is written through a symlink that leads outside the project or nowhere.
 * Such a path is `symlink` in the plan and `apply` writes nothing while any is.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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

/** A project-relative path that stays inside the project, or why it is not. */
function pathProblem(key, value) {
  if (typeof value !== 'string' || value.trim() === '') return `${key} must be a non-empty string`;
  if (value.startsWith('/') || value.startsWith('~'))
    return `${key} must be relative to the project root`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return `${key} must be a project path`;
  if (/[\\\0]/.test(value)) return `${key} must use forward slashes and no control characters`;
  if (value.split('/').some((part) => part === '..')) return `${key} must stay inside the project`;
  if (value.replace(/^\.\//, '') === CONFIG_PATH) return `${key} must not be ${CONFIG_PATH}`;
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
  if (
    typeof config.guide === 'string' &&
    typeof config.samples === 'string' &&
    config.guide === config.samples
  ) {
    errors.push('guide and samples must be different files');
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
 * The first part of `path`, relative to `root`, that is a symlink a write must not
 * follow, or `null`. A link that resolves inside the project is fine; a dangling
 * one, or one that leaves `realpath(root)`, is refused, because a cloned repository
 * can aim a link anywhere.
 */
export function symlinkIn(root, path) {
  let base;
  try {
    base = realpathSync(root);
  } catch {
    return null;
  }
  const inside = (real) => real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  let at = root;
  for (const part of path.split('/').filter(Boolean)) {
    at = join(at, part);
    let link;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      return null;
    }
    if (!link) continue;
    const name = at.slice(root.length + sep.length);
    try {
      if (!inside(realpathSync(at))) return name;
    } catch {
      return name;
    }
  }
  return null;
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
    files.push({ path: config.guide, content: fill(text, { language: config.language }) });
  }
  if (config.samples !== null) {
    files.push({
      path: config.samples,
      content: readFileSync(join(TEMPLATES, 'samples.md'), 'utf8'),
      keep: true,
    });
  }
  return files;
}

/** `render`, with what would happen to each file. */
export function plan(root, config, options) {
  return render(config, options).map(({ keep, ...file }) => {
    const target = join(root, file.path);
    const link = symlinkIn(root, file.path);
    if (link !== null) return { ...file, action: 'symlink', link };
    if (!existsSync(target)) return { ...file, action: 'create' };
    if (keep) return { ...file, action: 'keep' };
    return { ...file, action: readFileSync(target, 'utf8') === file.content ? 'same' : 'conflict' };
  });
}

/** Write the plan. Refuses, writing nothing, on an unapproved conflict or any symlink. */
export function apply(root, config, { allow = [], ...options } = {}) {
  const steps = plan(root, config, options);
  const links = steps.filter((s) => s.action === 'symlink').map((s) => s.link);
  if (links.length) return { ok: false, symlinks: [...new Set(links)], refused: [], steps };
  const refused = steps.filter((s) => s.action === 'conflict' && !allow.includes(s.path));
  if (refused.length)
    return { ok: false, symlinks: [], refused: refused.map((s) => s.path), steps };

  for (const step of steps) {
    if (step.action !== 'create' && step.action !== 'conflict') continue;
    mkdirSync(dirname(join(root, step.path)), { recursive: true });
    writeFileSync(join(root, step.path), step.content);
  }
  return { ok: true, symlinks: [], refused: [], steps };
}

function parse(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, allow: [], preset: null, json: false };
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
  if (!result.ok) {
    process.stderr.write(
      'scaffold: nothing written. These exist and differ; pass --allow <path> for each one the user\n' +
        `approved:\n${result.refused.map((p) => `  ${p}`).join('\n')}\n`
    );
    return 1;
  }
  const label = { same: 'unchanged', keep: 'kept', create: 'created', conflict: 'updated' };
  for (const { path, action } of result.steps) {
    process.stdout.write(`${label[action].padEnd(9)} ${path}\n`);
  }
  return 0;
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  process.exitCode = main(process.argv.slice(2));
}
