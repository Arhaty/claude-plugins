#!/usr/bin/env node
/**
 * Writes a project's canon files from `templates/`, for `/canon:setup`.
 *
 *   node scaffold.mjs plan  --root <dir> --answers <file> [--enable-plugin] [--json]
 *   node scaffold.mjs apply --root <dir> --answers <file> [--enable-plugin] [--allow <path>]...
 *   node scaffold.mjs trust --root <dir> --answers <file> [--command formatFile|apiKeyCommand]
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
 * Three files are the project's own once they exist, and are `keep` rather than
 * `conflict`: `.claude/canon-domains.json`, `docs/canon/README.md` and
 * `docs/specs/README.md`. The templates hold an empty map and an empty index, so
 * approving them as a conflict would have wiped what the project had written.
 *
 * Nothing is written through a symlink that leads outside the project or nowhere.
 * A path whose file or any directory above it is such a link is `symlink` in the
 * plan, and `apply` writes nothing while any is: a cloned repository can point a
 * link anywhere. A link that stays inside, such as `CLAUDE.md -> AGENTS.md`, is
 * written through.
 *
 * `trust` records the owner's approval of the answers' `formatFile` (or, with
 * `--command apiKeyCommand`, of `tracker.apiKeyCommand`) for this repository in
 * `~/.claude/canon/trusted.json`, outside it, which is the only thing that lets
 * `format-file.mjs` or `tracker.mjs` run it. Setup runs it after asking.
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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_PATH,
  DOMAINS_PATH,
  repositoryFile,
  symlinkIn,
  trust,
  trustKeyCommand,
  validate,
} from '../hooks/lib/config.mjs';
import { build as buildIndex } from './canon-index.mjs';

const PLUGIN = fileURLToPath(new URL('../', import.meta.url));
const TEMPLATES = join(PLUGIN, 'templates', 'project');
const SECTION = join(PLUGIN, 'templates', 'claude-md-section.md');
const SCHEMA_URL =
  'https://raw.githubusercontent.com/arhaty/claude-plugins/main/plugins/canon/templates/canon.schema.json';
const PLUGIN_KEY = 'canon@arhaty';
const BEGIN = '<!-- canon:begin -->';
const END = '<!-- canon:end -->';

/** Files the project fills in after setup: kept as they are once they exist. */
const KEEP = new Set([DOMAINS_PATH, 'docs/canon/README.md', 'docs/specs/README.md']);

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
    tracker: config.tracker ? trackerSection(config) : '',
  };
}

/**
 * The CLAUDE.md paragraph for a project whose issue tracker is the gate, or nothing.
 * Kept here rather than in the template so a project without a tracker gets no
 * trace of one.
 */
function trackerSection({ tracker, owner }) {
  const name = { linear: 'Linear' }[tracker.provider] ?? tracker.provider;
  const status = (role) => `\`${tracker.statuses[role]}\``;
  return [
    `\n\n### ${name}\n`,
    `${name} team \`${tracker.team}\` is the record and the gate. The commands take an issue ID`,
    `(\`${tracker.team}-123\`) where they would take a spec number, read its status, and move it:`,
    `\`/canon:define\` from ${status('ready')} to ${status('spec')}, \`/canon:approve\` to ${status('approved')},`,
    `\`/canon:build\` to ${status('building')}, and \`/canon:build\` or \`/canon:ship\` to ${status('blocked')}`,
    `when they need ${owner}. ${name}'s GitHub integration sets ${status('staging')} and ${status('production')}`,
    "when the pull requests merge, never by hand. The spec's `**Status:**` line mirrors the issue.",
    '',
    `- Branches are \`<prefix>/${tracker.team.toLowerCase()}-123-<slug>\`. Commit bodies carry`,
    `  \`Part of ${tracker.team}-123\`; the pull request body carries \`Fixes ${tracker.team}-123\`,`,
    '  which is what moves the issue on merge.',
    `- A ${status('blocked')} issue has its question in a comment starting \`canon: blocked\`.`,
    '  Answer it in a comment below, or in the session, and re-run the command.',
  ].join('\n');
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
  let settings = {};
  if (current !== null) {
    try {
      settings = JSON.parse(current);
    } catch (error) {
      throw new Error(
        `.claude/settings.json is not valid JSON (${error.message}). Fix it, or run without ` +
          '--enable-plugin to leave it alone.'
      );
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(
        '.claude/settings.json is not a JSON object. Fix it, or run without --enable-plugin.'
      );
    }
  }
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
    const path = relative(TEMPLATES, source).split(sep).join('/');
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
    const link = symlinkIn(root, file.path);
    if (link !== null) return { ...file, action: 'symlink', link };
    if (!existsSync(target)) return { ...file, action: 'create' };
    if (KEEP.has(file.path)) return { ...file, action: 'keep' };
    return { ...file, action: readFileSync(target, 'utf8') === file.content ? 'same' : 'conflict' };
  });
}

/**
 * Write the plan. Refuses, writing nothing, while a conflict is not in `allow` or
 * any path runs through a symlink. Then generates `.claude/canon-index.md` when it
 * does not exist yet.
 */
export function apply(root, config, { allow = [], ...options } = {}) {
  const steps = plan(root, config, options);
  const INDEX = '.claude/canon-index.md';
  const links = steps.filter((s) => s.action === 'symlink').map((s) => s.link);
  const indexLink = symlinkIn(root, INDEX);
  if (indexLink !== null) links.push(indexLink);
  if (links.length) return { ok: false, symlinks: [...new Set(links)], refused: [], steps };
  const refused = steps.filter((s) => s.action === 'conflict' && !allow.includes(s.path));
  if (refused.length) return { ok: false, refused: refused.map((s) => s.path), steps };

  for (const step of steps) {
    if (step.action === 'same' || step.action === 'keep') continue;
    mkdirSync(dirname(join(root, step.path)), { recursive: true });
    writeFileSync(join(root, step.path), step.content);
  }

  const index = join(root, INDEX);
  const indexed = !existsSync(index);
  if (indexed) writeFileSync(index, buildIndex(root));
  return { ok: true, steps, indexed };
}

function parse(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, allow: [], enablePlugin: false, json: false, command: 'formatFile' };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--root') options.root = rest[++i];
    else if (arg === '--answers') options.answers = rest[++i];
    else if (arg === '--allow') options.allow.push(rest[++i]);
    else if (arg === '--enable-plugin') options.enablePlugin = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--command') options.command = rest[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!['plan', 'apply', 'trust'].includes(mode)) {
    throw new Error('first argument must be plan, apply or trust');
  }
  if (!options.root || !options.answers) throw new Error('--root and --answers are required');
  if (!['formatFile', 'apiKeyCommand'].includes(options.command)) {
    throw new Error('--command must be formatFile or apiKeyCommand');
  }
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
    // Not created yet: the plan creates it.
  }
  let config;
  try {
    config = JSON.parse(readFileSync(options.answers, 'utf8'));
  } catch (error) {
    process.stderr.write(`scaffold: cannot read ${options.answers}: ${error.message}\n`);
    return 2;
  }
  delete config.$schema;

  // Setup approves the key command before the rest of the config exists, to list the
  // team's statuses with it, so only the command itself has to be valid here.
  if (options.mode === 'trust' && options.command === 'apiKeyCommand') {
    const argv = config?.tracker?.apiKeyCommand;
    if (!Array.isArray(argv) || argv.length === 0) {
      process.stderr.write(
        'scaffold: the answers set no apiKeyCommand, so there is nothing to trust.\n'
      );
      return 1;
    }
    if (!argv.every((arg) => typeof arg === 'string' && arg.trim() !== '')) {
      process.stderr.write('scaffold: tracker.apiKeyCommand must be a list of argv strings.\n');
      return 2;
    }
    const inside = repositoryFile(root, argv);
    if (inside !== null) {
      process.stderr.write(
        `scaffold: tracker.apiKeyCommand names ${inside}, a file in this repository. An approval\n` +
          'covers the command line, and that file can change under it, so it cannot be approved.\n'
      );
      return 2;
    }
    trustKeyCommand(root, argv);
    process.stdout.write(`trusted   apiKeyCommand ${JSON.stringify(argv)} for ${root}\n`);
    return 0;
  }

  const errors = validate(config);
  if (errors.length) {
    process.stderr.write(
      `scaffold: the answers are not a valid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`
    );
    return 2;
  }

  if (options.mode === 'trust') {
    if (config.formatFile === null) {
      process.stderr.write(
        'scaffold: the answers set no formatFile, so there is nothing to trust.\n'
      );
      return 1;
    }
    trust(root, config.formatFile);
    process.stdout.write(`trusted   ${JSON.stringify(config.formatFile)} for ${root}\n`);
    return 0;
  }

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
    const steps = result;
    if (options.json) process.stdout.write(`${JSON.stringify(steps, null, 2)}\n`);
    else
      for (const { path, action } of steps) process.stdout.write(`${action.padEnd(8)} ${path}\n`);
    return 0;
  }

  if (result.symlinks?.length) {
    process.stderr.write(
      'scaffold: nothing written. These are symlinks, and a write through one lands wherever it\n' +
        `points. Replace each with a real file or directory first:\n${result.symlinks.map((p) => `  ${p}`).join('\n')}\n`
    );
    return 1;
  }
  if (!result.ok) {
    process.stderr.write(
      `scaffold: nothing written. These exist and differ; pass --allow <path> for each one the user\n` +
        `approved:\n${result.refused.map((p) => `  ${p}`).join('\n')}\n`
    );
    return 1;
  }
  const label = { same: 'unchanged', keep: 'kept', create: 'created', conflict: 'updated' };
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
