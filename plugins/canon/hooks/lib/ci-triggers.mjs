/**
 * Which commands start a CI run in this project?
 *
 * `ci-watch.sh` asks this before it polls. Once `.claude/canon.json` has a `ci` block, it reads
 * the `on:` triggers of every workflow in the checkout's `.github/workflows/`, not only the one
 * `ci.workflow` names: the watcher reports a failure in any run on the commit, so a lint
 * workflow left on the default types still counts when `ci.yml` has trimmed them. It prints the
 * union as words: `push` when a push to the branch starts a run, `push-tag` when a tag push
 * does, then the activity types of `pull_request`. `decide` turns them
 * into what the command started.
 *
 * GitHub's defaults, `opened synchronize reopened`, stand in for what it cannot read: no `ci`
 * block, no `ci.workflow` file, or a file in a shape this narrow reader does not know. A wrong
 * guess there costs a quiet minute of polling; guessing "nothing" would leave a red run
 * unwatched. A file it reads that runs on other events only, such as a release on `push: tags`
 * or a `workflow_dispatch`, adds nothing, unless no file has a push or pull request trigger at
 * all.
 *
 * `paths` filters and a pull request's `branches` are not read. They can only make a run less
 * likely, and reading them takes a diff or a `gh` call; a needless minute of polling beats a
 * missed run.
 *
 * Not a YAML parser. It reads the shapes GitHub documents for `on:` and nothing else:
 *
 *   on: pull_request
 *   on: [push, pull_request]
 *   on:
 *     push:
 *       branches: [staging]    # flow or block list; `branches-ignore`, `tags` too
 *     pull_request:            # no `types`: the defaults
 *       types: [opened, ready_for_review]
 *       types:                 # or a block list
 *         - opened
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_PATH, loadConfig } from './config.mjs';
import { prCalls } from './merge-command.mjs';

export const DEFAULT_TYPES = Object.freeze(['opened', 'synchronize', 'reopened']);

/** The defaults: a pull request trigger with GitHub's activity types, and no push. */
export const DEFAULTS = Object.freeze({ push: null, types: DEFAULT_TYPES, any: true });

// `pull_request_target` is left out: its runs are on the base branch's commit, which the
// watcher, looking for runs on the pull request's head, would never find.
const PR_EVENTS = new Set(['pull_request']);
const PUSH_FILTERS = ['branches', 'branches-ignore', 'tags', 'tags-ignore'];

/** Thrown for a shape outside the ones above; the caller falls back to the defaults. */
class Unknown extends Error {}

const unquote = (word) => word.trim().replace(/^(["'])(.*)\1$/, '$2');

/** `[a, b]` as its words. */
function flowList(text) {
  const match = /^\[(.*)\]$/.exec(text.trim());
  if (!match) throw new Unknown();
  return match[1].split(',').map(unquote).filter(Boolean);
}

/** One word, or the words of a flow list. `pattern` allows the glob characters of a filter. */
function words(text, pattern = /^[\w-]+$/) {
  const value = text.trim();
  const out = value.startsWith('[') ? flowList(value) : [unquote(value)];
  if (out.some((word) => !pattern.test(word))) throw new Unknown();
  return out;
}

const NAME = /^[\w-]+$/;
// Any filter word: one that names no real ref, such as one with a space, just never matches.
const GLOB = /^[^,'"]+$/;

/** A line without its comment: a `#` at the start or after a space, outside quotes. */
function uncomment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Lines with comments and blank lines gone, each with its indent. A tab is not YAML indent, but
 * one in a `run:` script elsewhere in the file is no business of this reader's: `tab` marks the
 * line, and only a tab under `on:` makes the file unreadable.
 */
function lines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => uncomment(line).trimEnd())
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const indent = /^ */.exec(line)[0].length;
      return { indent, text: line.slice(indent), tab: line[indent] === '\t' };
    });
}

/** The lines under the one at `at`, up to the next at its indent or shallower. */
function block(all, at) {
  const out = [];
  for (let i = at + 1; i < all.length && all[i].indent > all[at].indent; i++) out.push(all[i]);
  return out;
}

const KEY = /^(["']?)([\w-]+)\1\s*:(?:\s+(.*))?$/;

/** The list under `key` in a mapping's lines, or `undefined` when the key is not there. */
function listUnder(body, key, pattern) {
  if (body.length === 0) return undefined;
  const depth = body[0].indent;
  const at = body.findIndex((line) => line.indent === depth && KEY.exec(line.text)?.[2] === key);
  if (at === -1) return undefined;
  const value = KEY.exec(body[at].text)[3];
  if (value) return words(value, pattern);
  // A block list sits under the key or level with it, YAML allows both.
  const items = [];
  for (let i = at + 1; i < body.length && body[i].indent >= depth; i++) {
    const item = /^-\s+(.*)$/.exec(body[i].text);
    if (!item) {
      if (body[i].indent === depth) break;
      throw new Unknown();
    }
    items.push(...words(item[1], pattern));
  }
  if (items.length === 0) throw new Unknown();
  return items;
}

/** A push trigger's branch filters, from the lines under `push:`. */
function pushFilters(body) {
  const filters = {};
  for (const key of PUSH_FILTERS) filters[key] = listUnder(body, key, GLOB);
  return filters;
}

/**
 * The triggers in one workflow file's text: `{ push, types, any }`. `push` is `null` when a
 * push starts nothing, else its branch filters; `types` is empty when no pull request event is
 * a trigger; `any` says a push or pull request trigger was there at all. An unknown shape is
 * the defaults; this throws nothing.
 */
export function parseTriggers(text) {
  try {
    const all = lines(text);
    const at = all.findIndex((line) => line.indent === 0 && KEY.exec(line.text)?.[2] === 'on');
    if (at === -1) throw new Unknown();
    const value = KEY.exec(all[at].text)[3];
    const triggers = new Map();
    if (value) {
      for (const name of words(value)) triggers.set(name, []);
    } else {
      const body = block(all, at);
      if (body.length === 0 || body.some((line) => line.tab)) throw new Unknown();
      const depth = body[0].indent;
      for (let i = 0; i < body.length; i++) {
        const line = body[i];
        if (line.indent !== depth) continue;
        const item = /^-\s+(.*)$/.exec(line.text);
        if (item) {
          for (const name of words(item[1])) triggers.set(name, []);
          continue;
        }
        const key = KEY.exec(line.text);
        if (!key) throw new Unknown();
        const [, , name, inline] = key;
        // Another event's settings are not this reader's business, whatever their shape.
        if (name !== 'push' && !PR_EVENTS.has(name)) continue;
        if (inline && !/^(null|~|\{\s*\})$/.test(inline)) throw new Unknown();
        triggers.set(name, block(body, i));
      }
    }
    const types = new Set();
    for (const event of PR_EVENTS) {
      if (!triggers.has(event)) continue;
      for (const type of listUnder(triggers.get(event), 'types', NAME) ?? DEFAULT_TYPES) {
        types.add(type);
      }
    }
    const push = triggers.has('push') ? pushFilters(triggers.get('push')) : null;
    return { push, types: [...types], any: push !== null || types.size > 0 };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Whether a branch filter list names `branch`. A pattern with GitHub's other glob characters
 * (`?`, `+`, `[]`, `!`) is not read, and counts as `unread`: matching in `branches`, not
 * matching in `branches-ignore`, since a needless minute of polling beats a missed run.
 */
function matches(patterns, branch, unread) {
  return patterns.some((pattern) => {
    if (/[?+[\]!]/.test(pattern)) return unread;
    const source = pattern
      .split(/(\*\*|\*)/)
      .map((part) =>
        part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.\\^$|(){}]/g, '\\$&')
      )
      .join('');
    return new RegExp(`^${source}$`).test(branch);
  });
}

/** Whether a push of `branch` starts a run under a push trigger with these filters. */
export function pushStarts(filters, branch) {
  if (!filters) return false;
  const { branches, 'branches-ignore': ignore, tags, 'tags-ignore': tagsIgnore } = filters;
  // Tag filters alone leave branch pushes out.
  if (!branches && !ignore) return !tags && !tagsIgnore;
  if (!branch) return true;
  if (branches) return matches(branches, branch, true);
  return !matches(ignore, branch, false);
}

/**
 * Whether a tag push starts a run under a push trigger with these filters. Tag names are not
 * matched: any tag filter may take the tag. Branch filters alone leave tag pushes out.
 */
export function tagStarts(filters) {
  if (!filters) return false;
  const { branches, 'branches-ignore': ignore, tags, 'tags-ignore': tagsIgnore } = filters;
  return Boolean(tags || tagsIgnore) || (!branches && !ignore);
}

/**
 * The words for a push of `branch` from the checkout `checkout`, with the config read from the
 * first of `roots` that has one: `push` when a branch push starts a run, `push-tag` when a tag
 * push does, then the pull request types. The workflows come from the checkout the command ran
 * in when it has them: GitHub runs the branch's own files. A `gh pr ready 12` for a pull request
 * whose branch carries other workflow files is still read from the checkout's.
 */
export function triggersFor({ checkout, roots, branch }) {
  const fallback = [...DEFAULT_TYPES];
  try {
    const root = roots.find((dir) => dir && existsSync(join(dir, CONFIG_PATH)));
    if (!root) return fallback;
    const state = loadConfig(root);
    if (state.status !== 'ok' || !state.config.ci) return fallback;
    const dir = [checkout, root]
      .filter(Boolean)
      .map((base) => join(base, '.github/workflows'))
      .find((path) => existsSync(join(path, state.config.ci.workflow)));
    if (!dir) return fallback;
    const parsed = readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => {
        let text;
        try {
          text = readFileSync(join(dir, name), 'utf8');
        } catch {
          return DEFAULTS;
        }
        return parseTriggers(text);
      });
    if (!parsed.some((file) => file.any)) return fallback;
    const out = new Set();
    if (parsed.some((file) => pushStarts(file.push, branch))) out.add('push');
    if (parsed.some((file) => tagStarts(file.push))) out.add('push-tag');
    for (const file of parsed) for (const type of file.types) out.add(type);
    return [...out];
  } catch {
    return fallback;
  }
}

/** `--undo` and `--undo=true` mark the pull request a draft again; `--undo=false` does not. */
const undoes = (flags) => [true, 'true'].includes(flags.get('--undo'));

/**
 * What this command starts, read through `prCalls` so `gh pr -R o/r ready 12`, quoting and a
 * second line are read as the shell reads them. `push` is whether a push started a run, `opened`
 * whether `gh pr create` did, and `pr` the `gh pr ready` or `gh pr reopen` that did, with the
 * selector and repository to read its head from. A push is still matched on text, as it always
 * was: a mention costs a quiet lookup.
 *
 * `tags` is what the hook read from git's ref lines: `none`, `only` when the push sent tags and
 * no branch, or `also` when it sent both. A tag push starts no pull request event and no
 * branch-filtered push, so only `push-tag` speaks for it.
 *
 * A ready or reopen in another repository (`--repo`) is counted whatever the local workflows
 * say: they are not that repository's.
 */
export function decide({ command, upToDate, tags = 'none', found }) {
  const has = (word) => found.includes(word);
  const text = String(command ?? '');
  const starts =
    tags === 'only'
      ? has('push-tag')
      : has('push') || has('synchronize') || (tags === 'also' && has('push-tag'));
  const push = text.includes('git push') && !upToDate && starts;
  const calls = prCalls(text, ['create', 'ready', 'reopen']);
  const opened = has('opened') && calls.some((call) => call.subcommand === 'create');
  const repoOf = (call) => {
    const repo = call.flags.get('--repo') ?? call.flags.get('-R');
    return typeof repo === 'string' ? repo : '';
  };
  const pr =
    calls.find((call) => {
      // gh refuses `--repo` without a selector, so that command changed nothing.
      if (repoOf(call) && call.positionals.length === 0) return false;
      if (call.subcommand === 'ready') {
        return !undoes(call.flags) && (has('ready_for_review') || repoOf(call) !== '');
      }
      return call.subcommand === 'reopen' && (has('reopened') || repoOf(call) !== '');
    }) ?? null;
  return {
    push,
    opened,
    pr: pr && {
      subcommand: pr.subcommand,
      selector: pr.positionals[0] ?? '',
      repo: repoOf(pr),
    },
  };
}

/**
 * `node ci-triggers.mjs <checkout> <project> <branch> <up-to-date> <tags>`, with the hook's
 * payload on stdin. Prints `ok`, then one line each: `1` if a push started a run, `1` if `gh pr create`
 * did, and the `gh pr` subcommand, selector and repository of a ready or reopen that did. No
 * `ok` means this failed, and the hook falls back to the default types.
 */
const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  const [checkout, project, branch, upToDate, tags] = process.argv.slice(2);
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const { push, opened, pr } = decide({
    command: payload?.tool_input?.command,
    upToDate: upToDate === '1',
    tags,
    found: triggersFor({ checkout, roots: [checkout, project], branch }),
  });
  const one = (value) => String(value).replace(/\s+/g, ' ');
  process.stdout.write(
    [
      'ok',
      push ? 1 : 0,
      opened ? 1 : 0,
      one(pr?.subcommand ?? ''),
      one(pr?.selector ?? ''),
      one(pr?.repo ?? ''),
    ].join('\n')
  );
}
