#!/usr/bin/env node
/**
 * Writes a project's canon files from `templates/`, for `/canon:setup`.
 *
 *   node scaffold.mjs plan  --root <dir> --answers <file> [--enable-plugin] [--json]
 *   node scaffold.mjs apply --root <dir> --answers <file> [--enable-plugin] [--allow <path>]...
 *
 * `--answers` is a JSON file holding the `.claude/canon.json` to write; it is
 * validated against the same rules the hooks use. `--enable-plugin` also sets
 * `enabledPlugins["canon@arhaty"]` in the project's `.claude/settings.json`.
 *
 * **Nothing that exists is overwritten without asking.** `plan` lists every file
 * with what would happen to it: `create`, `same` (already identical), or `conflict`
 * (exists and differs). `apply` refuses, writing nothing at all, while any conflict
 * is not named by an `--allow`, so the skill can show the conflicts, ask, and run
 * again with exactly what was approved.
 *
 * Two files are edited rather than replaced, and still count as a conflict when
 * they exist: `CLAUDE.md`, where only the section between the `canon:begin` and
 * `canon:end` markers is written (appended when there are no markers), and
 * `.claude/settings.json`, where only the one `enabledPlugins` key is merged.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_PATH, validate } from '../hooks/lib/config.mjs';
import { build as buildIndex } from './canon-index.mjs';

const PLUGIN = fileURLToPath(new URL('../', import.meta.url));
const TEMPLATES = join(PLUGIN, 'templates', 'project');
const SECTION = join(PLUGIN, 'templates', 'claude-md-section.md');
const SCHEMA_URL =
  'https://raw.githubusercontent.com/arhaty/claude-plugins/main/plugins/canon/templates/canon.schema.json';
const PLUGIN_KEY = 'canon@arhaty';
const BEGIN = '<!-- canon:begin -->';
const END = '<!-- canon:end -->';

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** The values the templates' `{{placeholders}}` take, from a validated config. */
export function placeholders(config) {
  const code = (value) => `\`${value}\``;
  const checks = Object.values(config.commands).filter((command) => command !== null);
  return {
    owner: config.owner,
    integration: config.branches.integration,
    production: config.branches.production,
    prefixes: config.branches.prefixes.map((p) => code(`${p}/`)).join(', '),
    checks: checks.length ? checks.map(code).join(', ') : 'none configured in `.claude/canon.json`',
  };
}

/** Fill every `{{name}}`. An unknown name throws, so a typo in a template cannot ship. */
export function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`unknown placeholder {{${name}}}`);
    return values[name];
  });
}

/** CLAUDE.md with the canon section written in: replaced between markers, else appended. */
function withSection(current, section) {
  if (current === null) return `# CLAUDE.md\n\n${section}`;
  const begin = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (begin !== -1 && end > begin) {
    return current.slice(0, begin) + section.trimEnd() + current.slice(end + END.length);
  }
  return `${current.trimEnd()}\n\n${section}`;
}

function withPluginEnabled(current) {
  const settings = current === null ? {} : JSON.parse(current);
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [PLUGIN_KEY]: true };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Every file setup would write, as `{ path, content }` with `path` relative to the
 * project root. Pure apart from reading the templates and the files it edits.
 */
export function render(root, config, { enablePlugin = false } = {}) {
  const values = placeholders(config);
  const read = (path) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
  const files = [];

  for (const source of walk(TEMPLATES)) {
    const path = relative(TEMPLATES, source);
    files.push({ path, content: fill(readFileSync(source, 'utf8'), values) });
  }

  files.push({
    path: CONFIG_PATH,
    content: `${JSON.stringify({ $schema: SCHEMA_URL, ...config }, null, 2)}\n`,
  });

  files.push({
    path: 'CLAUDE.md',
    content: withSection(read('CLAUDE.md'), fill(readFileSync(SECTION, 'utf8'), values)),
  });

  if (enablePlugin) {
    files.push({
      path: '.claude/settings.json',
      content: withPluginEnabled(read('.claude/settings.json')),
    });
  }

  return files;
}

/** `render`, with what would happen to each file. */
export function plan(root, config, options) {
  return render(root, config, options).map((file) => {
    const target = join(root, file.path);
    if (!existsSync(target)) return { ...file, action: 'create' };
    return { ...file, action: readFileSync(target, 'utf8') === file.content ? 'same' : 'conflict' };
  });
}

/**
 * Write the plan. Refuses, writing nothing, while a conflict is not in `allow`.
 * Then generates `.claude/canon-index.md` when it does not exist yet.
 */
export function apply(root, config, { allow = [], ...options } = {}) {
  const steps = plan(root, config, options);
  const refused = steps.filter((s) => s.action === 'conflict' && !allow.includes(s.path));
  if (refused.length) return { ok: false, refused: refused.map((s) => s.path), steps };

  for (const step of steps) {
    if (step.action === 'same') continue;
    mkdirSync(dirname(join(root, step.path)), { recursive: true });
    writeFileSync(join(root, step.path), step.content);
  }

  const index = join(root, '.claude', 'canon-index.md');
  const indexed = !existsSync(index);
  if (indexed) writeFileSync(index, buildIndex(root));
  return { ok: true, steps, indexed };
}

function parse(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, allow: [], enablePlugin: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--root') options.root = rest[++i];
    else if (arg === '--answers') options.answers = rest[++i];
    else if (arg === '--allow') options.allow.push(rest[++i]);
    else if (arg === '--enable-plugin') options.enablePlugin = true;
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
  const root = resolve(options.root);
  let config;
  try {
    config = JSON.parse(readFileSync(options.answers, 'utf8'));
  } catch (error) {
    process.stderr.write(`scaffold: cannot read ${options.answers}: ${error.message}\n`);
    return 2;
  }
  delete config.$schema;
  const errors = validate(config);
  if (errors.length) {
    process.stderr.write(
      `scaffold: the answers are not a valid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`
    );
    return 2;
  }

  if (options.mode === 'plan') {
    const steps = plan(root, config, options).map(({ path, action }) => ({ path, action }));
    if (options.json) process.stdout.write(`${JSON.stringify(steps, null, 2)}\n`);
    else
      for (const { path, action } of steps) process.stdout.write(`${action.padEnd(8)} ${path}\n`);
    return 0;
  }

  const result = apply(root, config, options);
  if (!result.ok) {
    process.stderr.write(
      `scaffold: nothing written. These exist and differ; pass --allow <path> for each one the user\n` +
        `approved:\n${result.refused.map((p) => `  ${p}`).join('\n')}\n`
    );
    return 1;
  }
  const label = { same: 'unchanged', create: 'created', conflict: 'updated' };
  for (const { path, action } of result.steps) {
    process.stdout.write(`${label[action].padEnd(9)} ${path}\n`);
  }
  if (result.indexed) process.stdout.write('created   .claude/canon-index.md\n');
  return 0;
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  process.exitCode = main(process.argv.slice(2));
}
