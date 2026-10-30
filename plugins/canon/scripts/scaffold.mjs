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
 * Six files are the project's own once they exist, and are `keep` rather than
 * `conflict`: `.claude/canon-domains.json`, the two READMEs and the two `_TEMPLATE.md`
 * files under `docs/`, and `.claude/rules/principles.md`. They are starting points the
 * project edits, so approving one as a conflict would wipe what the project wrote. One
 * that still holds, word for word, a paragraph canon writes only under other `specs` or
 * `tracker` settings, such as the specs README's Lifecycle after a switch to the tracker
 * archive, is `stale`: still kept, with `plan --json` giving the text the answers would
 * write, so the skill can offer to edit the sections that differ. Text the project wrote
 * itself is never evidence, so an edit or a rewrite is never stale.
 *
 * `.claude/canon.json` is `same` when it holds the same values in any formatting, so a
 * formatter's rewrite is not a conflict. With `"claudeMd": false` in the answers,
 * `CLAUDE.md` is not written at all: the project keeps its own section.
 *
 * With `specs.archive` `"tracker"`, an existing `docs/specs/archive/` is `leftover` in
 * the plan: nothing writes or removes it, and the skill says it no longer matches.
 *
 * Nothing is written through a symlink that leads outside the project or nowhere.
 * A path whose file or any directory above it is such a link is `symlink` in the
 * plan, and `apply` writes nothing while any is: a cloned repository can point a
 * link anywhere. A link that stays inside, such as `CLAUDE.md -> AGENTS.md`, is
 * written through.
 *
 * The skills and hooks read canon's files by their exact names, so a path the project
 * holds only under another letter case, such as `docs/specs/_template.md` or a `.Claude/`
 * directory, is `case` in the plan, and `apply` writes nothing while any is,
 * `.claude/canon-index.md` included. The project renames it first.
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
import { isDeepStrictEqual } from 'node:util';

import {
  COMMANDS,
  CONFIG_PATH,
  DOMAINS_PATH,
  ROLES,
  TRUST_FORMAT_VARIABLE,
  commandDigest,
  keyCommandProblem,
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
const ARCHIVE = 'docs/specs/archive/';
const BEGIN = '<!-- canon:begin -->';
const END = '<!-- canon:end -->';

/** Starting points the project edits after setup: kept as they are once they exist. */
const KEEP = new Set([
  DOMAINS_PATH,
  ROLES,
  'docs/canon/README.md',
  'docs/canon/_TEMPLATE.md',
  'docs/specs/README.md',
  'docs/specs/_TEMPLATE.md',
  '.claude/rules/principles.md',
]);

const INDEX = '.claude/canon-index.md';

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** A directory lister for `root` that reads each directory once: names, or null when absent. */
function lister(root) {
  const listings = new Map();
  return (dir) => {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, readdirSync(join(root, dir)));
      } catch {
        listings.set(dir, null);
      }
    }
    return listings.get(dir);
  };
}

/**
 * Where `path` is held under another letter case: `{ wanted, variants }` for the first part of
 * it that is, such as `{ wanted: '.claude', variants: ['.Claude'] }`, or null. Canon reads its
 * files by their exact names, so a project's `_template.md` is neither replaced under a name the
 * plan does not show (macOS) nor joined by a second `_TEMPLATE.md` (Linux): it is renamed first.
 */
function caseMismatch(path, names) {
  let dir = '';
  for (const part of path.split('/')) {
    const listed = names(dir);
    if (listed === null) return null;
    if (!listed.includes(part)) {
      const lower = part.toLowerCase();
      const variants = listed
        .filter((name) => name.toLowerCase() === lower)
        .sort()
        .map((name) => dir + name);
      return variants.length ? { wanted: dir + part, variants } : null;
    }
    dir += `${part}/`;
  }
  return null;
}

/** The values the templates' `{{placeholders}}` take, from a validated config. */
export function placeholders(config) {
  const code = (value) => `\`${value}\``;
  // The checks run before each commit. The build is left out: it runs in the gate, where
  // `references/gate.md` says when it is skipped, and it can be an object rather than a string.
  const checks = COMMANDS.map((name) => config.commands[name]).filter(
    (command) => command !== null
  );
  return {
    owner: config.owner,
    integration: config.branches.integration,
    production: config.branches.production,
    branchNames:
      config.branches.naming === 'tracker'
        ? "the tracker issue's own branch name, verbatim"
        : `${config.branches.prefixes.map((p) => code(`${p}/`)).join(', ')} followed by a kebab-case description`,
    checks: checks.length ? checks.map(code).join(', ') : 'none configured in `.claude/canon.json`',
    tracker: config.tracker ? trackerSection(config) : '',
    ...loopValues(config),
    ...specsValues(config),
  };
}

/**
 * How the CLAUDE.md loop names the gate and each command's move. With a tracker the issue's
 * status is the gate, and `references/tracker.md` makes the spec's status line optional.
 */
function loopValues({ tracker }) {
  if (!tracker) {
    return {
      statusIntro:
        "A spec's status is the `**Status:**` line under its title, and each command makes one move:",
      approveMove: 'sets `approved`, commits and pushes it',
      buildMove: 'sets `in-progress`',
    };
  }
  const status = (role) => `\`${tracker.statuses[role]}\``;
  return {
    statusIntro: "The issue's status is the gate, and each command makes one move:",
    approveMove: `commits any status-line edit, pushes, and moves the issue to ${status('approved')}`,
    buildMove: `moves the issue to ${status('building')}`,
  };
}

/**
 * The text that says where a spec lives, how it is drafted and how it ends, which the `specs`
 * settings and the tracker decide. `references/specs.md` is what the skills follow; this says
 * the same.
 */
function specsValues({ specs, tracker, owner }) {
  const byBranch = specs?.naming === 'branch';
  const toTracker = specs?.archive === 'tracker';
  return {
    spec: tracker ? `${tracker.team}-123` : byBranch ? '<branch>' : 'NNN',
    specTitle: byBranch ? '<branch, each / as ->' : 'NNN',
    specRules: byBranch ? 'naming' : 'numbering',
    statusLineRule: tracker
      ? "The `**Status:**` line\nis optional: the issue's status is the gate. A spec that has it keeps it directly under the H1,\nmirroring the issue: commands find it by that prefix."
      : 'The `**Status:**` line\nstays directly under the H1: commands find it by that prefix.',
    specFile: byBranch ? '`<branch>.md`, the branch name with each `/` as `-`' : '`NNN-slug.md`',
    specPath: byBranch
      ? '`docs/specs/<branch>.md`, the branch name with each `/` as `-`'
      : '`docs/specs/NNN-slug.md`',
    specArchive: toTracker
      ? 'When it ships, `/canon:staging` posts it to its issue and deletes it: the issue is the archive.'
      : '`archive/` holds the rest.',
    specShips: toTracker
      ? 'posts the spec to its issue, deletes it'
      : 'sets `shipped`, archives the spec',
    lifecycle: lifecycle(specs, tracker, owner),
    specNaming: byBranch
      ? [
          '## Naming',
          '',
          'A spec is named after its branch, with each `/` as `-`: `feat/rate-limit` writes',
          '`docs/specs/feat-rate-limit.md`. There is no number. A file of that name already on another',
          'remote branch is refused.',
        ].join('\n')
      : [
          '## Numbering',
          '',
          ...(toTracker
            ? [
                'The next number is the highest three-digit prefix ever committed under `docs/specs/`, on any',
                'branch, plus one: a shipped spec is deleted, and its number is never given out again. No',
                '`spec-` prefix. A slug that is already taken is refused.',
              ]
            : [
                'The next number is the highest three-digit prefix across `docs/specs/**` (active and archive, and',
                'on other remote branches) plus one. No `spec-` prefix. A slug that is already taken is refused.',
              ]),
        ].join('\n'),
    specArchiveRule: toTracker
      ? '`/canon:staging` posts the spec to its issue as a comment, then deletes it in a commit on the\nbranch before it merges: the issue is the archive,'
      : '`/canon:staging` sets `shipped` and `git mv`s the spec to `docs/specs/archive/` in a commit on the\nbranch before it merges,',
  };
}

/**
 * How many columns `text` takes in a monospace font, as Prettier measures it when it aligns a
 * table, one grapheme at a time: a joined emoji sequence or an emoji-style symbol takes two, as
 * does a wide East Asian character; a text-style symbol such as `™` takes one, and a combining
 * mark adds nothing to the letter it sits on.
 */
export function displayWidth(text) {
  let width = 0;
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
    const code = segment.codePointAt(0);
    const wide =
      /\p{Emoji_Presentation}|\ufe0f/u.test(segment) ||
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * The specs README's Lifecycle section: how the status is read, then a table of the statuses,
 * padded as a Markdown formatter would leave it so a project's format check passes.
 */
function lifecycle(specs, tracker, rawOwner) {
  // A `|` in a cell would start a new column.
  const owner = rawOwner.replaceAll('|', '\\|');
  const toTracker = specs?.archive === 'tracker';
  const posted = 'posted to its issue as a comment';
  const rows = [
    ['Status', 'Set by', 'Means'],
    [
      '`draft`',
      '`/canon:define`',
      specs?.commitWhileDrafting === false
        ? 'Being argued out. Left uncommitted on its branch until `/canon:approve` commits it.'
        : 'Being argued out. Committed and pushed on its branch each round; not yet approved.',
    ],
    [
      '`approved`',
      '`/canon:approve`',
      `${owner} read it. \`Still open\` is \`None.\`, committed and pushed.`,
    ],
    ['`in-progress`', '`/canon:build`', 'A build has started, in its own commit.'],
    [
      '`shipped`',
      '`/canon:staging`',
      toTracker
        ? `Merged. Not set: the spec is ${posted} and deleted, and the issue says it shipped.`
        : 'Merged. Set in the commit that moves the spec to `archive/`.',
    ],
    [
      '`abandoned`',
      `${owner} only`,
      toTracker
        ? `Dropped. Not set: the spec is ${posted}, and its branch is deleted unmerged.`
        : 'Dropped. Set from any status, in the commit that moves it to `archive/`.',
    ],
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => displayWidth(row[i]))));
  const pad = (cell, i) => cell + ' '.repeat(widths[i] - displayWidth(cell));
  const line = (cells) => `| ${cells.map(pad).join(' | ')} |`;
  const table = [
    line(rows[0]),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.slice(1).map(line),
  ];
  // references/tracker.md makes the line optional whenever there is a tracker.
  const status = tracker
    ? "With a tracker the `**Status:**` line under the H1 is optional: the issue's status is the\ngate. A spec that has the line keeps it mirroring the issue, and commands find it by that\nprefix, never by line number."
    : 'The status is the `**Status:**` line directly under the H1. Commands find it by that prefix,\nnever by line number.';
  return `${status}\n\n${table.join('\n')}`;
}

/**
 * The CLAUDE.md paragraph for a project whose issue tracker is the gate, or nothing.
 * Kept here rather than in the template so a project without a tracker gets no
 * trace of one.
 */
function trackerSection({ tracker, owner, branches }) {
  const name = { linear: 'Linear' }[tracker.provider] ?? tracker.provider;
  const status = (role) => `\`${tracker.statuses[role]}\``;
  return [
    `\n\n### ${name}\n`,
    `${name} team \`${tracker.team}\` is the record and the gate. The commands take an issue ID`,
    `(\`${tracker.team}-123\`) where they would take a spec number, read its status, and move it:`,
    `\`/canon:define\` from ${status('ready')} to ${status('spec')}, \`/canon:approve\` to ${status('approved')},`,
    `\`/canon:build\` to ${status('building')}, and \`/canon:build\` or \`/canon:ship\` to ${status('blocked')}`,
    `when they need ${owner}. ${name}'s GitHub integration sets ${status('staging')} and ${status('production')}`,
    "when the pull requests merge, never by hand. A spec's `**Status:**` line is optional; one that has it mirrors the issue.",
    '',
    branches.naming === 'tracker'
      ? `- Branches are the issue's own branch name, verbatim, e.g. \`${tracker.team.toLowerCase()}-123-<slug>\`. Commit bodies carry`
      : `- Branches are \`<prefix>/${tracker.team.toLowerCase()}-123-<slug>\`. Commit bodies carry`,
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
 * project root, and `template` for a file filled from one. Pure apart from reading the
 * templates and the files it edits.
 */
export function render(root, config, { enablePlugin = false } = {}) {
  const values = placeholders(config);
  const read = (path) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
  const files = [];

  for (const source of walk(TEMPLATES)) {
    const path = relative(TEMPLATES, source).split(sep).join('/');
    // With the tracker as the archive, `docs/specs/` holds only work in flight.
    if (path.startsWith(ARCHIVE) && config.specs?.archive === 'tracker') continue;
    const template = readFileSync(source, 'utf8');
    files.push({ path, content: fill(template, values), template });
  }

  files.push({
    path: CONFIG_PATH,
    content: `${JSON.stringify({ $schema: SCHEMA_URL, ...config }, null, 2)}\n`,
  });

  if (config.claudeMd !== false) {
    files.push({
      path: 'CLAUDE.md',
      content: withSection(read('CLAUDE.md'), fill(readFileSync(SECTION, 'utf8'), values)),
    });
  }

  if (enablePlugin) {
    files.push({
      path: '.claude/settings.json',
      content: withPluginEnabled(read('.claude/settings.json')),
    });
  }

  return files;
}

/** Collapsed, so a formatter's rewrapping and table padding read as the same text. */
const collapse = (text) => text.replace(/-{3,}/g, '---').replace(/\s+/g, ' ').trim();

/** A tracker for filling the templates as they read with one, when the config has none. */
const SAMPLE_TRACKER = {
  provider: 'linear',
  team: 'ABC',
  statuses: Object.fromEntries(ROLES.map((role) => [role, role])),
};

/**
 * The placeholder values `config` would have under every other combination of the settings
 * that change what the specs README and template say: a tracker or none, and each `specs` value.
 */
function otherSettings(config) {
  const others = [];
  for (const tracker of [undefined, config.tracker ?? SAMPLE_TRACKER]) {
    for (const naming of ['number', 'branch']) {
      for (const archive of ['repo', 'tracker']) {
        for (const commitWhileDrafting of [true, false]) {
          const specs = { naming, archive, commitWhileDrafting };
          others.push(placeholders({ ...config, tracker, specs }));
        }
      }
    }
  }
  return others;
}

/** The paragraphs of `text`, each collapsed, headings and rules left out. */
const paragraphsOf = (text) =>
  text
    .split(/\n{2,}/)
    .map(collapse)
    .filter((p) => p && p !== '---' && !p.startsWith('#'));

/**
 * Whether the kept file `current` still holds, word for word, a paragraph that `template` fills
 * only under other settings than `values`: positive evidence that it describes them. Text the
 * project wrote, or rewrote, never matches one, so an edit is never stale.
 */
function isStale(current, template, values, others) {
  const now = new Set(paragraphsOf(fill(template, values)));
  const text = collapse(current);
  return others.some((other) =>
    paragraphsOf(fill(template, other)).some((p) => !now.has(p) && text.includes(p))
  );
}

/** Whether the config at `target` holds the same values as `content`, however it is formatted. */
function sameConfig(target, content) {
  try {
    return isDeepStrictEqual(JSON.parse(readFileSync(target, 'utf8')), JSON.parse(content));
  } catch {
    return false;
  }
}

/** `render`, with what would happen to each file. */
export function plan(root, config, options) {
  const names = lister(root);
  const values = placeholders(config);
  const others = otherSettings(config);
  const blocked = (path) => {
    const link = symlinkIn(root, path);
    if (link !== null) return { action: 'symlink', link };
    const mismatch = caseMismatch(path, names);
    return mismatch === null ? null : { action: 'case', ...mismatch };
  };
  const steps = render(root, config, options).map((file) => {
    const target = join(root, file.path);
    const block = blocked(file.path);
    if (block !== null) return { ...file, ...block };
    if (!existsSync(target)) return { ...file, action: 'create' };
    if (KEEP.has(file.path)) {
      const stale = isStale(readFileSync(target, 'utf8'), file.template, values, others);
      return { ...file, action: stale ? 'stale' : 'keep' };
    }
    const same =
      file.path === CONFIG_PATH
        ? sameConfig(target, file.content)
        : readFileSync(target, 'utf8') === file.content;
    return { ...file, action: same ? 'same' : 'conflict' };
  });
  if (config.specs?.archive === 'tracker' && existsSync(join(root, ARCHIVE))) {
    steps.push({ path: ARCHIVE, action: 'leftover' });
  }
  // `apply` writes the index after the plan, so the plan shows what would stop that too.
  const index = blocked(INDEX);
  if (index !== null) steps.push({ path: INDEX, ...index });
  return steps;
}

/**
 * Write the plan. Refuses, writing nothing, while a conflict is not in `allow`, any
 * path runs through a symlink, or any exists only under another letter case. Then
 * generates `.claude/canon-index.md` when it does not exist yet.
 */
export function apply(root, config, { allow = [], ...options } = {}) {
  const steps = plan(root, config, options);
  const links = steps.filter((s) => s.action === 'symlink').map((s) => s.link);
  if (links.length) return { ok: false, symlinks: [...new Set(links)], refused: [], steps };
  const mismatches = steps.filter((s) => s.action === 'case');
  if (mismatches.length) {
    // One line per name to rename, however many files sit below a renamed directory.
    const cases = new Map(mismatches.map(({ wanted, variants }) => [wanted, { wanted, variants }]));
    return { ok: false, cases: [...cases.values()], refused: [], steps };
  }
  const refused = steps.filter((s) => s.action === 'conflict' && !allow.includes(s.path));
  if (refused.length) return { ok: false, refused: refused.map((s) => s.path), steps };

  for (const step of steps) {
    if (['same', 'keep', 'stale', 'leftover'].includes(step.action)) continue;
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
    if (argv === undefined || argv === null) {
      process.stderr.write(
        'scaffold: the answers set no apiKeyCommand, so there is nothing to trust.\n'
      );
      return 1;
    }
    const problem = keyCommandProblem(root, argv);
    if (problem !== null) {
      process.stderr.write(
        `scaffold: tracker.apiKeyCommand ${problem}, so it cannot be approved: an approval\n` +
          'covers the command line, and anything the repository holds can change under it.\n'
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
    process.stdout.write(
      `trusted   ${JSON.stringify(config.formatFile)} for ${root}\n` +
        `For a cloud environment, where this file does not exist, set\n` +
        `${TRUST_FORMAT_VARIABLE}=${commandDigest(config.formatFile)}\n` +
        "in the environment's own settings, never in the repository's.\n"
    );
    return 0;
  }

  let result;
  try {
    result =
      options.mode === 'plan'
        ? plan(root, config, options).map(({ path, action, wanted, variants, content }) => ({
            path,
            action,
            ...(action === 'case' && { wanted, variants }),
            ...(action === 'stale' && { content }),
          }))
        : apply(root, config, options);
  } catch (error) {
    process.stderr.write(`scaffold: ${error.message}\n`);
    return 2;
  }

  if (options.mode === 'plan') {
    const steps = result;
    if (options.json) process.stdout.write(`${JSON.stringify(steps, null, 2)}\n`);
    else
      for (const { path, action, wanted, variants } of steps) {
        const held = variants ? ` (rename ${variants.join(', ')} to ${wanted})` : '';
        process.stdout.write(`${action.padEnd(8)} ${path}${held}\n`);
      }
    return 0;
  }

  if (result.symlinks?.length) {
    process.stderr.write(
      'scaffold: nothing written. These are symlinks, and a write through one lands wherever it\n' +
        `points. Replace each with a real file or directory first:\n${result.symlinks.map((p) => `  ${p}`).join('\n')}\n`
    );
    return 1;
  }
  if (result.cases?.length) {
    const lines = result.cases.map(
      ({ wanted, variants }) => `  ${variants.join(', ')} -> ${wanted}`
    );
    process.stderr.write(
      'scaffold: nothing written. Canon reads these by their exact names, and the project has\n' +
        `them in another letter case. Rename each, or merge it into the one name, first:\n${lines.join('\n')}\n`
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
  const label = {
    same: 'unchanged',
    keep: 'kept',
    stale: 'kept',
    leftover: 'left',
    create: 'created',
    conflict: 'updated',
  };
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
