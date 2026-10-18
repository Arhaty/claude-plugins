#!/usr/bin/env node
/**
 * The project's issue tracker, for the skills. The only tracker client: skills call
 * this and nothing else does.
 *
 *   node tracker.mjs issue <ID>                 the issue, with its status's role
 *   node tracker.mjs comments <ID>              every comment, and whether the owner
 *                                               has answered the open blocked question
 *   node tracker.mjs comment <ID> [--blocked]   post stdin as a comment, marked as canon's
 *   node tracker.mjs set-state <ID> <role>      spec, approved, building or blocked
 *   node tracker.mjs label <ID> +a,-b           add and remove labels
 *   node tracker.mjs states [<team>]            the team's status names, for setup
 *
 * `--config <file>` reads that file instead of `.claude/canon.json`, which is how
 * `/canon:setup` lists a team's statuses before the config exists. Output is JSON on
 * stdout. A failure is one line on stderr and exit 1; a usage error is exit 2.
 *
 * **Roles, not status names.** `.claude/canon.json` maps canon's roles to the
 * team's names, so a skill says `approved` and this sends whatever the team calls
 * it. `staging` and `production` are never set: the tracker's GitHub integration
 * sets them from the merges. `ready` is the owner's.
 *
 * **The API key** comes from the provider's variable in the environment, then from
 * that one key in `.env.local` at the project root, then from
 * `tracker.apiKeyCommand`, which runs only once the owner has approved that exact
 * command for this repository. The key is never printed.
 *
 * **Behind a proxy**, as in a cloud session where the key is a placeholder that an
 * egress proxy swaps for the real one, Node's `fetch` goes direct unless
 * `NODE_USE_ENV_PROXY=1` was set at startup. When `HTTPS_PROXY` is set and the flag
 * is not, this script re-runs itself once with it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_PATH,
  PROVIDERS,
  ROLES,
  isKeyCommandTrusted,
  keyCommandCwd,
  keyCommandProblem,
  loadConfig,
  projectRoot,
  validate,
} from '../hooks/lib/config.mjs';
import { ENDPOINT } from './tracker/linear.mjs';

/** The roles a skill may set. The rest belong to the owner or to the GitHub integration. */
export const SETTABLE = ['spec', 'approved', 'building', 'blocked'];

/**
 * The first line of every comment canon posts: `canon: blocked` on a question for the
 * owner, `canon: note` on anything else (a report, an answer relayed from the session).
 * A comment without it is a person's.
 */
export const MARKER = 'canon:';
export const BLOCKED_MARKER = `${MARKER} blocked`;
export const NOTE_MARKER = `${MARKER} note`;

export class TrackerError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const usage = (message) => new TrackerError(message, 2);

/**
 * Where a blocked issue stands, from its comments alone. The newest comment marked
 * `canon: blocked` is the question; every later comment that carries no `canon:`
 * marker at all is the answer, so a report canon posts after the question never
 * reads as one. Who wrote a comment is never read: with the owner's own key, canon's
 * comments and the owner's replies come from the same user.
 */
export function blockedState(comments) {
  const first = (comment) => comment.body.trimStart();
  const at = comments.findLastIndex((comment) => first(comment).startsWith(BLOCKED_MARKER));
  if (at === -1) return null;
  return {
    question: comments[at],
    answers: comments.slice(at + 1).filter((comment) => !first(comment).startsWith(MARKER)),
  };
}

/** The host the requests go to, for matching `NO_PROXY`. */
const HOST = new URL(ENDPOINT).hostname;

/** Can this Node send `fetch` through `HTTPS_PROXY`? From 22.21 and 24.5, with the flag. */
export function nodeHasEnvProxy(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

/**
 * Does `NO_PROXY` send `host` direct? Node's rules: `*`, the host, or a domain it
 * is under, each with an optional port.
 */
export function noProxyCovers(host, noProxy = '') {
  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const [name, port] = entry.toLowerCase().split(':');
      if (port && port !== '443') return false;
      const domain = name.replace(/^\*?\./, '');
      return host === domain || host.endsWith(`.${domain}`);
    });
}

/**
 * How a request to the tracker would leave: `none` with no proxy set, `on` through
 * it, and otherwise why not: `exempt` by `NO_PROXY`, `unsupported` by this Node, or
 * `off` for want of `NODE_USE_ENV_PROXY=1`.
 */
export function proxyRoute(env, version = process.versions.node) {
  if (!(env.HTTPS_PROXY || env.https_proxy)) return 'none';
  if (noProxyCovers(HOST, env.NO_PROXY ?? env.no_proxy)) return 'exempt';
  if (!nodeHasEnvProxy(version)) return 'unsupported';
  return env.NODE_USE_ENV_PROXY === '1' ? 'on' : 'off';
}

/**
 * Re-run this script through the proxy when Node would skip it, and return the
 * child's exit status; `null` means carry on here. The flag is read only at
 * startup, so nothing in-process can turn it on. Any value of it already set,
 * including the child's own, means no second run.
 */
export function relaunchThroughProxy(
  argv,
  { env = process.env, version = process.versions.node, spawn = spawnSync, script = self } = {}
) {
  if (env.NODE_USE_ENV_PROXY !== undefined || proxyRoute(env, version) !== 'off') return null;
  const child = spawn(
    process.execPath,
    // The proxy agent is experimental on some versions, and says so on every run.
    [...process.execArgv, '--disable-warning=UNDICI-EHPA', script, ...argv],
    { env: { ...env, NODE_USE_ENV_PROXY: '1' }, stdio: 'inherit' }
  );
  if (child.error)
    throw new TrackerError(`could not re-run through the proxy: ${child.error.message}`);
  return child.status ?? 1;
}

/** Where each key source is, and what to change there. */
const KEY_SOURCES = {
  env: 'the environment',
  file: '.env.local at the project root',
  command: 'the output of tracker.apiKeyCommand',
};

/**
 * Why the tracker answered 401, from where the key came from and how the request
 * left. Names the source, never the key.
 */
export function unauthorized({ variable, source, placeholder, env, version }) {
  const route = proxyRoute(env, version);
  if (placeholder && !['none', 'on'].includes(route)) {
    const fix = {
      off: 'Run it with NODE_USE_ENV_PROXY=1 set.',
      exempt: `NO_PROXY covers ${HOST}: take it out.`,
      unsupported: `Node ${version} cannot: use Node 22.21, 24.5 or later.`,
    }[route];
    return (
      `Linear returned HTTP 401: ${variable} is a placeholder the HTTPS proxy replaces on ` +
      `the way out, and Node is not sending the request through the proxy. ${fix}`
    );
  }
  return (
    `Linear returned HTTP 401: it rejected the ${variable} from ${KEY_SOURCES[source]}. ` +
    'Change it there.'
  );
}

/** The value of one key in a dotenv file, or `null`. Reads that key and nothing else. */
export function envFileValue(text, name) {
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1] !== name) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    return value.trim() || null;
  }
  return null;
}

/**
 * The API key, from the first source that has one. `run` executes the approved
 * command, injected so a test never runs a real one.
 */
export function resolveKey(options) {
  return findKey(options).key;
}

/** The key and its source: `env`, `file` or `command`. */
function findKey({ root, tracker, variable, env = process.env, run = runCommand }) {
  const fromEnv = env[variable]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };

  // A `.env.local` the repository commits is the repository's choice of key, not the
  // owner's, and would send canon's comments to whatever workspace it names.
  const file = join(root, '.env.local');
  const committed = existsSync(file) && tracked(root, '.env.local');
  if (existsSync(file) && !committed) {
    const fromFile = envFileValue(readFileSync(file, 'utf8'), variable);
    if (fromFile) return { key: fromFile, source: 'file' };
  }

  const command = tracker?.apiKeyCommand;
  if (Array.isArray(command)) {
    const problem = keyCommandProblem(root, command);
    if (problem !== null) {
      throw new TrackerError(
        `tracker.apiKeyCommand ${problem}, so it was not run: an approval covers the command ` +
          'line, and anything the repository holds can change under it. Point it at a program ' +
          'outside the repository.'
      );
    }
    if (!isKeyCommandTrusted(root, command)) {
      throw new TrackerError(
        `tracker.apiKeyCommand ${JSON.stringify(command)} is not approved for this repository, ` +
          'so it was not run. Run /canon:setup to approve it, or set ' +
          `${variable} in the environment or in .env.local.`
      );
    }
    const fromCommand = run(command).trim();
    if (fromCommand) return { key: fromCommand, source: 'command' };
    throw new TrackerError(`tracker.apiKeyCommand printed nothing, so there is no ${variable}.`);
  }

  throw new TrackerError(
    `No ${variable}: set it in the environment or in .env.local at the project root, ` +
      'or configure tracker.apiKeyCommand with /canon:setup.' +
      (committed ? ' The .env.local here is committed to the repository, so it was not read.' : '')
  );
}

/** Does git track `path` in `root`? A repository that is not one tracks nothing. */
function tracked(root, path) {
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', path], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the key command with no shell, nothing on stdin, and from the home directory,
 * so a relative path in it never resolves into the repository. Its output is never
 * echoed.
 */
function runCommand(argv) {
  try {
    return execFileSync(argv[0], argv.slice(1), {
      cwd: keyCommandCwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    });
  } catch (error) {
    throw new TrackerError(
      error?.code === 'ENOENT'
        ? `tracker.apiKeyCommand: ${argv[0]} is not installed.`
        : `tracker.apiKeyCommand failed. Run it by hand to see why: ${argv.join(' ')}`
    );
  }
}

/** The status name for `role`, and the role for a status name. */
export function roleOf(tracker, state) {
  return ROLES.find((role) => tracker.statuses[role] === state) ?? null;
}

/**
 * The tracker block to work with. A full config must be valid. For `states` alone,
 * a partial one is enough: setup asks for the statuses after listing them.
 */
function loadTracker(root, configFile, partial) {
  let config;
  if (configFile) {
    try {
      config = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (error) {
      throw new TrackerError(`cannot read ${configFile}: ${error.message}`);
    }
  } else {
    const state = loadConfig(root);
    if (state.status === 'invalid') {
      throw new TrackerError(`${CONFIG_PATH} is invalid:\n  - ${state.errors.join('\n  - ')}`);
    }
    config = state.status === 'ok' ? state.config : null;
  }
  const tracker = config?.tracker;
  if (!tracker) {
    if (partial) return null;
    throw new TrackerError(`${CONFIG_PATH} sets no tracker. Run /canon:setup to add one.`);
  }
  if (!partial && configFile) {
    delete config.$schema;
    const errors = validate(config);
    if (errors.length)
      throw new TrackerError(`${configFile} is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  if (!PROVIDERS.includes(tracker.provider)) {
    throw new TrackerError(`tracker.provider must be one of: ${PROVIDERS.join(', ')}`);
  }
  return tracker;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** `client` with every method's failure passed through `explain`. */
function explainUnauthorized(client, explain) {
  return Object.fromEntries(
    Object.entries(client).map(([name, method]) => [
      name,
      (...args) =>
        method(...args).catch((error) => {
          throw explain(error);
        }),
    ])
  );
}

/** Run one command and return what to print. */
export async function main(
  argv,
  { cwd = process.cwd(), env = process.env, fetch, stdin, version = process.versions.node } = {}
) {
  const args = [...argv];
  let configFile = null;
  const at = args.indexOf('--config');
  if (at !== -1) {
    configFile = args[at + 1];
    if (!configFile) throw usage('--config needs a file');
    args.splice(at, 2);
  }
  const [command, ...rest] = args;
  const known = ['issue', 'comments', 'comment', 'set-state', 'label', 'states'];
  if (!known.includes(command)) {
    throw usage(`unknown command '${command ?? ''}'. Expected one of: ${known.join(', ')}`);
  }

  const root = projectRoot({ cwd }, env);
  let tracker = loadTracker(root, configFile && resolve(cwd, configFile), command === 'states');
  if (command === 'states') {
    const team = rest.find((arg) => !arg.startsWith('--'))?.toUpperCase() ?? tracker?.team;
    if (!team || !/^[A-Z0-9]+$/.test(team)) throw usage('states needs a team key, e.g. states ABC');
    tracker = { provider: 'linear', ...tracker, team };
  }

  const flags = rest.filter((arg) => arg.startsWith('--'));
  const words = rest.filter((arg) => !arg.startsWith('--'));
  const allowed = command === 'comment' ? ['--blocked'] : [];
  const unknown = flags.filter((flag) => !allowed.includes(flag));
  if (unknown.length) throw usage(`${command} does not take ${unknown.join(' ')}`);
  const id = () => {
    if (!words[0]) throw usage(`${command} needs an issue identifier, e.g. ${tracker.team}-123`);
    return words[0];
  };
  // Everything argv alone can get wrong, before a key command runs or a request leaves.
  if (command !== 'states') id();
  if (command === 'set-state' && !ROLES.includes(words[1])) {
    throw usage(`set-state needs a role: ${SETTABLE.join(', ')}`);
  }
  if (command === 'label' && !words[1]) {
    throw usage('label needs changes, e.g. label ABC-1 +domain-auth,-domain-old');
  }
  if (command === 'comment' && words.length > 1) {
    throw usage(`comment takes its body on stdin, not as ${words.slice(1).join(' ')}`);
  }

  const provider = await import(`./tracker/${tracker.provider}.mjs`);
  // A provider with no key variable, the fixture, reads no key.
  const variable = provider.KEY_VARIABLE;
  const found = variable === null ? null : findKey({ root, tracker, variable, env });
  const client = explainUnauthorized(
    provider.createClient({
      apiKey: found?.key ?? null,
      root,
      team: tracker.team,
      ...(fetch ? { fetch } : {}),
    }),
    // Only this side knows where the key came from and how the request left.
    (error) => {
      if (error?.status !== 401 || !found) return error;
      const placeholder = provider.looksLikeKey?.(found.key) === false;
      return new TrackerError(
        unauthorized({ variable, source: found.source, placeholder, env, version })
      );
    }
  );

  switch (command) {
    case 'issue': {
      const issue = await client.issue(id());
      return { ...issue, role: roleOf(tracker, issue.state) };
    }
    case 'comments': {
      const comments = await client.comments(id());
      return { comments, blocked: blockedState(comments) };
    }
    case 'comment': {
      const identifier = id();
      const extra = words.slice(1);
      if (extra.length) throw usage(`comment takes its body on stdin, not as ${extra.join(' ')}`);
      const body = (stdin ?? (await readStdin())).trim();
      if (!body) throw usage('comment needs a body on stdin');
      const marker = flags.includes('--blocked') ? BLOCKED_MARKER : NOTE_MARKER;
      const text = body.startsWith(marker) ? body : `${marker}\n\n${body}`;
      await client.comment(identifier, text);
      return { ok: true };
    }
    case 'set-state': {
      const identifier = id();
      const role = words[1];
      if (!ROLES.includes(role)) {
        throw usage(`set-state needs a role: ${SETTABLE.join(', ')}`);
      }
      if (!SETTABLE.includes(role)) {
        throw new TrackerError(
          role === 'ready'
            ? "Refusing to set ready: moving an issue back to ready is the owner's call."
            : `Refusing to set ${role}: the tracker's GitHub integration sets it when the pull ` +
                'request merges, and a status set by hand hides a merge that did not move it.'
        );
      }
      await client.setState(identifier, tracker.statuses[role]);
      return { ok: true, role, state: tracker.statuses[role] };
    }
    case 'label': {
      const identifier = id();
      if (!words[1]) throw usage('label needs changes, e.g. label ABC-1 +domain-auth,-domain-old');
      const changes = words[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      const add = changes.filter((name) => !name.startsWith('-')).map((n) => n.replace(/^\+/, ''));
      const remove = changes.filter((name) => name.startsWith('-')).map((n) => n.slice(1));
      const both = add.filter((name) => remove.includes(name));
      if (both.length) throw usage(`label adds and removes ${both.join(', ')} at once`);
      return client.label(identifier, add, remove);
    }
    case 'states': {
      const states = await client.states();
      return states.map(({ name, type }) => ({ name, type }));
    }
  }
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  const status = relaunchThroughProxy(process.argv.slice(2));
  if (status !== null) process.exit(status);
  main(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`tracker: ${error?.message ?? error}\n`);
      process.exitCode = error instanceof TrackerError ? error.code : 1;
    });
}
