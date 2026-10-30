/**
 * Where the project is, and what `.claude/canon.json` says about it.
 *
 * Every hook and script reads the project through this module, so nothing else
 * hardcodes a branch, a command or a name. `/canon:setup` writes the file; the
 * schema that documents each field is `templates/canon.schema.json`.
 *
 * **A project that never adopted canon is left alone.** The plugin can be installed
 * at user scope, which runs its hooks in every repository on the machine. A
 * repository with neither `.claude/canon.json` nor `docs/canon/` is `absent`, and
 * every hook exits 0 there in silence. A repository with `docs/canon/` but no
 * config is `missing`: it adopted the workflow and lost the file, so the guards
 * refuse until `/canon:setup` restores it rather than guessing which branch is
 * production.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const CONFIG_PATH = '.claude/canon.json';
export const DOMAINS_PATH = '.claude/canon-domains.json';

const COMMANDS = ['typecheck', 'lint', 'format', 'test'];
const URLS = ['preview', 'staging', 'production'];
const TOP = [
  '$schema',
  'version',
  'owner',
  'branches',
  'packageManager',
  'commands',
  'formatFile',
  'urls',
  'tracker',
  'ci',
];
const BRANCHES = ['integration', 'production', 'prefixes', 'naming', 'deleteAfterMerge'];
const NAMINGS = ['prefix', 'tracker'];
const TRACKER = ['provider', 'team', 'statuses', 'labelPrefix', 'apiKeyCommand'];
const CI = ['workflow', 'baseInput'];

/**
 * The issue trackers a `tracker` block may name. One module each in `scripts/tracker/`.
 * `fixture` is a tracker held in a file in the project, for tests and evals.
 */
export const PROVIDERS = ['linear', 'fixture'];

/**
 * canon's lifecycle roles, which `tracker.statuses` maps to the team's own status
 * names. Each names somewhere the work can be: waiting for a spec, being specced,
 * approved, being built, waiting on the owner, merged into the integration branch,
 * merged into production.
 */
export const ROLES = ['ready', 'spec', 'approved', 'building', 'blocked', 'staging', 'production'];

/**
 * A key the schema does not name, at any level, as an error per key. The schema sets
 * `additionalProperties: false` throughout, and a typo such as `formatfile` would
 * otherwise validate here and silently mean `null` to every reader.
 */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function unknownKeys(object, known, prefix) {
  if (!isObject(object)) return [];
  return Object.keys(object)
    .filter((key) => !known.includes(key))
    .map((key) => `\`${prefix}${key}\` is not a known key`);
}

/**
 * Resolve symlinks on both sides before comparing paths. A file not yet written
 * resolves through its nearest existing ancestor, so a new file under a symlinked
 * checkout (macOS `/var` is `/private/var`) is still inside the project.
 */
export function canonical(path) {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(canonical(parent), basename(full));
  }
}

/**
 * The first part of `path`, relative to `root`, that is a symlink a write must not
 * follow, or `null`. A link that resolves inside the project is fine: `CLAUDE.md ->
 * AGENTS.md` is a common setup and a write through it lands in the project. A
 * dangling link, or one that resolves outside `realpath(root)`, is refused: a
 * cloned repository can aim one anywhere, and `.claude -> ~/.ssh` would turn a
 * scaffold into a write to the user's keys.
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
  for (const part of path.split(/[\\/]+/).filter(Boolean)) {
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
 * The project's root: `$CLAUDE_PROJECT_DIR` when Claude Code sets it, else the
 * work tree that holds the payload's `cwd`, else the process's own directory. `env`
 * is the environment to read it from, the process's unless a caller passes its own.
 */
export function projectRoot(payload, env = process.env) {
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  if (fromEnv && existsSync(fromEnv)) return canonical(fromEnv);
  const cwd = typeof payload?.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : '.';
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) return canonical(top);
  } catch {
    // Not a git work tree. The cwd is the best answer left.
  }
  return canonical(cwd);
}

/** Every problem with a parsed config, as readable lines. Empty means valid. */
export function validate(config) {
  const errors = [];
  const isText = (value) => typeof value === 'string' && value.trim() !== '';
  const textOrNull = (value) => value === null || isText(value);

  if (!isObject(config)) {
    return ['the file is not a JSON object'];
  }
  errors.push(
    ...unknownKeys(config, TOP, ''),
    ...unknownKeys(config.branches, BRANCHES, 'branches.'),
    ...unknownKeys(config.commands, COMMANDS, 'commands.'),
    ...unknownKeys(config.urls, URLS, 'urls.'),
    ...unknownKeys(config.tracker, TRACKER, 'tracker.'),
    ...unknownKeys(config.tracker?.statuses, ROLES, 'tracker.statuses.'),
    ...unknownKeys(config.ci, CI, 'ci.')
  );
  if (config.version !== 1) errors.push('`version` must be 1');
  if (!isText(config.owner)) errors.push('`owner` must be a non-empty string');

  const branches = config.branches ?? {};
  if (!isText(branches.integration)) errors.push('`branches.integration` must be a branch name');
  if (!isText(branches.production)) errors.push('`branches.production` must be a branch name');
  if (isText(branches.integration) && branches.integration === branches.production) {
    errors.push('`branches.integration` and `branches.production` must differ');
  }
  if (branches.naming !== undefined && !NAMINGS.includes(branches.naming)) {
    errors.push(`\`branches.naming\` must be one of: ${NAMINGS.join(', ')}`);
  }
  const byTracker = branches.naming === 'tracker';
  if (byTracker && !('tracker' in config)) {
    errors.push(
      '`branches.naming` "tracker" needs a `tracker` block, whose issues name the branches'
    );
  }
  // With tracker naming the prefixes go unused, so they may be left out; given, they still parse.
  if (
    !(byTracker && !('prefixes' in branches)) &&
    (!Array.isArray(branches.prefixes) ||
      branches.prefixes.length === 0 ||
      !branches.prefixes.every((p) => isText(p) && /^[a-z0-9-]+$/.test(p)))
  ) {
    errors.push('`branches.prefixes` must be a non-empty list of lowercase prefixes');
  }
  if (branches.deleteAfterMerge !== undefined && typeof branches.deleteAfterMerge !== 'boolean') {
    errors.push('`branches.deleteAfterMerge` must be true or false, or left out');
  }

  if (!isText(config.packageManager)) errors.push('`packageManager` must be a non-empty string');

  const commands = config.commands;
  if (commands === null || typeof commands !== 'object') {
    errors.push('`commands` must be an object');
  } else {
    for (const name of COMMANDS) {
      if (!(name in commands) || !textOrNull(commands[name])) {
        errors.push(`\`commands.${name}\` must be a command string or null`);
      }
    }
  }

  const formatFile = config.formatFile;
  if (
    formatFile !== null &&
    !(Array.isArray(formatFile) && formatFile.length > 0 && formatFile.every(isText))
  ) {
    errors.push('`formatFile` must be a non-empty list of argv strings, or null');
  }

  // Optional, and so is each URL in it: left out is null.
  const urls = config.urls;
  if (!('urls' in config)) {
    // Nothing served anywhere, or nothing worth quoting.
  } else if (!isObject(urls)) {
    errors.push('`urls` must be an object, or left out');
  } else {
    for (const name of URLS) {
      if (name in urls && !textOrNull(urls[name])) {
        errors.push(`\`urls.${name}\` must be a URL string or null`);
      }
    }
    if (isText(urls.preview) && !urls.preview.includes('{branch}')) {
      errors.push('`urls.preview` must contain `{branch}`');
    }
  }

  if ('tracker' in config) errors.push(...trackerErrors(config.tracker, isText));
  if ('ci' in config) errors.push(...ciErrors(config.ci));
  return errors;
}

/**
 * Problems with the optional `ci` block. Absent means `/canon:staging` only waits for
 * CI; set, it starts the workflow on a head commit nothing has run on.
 */
function ciErrors(ci) {
  if (!isObject(ci)) {
    return ['`ci` must be an object, or left out'];
  }
  const errors = [];
  if (typeof ci.workflow !== 'string' || !/^[\w.-]+\.ya?ml$/.test(ci.workflow)) {
    errors.push('`ci.workflow` must be a workflow file name, e.g. "ci.yml"');
  }
  if (
    ci.baseInput !== null &&
    !(typeof ci.baseInput === 'string' && /^[A-Za-z_][\w-]*$/.test(ci.baseInput))
  ) {
    errors.push('`ci.baseInput` must be the name of a workflow_dispatch input, or null');
  }
  return errors;
}

/**
 * Problems with the optional `tracker` block. Absent means no tracker, and the spec's
 * `**Status:**` line is the gate, as it always was.
 */
function trackerErrors(tracker, isText) {
  if (!isObject(tracker)) {
    return ['`tracker` must be an object, or left out'];
  }
  const errors = [];
  if (!PROVIDERS.includes(tracker.provider)) {
    errors.push(`\`tracker.provider\` must be one of: ${PROVIDERS.join(', ')}`);
  }
  if (!isText(tracker.team) || !/^[A-Z0-9]+$/.test(tracker.team)) {
    errors.push('`tracker.team` must be the team key in capitals, e.g. "ABC"');
  }
  const statuses = tracker.statuses;
  if (!isObject(statuses)) {
    errors.push('`tracker.statuses` must map each role to a status name');
  } else {
    for (const role of ROLES) {
      if (!isText(statuses[role])) {
        errors.push(`\`tracker.statuses.${role}\` must be a status name`);
      }
    }
    const names = ROLES.map((role) => statuses[role]).filter(isText);
    const repeated = names.filter((name, i) => names.indexOf(name) !== i);
    if (repeated.length) {
      errors.push(
        `\`tracker.statuses\` must name a different status for each role; repeated: ${[...new Set(repeated)].join(', ')}`
      );
    }
  }
  if (
    'labelPrefix' in tracker &&
    !(isText(tracker.labelPrefix) && /^[a-z0-9][a-z0-9-]*$/.test(tracker.labelPrefix))
  ) {
    errors.push('`tracker.labelPrefix` must be a lowercase prefix, e.g. "domain-"');
  }
  const command = tracker.apiKeyCommand;
  if (command !== undefined && command !== null) {
    const problem = keyCommandShape(command);
    if (problem) errors.push(`\`tracker.apiKeyCommand\` ${problem}, or null`);
  }
  return errors;
}

/**
 * What is wrong with the shape of a key command, or `null`. One rule, read by
 * `validate` and by setup's approval. The program is a bare name, found on `PATH`,
 * or an absolute path: a relative one would resolve wherever the command runs.
 */
export function keyCommandShape(argv) {
  const isText = (value) => typeof value === 'string' && value.trim() !== '';
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(isText)) {
    return 'must be a non-empty list of argv strings';
  }
  if (argv[0].includes('/') && !argv[0].startsWith('/')) {
    return 'must start with a program name or an absolute path, not a relative path';
  }
  return null;
}

/**
 * The config as the skills read it: every optional setting that is left out, filled in with
 * what leaving it out means, so a skill never has to know which keys may be absent.
 */
export function withDefaults(config) {
  return {
    ...config,
    urls: Object.fromEntries(URLS.map((name) => [name, config.urls?.[name] ?? null])),
  };
}

/**
 * The project's canon state:
 *
 * - `{ status: 'absent' }`: no config and no `docs/canon/`. Not a canon project.
 * - `{ status: 'missing' }`: `docs/canon/` exists, the config does not.
 * - `{ status: 'invalid', errors }`: the config cannot be parsed or fails validation.
 * - `{ status: 'ok', config }`.
 */
export function loadConfig(root) {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) {
    return existsSync(join(root, 'docs/canon')) ? { status: 'missing' } : { status: 'absent' };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { status: 'invalid', errors: [`it is not valid JSON (${error.message})`] };
  }
  const errors = validate(config);
  return errors.length ? { status: 'invalid', errors } : { status: 'ok', config };
}

/** The refusal text for a project whose config is `missing` or `invalid`. */
export function configProblem(state, hook) {
  const what =
    state.status === 'missing'
      ? `This project has docs/canon/ but no ${CONFIG_PATH}.`
      : `${CONFIG_PATH} is invalid:\n${state.errors.map((e) => `  - ${e}`).join('\n')}`;
  return (
    `canon: ${hook} cannot run. ${what}\n\n` +
    'Run /canon:setup to write or repair it. The canon hooks read the branch names and\n' +
    'commands from that file and will not guess them.'
  );
}

/**
 * Where the owner's approvals of each project's commands are kept, `formatFile` and
 * `tracker.apiKeyCommand`, each approved on its own: in their home
 * directory, outside every repository. A record inside the repository proves
 * nothing, because whoever commits the command can commit the approval beside it.
 *
 * The home directory comes from the account, not from `$HOME`, which a project's
 * settings can set for the session and so point at a file the repository holds.
 */
export const trustFile = () => join(userInfo().homedir, '.claude', 'canon', 'trusted.json');

/** The sha256 of an argv list, which is what an approval records. */
export function commandDigest(argv) {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}

function readTrust() {
  try {
    const trusted = JSON.parse(readFileSync(trustFile(), 'utf8'));
    return trusted !== null && typeof trusted === 'object' && !Array.isArray(trusted)
      ? trusted
      : {};
  } catch {
    return {};
  }
}

/**
 * What an approval is keyed by: the repository's git directory, resolved to an
 * absolute path through any symlink. Every worktree of one clone shares it, so
 * they share one approval; a second clone has its own, and is asked again. A
 * project that is not a git repository is keyed by its root.
 */
export function trustKey(root) {
  try {
    const common = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (common) return canonical(resolve(root, common));
  } catch {
    // Not a git repository.
  }
  return canonical(root);
}

/** This repository's entry in the trust file, as an object, empty when there is none. */
function entryFor(trusted, key) {
  const entry = trusted[key];
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
}

function writeTrust(trusted) {
  const file = trustFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(trusted, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The environment variable that approves a `formatFile` where no trust file can exist: a fresh
 * cloud container. Its value is the command's digest, set in the cloud environment's own
 * settings, outside the repository.
 */
export const TRUST_FORMAT_VARIABLE = 'CANON_TRUST_FORMAT_SHA256';

/**
 * Whether the project's own settings set `name` in their `env` block. Claude Code applies that
 * block to the session, so a repository could approve its own command there: such a value is not
 * an approval. Both files are read, the committed one and the local one, since nothing stops a
 * repository committing the local one too. Unreadable counts as setting it.
 */
export function projectSetsEnv(root, name) {
  for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    try {
      const env = JSON.parse(readFileSync(path, 'utf8'))?.env;
      if (env !== null && typeof env === 'object' && name in env) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Has the owner approved exactly this `formatFile` for this repository? Keyed by
 * `trustKey` and the command's digest, so a changed command, or the same command
 * in another clone, is not approved until setup asks again. Or, where there is no
 * trust file, `CANON_TRUST_FORMAT_SHA256` in `env` names this command's digest, and
 * the project's own settings do not set it.
 */
export function isTrusted(root, argv, env = process.env) {
  const digest = entryFor(readTrust(), trustKey(root)).sha256;
  if (typeof digest === 'string' && digest === commandDigest(argv)) return true;
  const approved = env[TRUST_FORMAT_VARIABLE];
  return (
    typeof approved === 'string' &&
    approved.trim().toLowerCase() === commandDigest(argv) &&
    !projectSetsEnv(root, TRUST_FORMAT_VARIABLE)
  );
}

/**
 * Record the owner's approval of `argv` as `formatFile` for `root`, replacing any
 * earlier one and keeping the key command's.
 */
export function trust(root, argv) {
  const trusted = readTrust();
  const key = trustKey(root);
  trusted[key] = { ...entryFor(trusted, key), sha256: commandDigest(argv), formatFile: argv };
  writeTrust(trusted);
}

/**
 * Has the owner approved exactly this `tracker.apiKeyCommand` for this repository?
 * Approved on its own: approving the formatter says nothing about it, or the other
 * way round. The argv list itself is recorded and compared, as `apiKeyCommand` in
 * the repository's entry; a changed command is not approved until setup asks again.
 */
export function isKeyCommandTrusted(root, argv) {
  const recorded = entryFor(readTrust(), trustKey(root)).apiKeyCommand;
  return Array.isArray(recorded) && JSON.stringify(recorded) === JSON.stringify(argv);
}

/**
 * Where a key command runs: the account's home directory, never the repository, so a
 * relative path in an argument cannot reach a file the repository holds.
 */
export const keyCommandCwd = () => userInfo().homedir;

/**
 * Why a key command may not run against `root`, or `null`. An approval covers the
 * command line; a file the repository holds can change under it in any commit. So
 * the command runs outside the repository (`keyCommandCwd`), and is refused when any
 * word names the repository's own path, as written or through a symlink, in a path,
 * a `--flag=path` or a shell string. Recognising every way an argv list could reach
 * a file is a list with no end; keeping the command out of the repository is not.
 */
export function keyCommandProblem(root, argv) {
  const shape = keyCommandShape(argv);
  if (shape) return shape;
  const roots = [...new Set([resolve(root), canonical(root)])];
  const under = (path) => roots.some((base) => path === base || path.startsWith(base + sep));
  // Every absolute path in a word, standing alone, after `--flag=` or inside a shell
  // string, resolved through symlinks and aliases such as macOS's `/var`.
  const paths = (word) => word.split(/[\s=:;|&'"()]+/).filter((part) => part.startsWith('/'));
  for (const word of argv) {
    const hit =
      roots.some((base) => word.includes(base)) || paths(word).some((p) => under(canonical(p)));
    if (hit) return `names this repository's path (${word})`;
  }
  return null;
}

/** Record the owner's approval of `argv` as `tracker.apiKeyCommand` for `root`. */
export function trustKeyCommand(root, argv) {
  const trusted = readTrust();
  const key = trustKey(root);
  trusted[key] = { ...entryFor(trusted, key), apiKeyCommand: argv };
  writeTrust(trusted);
}

/**
 * How feature branches are named, for the hooks' messages and the CLAUDE.md section: `rule`
 * says it in a sentence, `example` is one name in the configured form.
 */
export function branchNaming(config) {
  const { branches, tracker } = config;
  if (branches.naming === 'tracker') {
    const example = `${tracker.team.toLowerCase()}-123-short-description`;
    return {
      rule: `Branch names are the tracker issue's own branch name, verbatim, e.g. \`${example}\``,
      example,
    };
  }
  const prefixes = branches.prefixes.map((p) => `\`${p}/\``).join(', ');
  return {
    rule: `Branch names take one of these prefixes and a kebab-case description: ${prefixes}`,
    example: `${branches.prefixes[0]}/short-description`,
  };
}

/** Read and parse a hook's stdin payload. `null` when it is not JSON. */
export async function readPayload() {
  try {
    return JSON.parse(await new Response(process.stdin).text());
  } catch {
    return null;
  }
}
