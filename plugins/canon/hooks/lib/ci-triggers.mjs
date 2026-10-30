/**
 * Which commands start a CI run in this project?
 *
 * `ci-watch.sh` asks this before it polls, and it answers with the commits to watch. It reads
 * the `on:` triggers of every workflow in the checkout's `.github/workflows/`, with or without a
 * `ci` block in `.claude/canon.json`: projects trim the `pull_request` types whether or not
 * `/canon:staging` dispatches their CI, and the watcher reports a failure in any run on the
 * commit, so a lint workflow left on the default types still counts when `ci.yml` has trimmed
 * them. `decide` weighs the command against the union.
 *
 * GitHub's defaults, `opened synchronize reopened`, stand in for what it cannot read: no
 * workflow directory, or a file in a shape this narrow reader does not know. A wrong
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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_PATH } from './config.mjs';
import { apiPrCalls, dispatchCalls, prCalls, prRead } from './merge-command.mjs';
import { pushTargets } from './push-command.mjs';

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
 * The triggers of every workflow file in the first of `dirs` that has a `.github/workflows/`,
 * as `parseTriggers` reads them: the checkout the command ran in when it has them, since GitHub
 * runs the branch's own files, else the project's. A `gh pr ready 12` for a pull request whose
 * branch carries other workflow files is still read from the checkout's. No directory, or no
 * file with a push or pull request trigger, is `[DEFAULTS]`.
 */
export function workflowsIn(dirs) {
  try {
    const dir = dirs
      .filter(Boolean)
      .map((base) => join(base, '.github/workflows'))
      .find((path) => existsSync(path));
    if (!dir) return [DEFAULTS];
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
    return parsed.some((file) => file.any) ? parsed : [DEFAULTS];
  } catch {
    return [DEFAULTS];
  }
}

/** `--undo` and `--undo=true` mark the pull request a draft again; `--undo=false` does not. */
const undoes = (flags) => [true, 'true'].includes(flags.get('--undo'));

/** The report's name for a push from a detached `HEAD`, which has no branch to name. */
const DETACHED = 'detached HEAD';

/**
 * The repository a `gh pr` call names. pflag reads `-R=o/r` as `o/r`, so a short flag's `=` is
 * not part of the value; `--repo==o/r` keeps it, as gh does. A `gh api` call names it in its
 * path.
 */
function repoOf(call) {
  if (call.api) return call.repo;
  const long = call.flags.get('--repo');
  if (typeof long === 'string') return long;
  const short = call.flags.get('-R');
  return typeof short === 'string' ? short.replace(/^=/, '') : '';
}

/**
 * What this command starts, read through `prCalls` so `gh pr -R o/r ready 12`, quoting and a
 * second line are read as the shell reads them, and through `apiPrCalls` for the REST forms a
 * cloud session sends instead: `POST pulls` is a create and `POST pulls/<n>/ccr/ready_for_review`
 * a ready. A `workflow_dispatch` through `gh api` starts a run whatever the triggers say, on the
 * branch its `ref` names, or on `HEAD` when that is not on the line. Pushes arrive as `refs`,
 * read by the caller.
 *
 * `refs` are what the pushes sent, each `{ sha, name, tag }` with `sha` empty when this checkout
 * cannot resolve it and `name` empty for a detached `HEAD`. Each is weighed on its own: a branch
 * by `synchronize` or the push triggers' branch filters, a tag by tag filters alone, since a tag
 * push starts no pull request event. `--follow-tags` can send a tag on another commit that only
 * a release workflow runs on.
 *
 * Returns `targets`, the commits to watch with the name the report gives them and the
 * repository they are in when a `gh pr create --repo` named another, and `prs`, every
 * `gh pr ready` or `gh pr reopen` that started a run, whose heads the caller looks up. A ready
 * or reopen in another repository is counted whatever the local workflows say: they are not
 * that repository's.
 */
export function decide({ command, refs = [], head, files }) {
  const text = String(command ?? '');
  const types = new Set(files.flatMap((file) => file.types));
  const branchStarts = (name) =>
    types.has('synchronize') || files.some((file) => pushStarts(file.push, name));
  const tagStarts_ = files.some((file) => tagStarts(file.push));

  const targets = [];
  for (const ref of refs) {
    if (ref.sha && (ref.tag ? tagStarts_ : branchStarts(ref.name))) {
      targets.push({ sha: ref.sha, label: ref.name || DETACHED, repo: '' });
    }
  }

  // A pull request opened for `--head <branch>` runs on that branch, not on `HEAD`; the caller
  // resolves it. Like a ready, one opened in another repository counts whatever the local
  // workflows say.
  const calls = [
    ...prCalls(text, ['create', 'ready', 'reopen']),
    ...apiPrCalls(text, ['create', 'ready']),
  ];
  const creates = calls
    .filter((call) => call.subcommand === 'create' && (types.has('opened') || repoOf(call)))
    .map((call) => {
      const branch = call.flags.get('--head') ?? call.flags.get('-H');
      return {
        // `owner:branch` names a fork's branch; the part after the colon is the branch.
        branch: typeof branch === 'string' ? branch.slice(branch.indexOf(':') + 1) : '',
        repo: repoOf(call),
      };
    });
  for (const { branch, repo } of creates) {
    if (!branch && head.sha) targets.push({ sha: head.sha, label: head.name || DETACHED, repo });
  }
  const prs = calls
    .filter((call) => {
      // gh refuses `--repo` without a selector, so that command changed nothing.
      if (repoOf(call) && call.positionals.length === 0) return false;
      if (call.subcommand === 'ready') {
        return !undoes(call.flags) && (types.has('ready_for_review') || repoOf(call) !== '');
      }
      return call.subcommand === 'reopen' && (types.has('reopened') || repoOf(call) !== '');
    })
    .map((call) => ({ selector: call.positionals[0] ?? '', repo: repoOf(call) }));
  const heads = creates.filter(({ branch }) => branch);
  for (const { ref, repo } of dispatchCalls(text)) {
    if (ref) heads.push({ branch: ref, repo });
    else if (head.sha) targets.push({ sha: head.sha, label: head.name || DETACHED, repo });
  }
  return { targets, prs, heads };
}

// A ref line as git prints it, read from the JSON-encoded output, so a newline is a backslash:
// the commit it sent (`old..new  src -> dst`, none for a `[new ...]` line), whether git called
// it a new tag, its source ref and the ref it wrote.
const REF_LINE =
  /(?:\b[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})|\[new (branch|tag)\])\s+([^\s\\]+) -> ([^\s\\]+)/g;

const strip = (ref, prefix) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : ref);

/**
 * The command's pushes, read once and as the push guard reads them, so
 * `git -c push.default=current push` and `git --no-pager push` count. A command the reader
 * cannot parse falls back to the text, with no push to read.
 */
function readPushes(command) {
  try {
    const read = pushTargets(command);
    return { pushing: read !== null, pushes: read?.pushes ?? [] };
  } catch {
    return { pushing: command.includes('git push'), pushes: [] };
  }
}

/**
 * What the pushes sent when git printed no ref line (`git push -q`), as ref lines: each
 * refspec's source and destination, read from the command. A bare push sent the current branch
 * to where git pushes it, which `push.default=upstream` makes its upstream's name; one that
 * writes every branch sent the current branch under its own name, at least. When `tags` (a
 * workflow runs on tags), a push with `--follow-tags`, or `push.followTags`, sent the annotated
 * tags on those commits too; a tag on an older commit that the remote lacked is not seen. A push
 * run in another directory (`-C`, or after a `cd`) is left out: its sources are not this
 * checkout's. `git` runs git here and returns '' on a failure.
 */
function quietLines(pushes, head, git, tags) {
  const lines = [];
  const followed = [];
  for (const push of pushes) {
    if (push.dir !== null || !push.dirKnown || push.unresolved) continue;
    // As the command gave it: git reads `-c push.followTags` as true and `branch.Wip.merge` as
    // branch `Wip`'s, where the guard's lowercased reading would not.
    const config = push.configArgs.flatMap((arg) => ['-c', arg]);
    const sent = [];
    if (push.bare && !push.everyBranch) {
      // `%(push)` is the remote-tracking ref of where it goes, `refs/remotes/<remote>/<branch>`;
      // `%(push:remoteref)` would name the branch outright, but git leaves it empty unless the
      // remote has a push refspec. Empty is a push git refuses.
      const [remote = '', to = ''] = head.name
        ? git([
            ...config,
            'for-each-ref',
            '--format=%(push:remotename) %(push)',
            `refs/heads/${head.name}`,
          ])
            .replace(/\n$/, '')
            .split(' ')
        : [];
      const branch = remote
        ? strip(to, `refs/remotes/${remote}/`)
        : to.replace(/^refs\/remotes\/[^/]+\//, '');
      sent.push({ src: 'HEAD', dst: branch || head.name });
    } else if (push.everyBranch) {
      sent.push({ src: 'HEAD', dst: head.name });
    }
    for (const { src, dst } of push.sent) sent.push({ src, dst: dst === 'HEAD' ? head.name : dst });
    lines.push(...sent.map((line) => ({ sent: '', ...line })));

    if (!tags) continue;
    const follows =
      push.followTags ??
      git([...config, 'config', '--type=bool', 'push.followTags']).trim() === 'true';
    if (follows) {
      followed.push(
        ...sent.filter(({ dst }) => !dst.startsWith('refs/tags/')).map(({ src }) => src)
      );
    }
  }
  if (followed.length > 0) {
    const found = git([
      'for-each-ref',
      ...followed.map((src) => `--points-at=${src}`),
      '--format=%(objecttype) %(refname)',
      'refs/tags',
    ]);
    for (const [type, ref] of found.split('\n').map((line) => line.split(' '))) {
      if (type === 'tag' && ref) lines.push({ sent: '', src: ref, dst: ref });
    }
  }
  return lines;
}

/**
 * The commits the hook's payload started a run on, each `{ sha, label, repo }`, and the
 * checkout the command ran in. Empty outside a canon project, for a command that starts nothing,
 * and when the checkout cannot be read: the hook then exits quietly. Past that, a failure falls
 * back to `textTargets`.
 */
export function watchTargets(payload, project) {
  try {
    return targetsOf(payload, project);
  } catch {
    return { targets: [] };
  }
}

function targetsOf(payload, project) {
  const command = String(payload?.tool_input?.command ?? '');
  const read = readPushes(command);
  if (!read.pushing && !command.includes('gh pr') && !command.includes('gh api')) {
    return { targets: [] };
  }
  const output = JSON.stringify(payload?.tool_response ?? '');
  // The directory the command ran in, which may be a worktree or another checkout: reading
  // `HEAD` in the project directory watched a commit nobody pushed.
  const cwd = payload?.cwd || project || '.';
  const run = (program, args, options = {}) =>
    execFileSync(program, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 30000,
      ...options,
    });
  const quiet = (...args) => {
    try {
      return run(...args);
    } catch {
      return '';
    }
  };

  const [top, common, headSha, headRef] = run('git', [
    'rev-parse',
    '--show-toplevel',
    '--path-format=absolute',
    '--git-common-dir',
    'HEAD',
    '--symbolic-full-name',
    'HEAD',
  ]).split('\n');
  // A canon project: the checkout has the config, or it is a worktree of the session's project,
  // which does (a worktree cut from a branch that predates the config). A push from any other
  // repository is not this project's CI.
  const canon =
    existsSync(join(top, CONFIG_PATH)) ||
    (Boolean(project) &&
      existsSync(join(project, CONFIG_PATH)) &&
      quiet('git', [
        '-C',
        project,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).trim() === common);
  if (!canon) return { targets: [] };
  // `--symbolic-full-name` prints plain `HEAD` when it is detached: no branch to name or filter.
  const head = {
    sha: headSha,
    name: headRef.startsWith('refs/heads/') ? headRef.slice('refs/heads/'.length) : '',
  };

  // Anything below that throws falls back to the plain reading the hook had before it read
  // workflows, rather than to watching nothing.
  let targets;
  try {
    targets = weigh();
  } catch {
    targets = textTargets(command, output, head, read);
  }

  // One commit is watched once. A `--repo` that names the checkout's own repository is the same
  // runs as no `--repo`, so when it shares a SHA with another target, ask gh which repository
  // the checkout is: one call, and only then.
  let own;
  const ownRepo = () =>
    (own ??= quiet('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
      .trim()
      .toLowerCase());
  const shared = (sha) => targets.filter((target) => target.sha === sha).length > 1;
  const seen = new Set();
  return {
    dir: top,
    targets: targets
      .map((target) =>
        target.repo && shared(target.sha) && target.repo.toLowerCase() === ownRepo()
          ? { ...target, repo: '' }
          : target
      )
      .filter(({ sha, repo }) => {
        const key = `${sha} ${repo.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
  };

  function weigh() {
    // What the pushes sent: git's ref lines, or with none, the refspecs in the command. "Everything
    // up-to-date" counts only when git printed no ref line: `git push origin x && git push
    // upstream x` prints one of each, and the first push still started a run. Nor does a push git
    // refused, which prints its refs as `! [rejected]` lines that are no ref lines at all.
    const files = workflowsIn([top, project]);
    let lines = [];
    if (read.pushing) {
      lines = [...output.matchAll(REF_LINE)].map((m) => ({
        sent: m[1] ?? '',
        newTag: m[2] === 'tag',
        src: m[3],
        dst: m[4],
      }));
      if (lines.length === 0 && !sentNothing(output, read)) {
        lines = quietLines(
          read.pushes,
          head,
          (args) => quiet('git', args),
          files.some((file) => tagStarts(file.push))
        );
      }
    }

    // Which lines are tags. git says `[new tag]` for a new one and nothing for one it updated
    // (`+ a...b v1 -> v1 (forced update)`), which reads like a branch: a source that is a tag here
    // and not a branch is one too. A commit this checkout cannot resolve was pushed from somewhere
    // else (`cd ../other && git push`): it is left out rather than guessed at. The lookup failing
    // leaves the push out, not the pull requests beside it. One `cat-file` answers all three
    // questions for every line, and only for the names the push sent: listing every ref cost a
    // repository with a long release history its whole tag list on each push.
    let refs = [];
    if (lines.length > 0) {
      const object = /^[0-9a-f]{40,64}$/;
      // A new branch prints no range, so its source ref names the commit.
      const found = quiet('git', ['cat-file', '--batch-check=%(objectname)'], {
        input: lines
          .map(
            (line) =>
              `${line.sent || line.src}^{commit}\nrefs/tags/${strip(line.src, 'refs/tags/')}\n` +
              `refs/heads/${strip(line.src, 'refs/heads/')}\n`
          )
          .join(''),
      }).split('\n');
      refs = lines.map((line, i) => {
        const [commit, isTag, isBranch] = found
          .slice(i * 3, i * 3 + 3)
          .map((out) => object.test(out ?? ''));
        const tag = line.newTag || line.dst.startsWith('refs/tags/') || (isTag && !isBranch);
        return {
          sha: commit ? found[i * 3] : '',
          name: strip(line.dst, tag ? 'refs/tags/' : 'refs/heads/'),
          tag,
        };
      });
    }

    const { targets, prs, heads } = decide({
      command,
      refs,
      head,
      files,
    });

    // `gh pr create --head feature`: the local branch, or what the remote has of it.
    for (const { branch, repo } of heads) {
      const sha =
        quiet('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).trim() ||
        quiet('git', [
          'rev-parse',
          '--verify',
          '-q',
          `refs/remotes/origin/${branch}^{commit}`,
        ]).trim();
      if (/^[0-9a-f]{40,64}$/.test(sha)) targets.push({ sha, label: branch, repo });
    }

    // A pull request marked ready or reopened runs on its own head, which need not be `HEAD`:
    // `gh pr ready 12` from another branch, or with commits not pushed yet, or in another
    // repository. A named pull request gh cannot read is left out: `HEAD` may be another pull
    // request's. Only a bare `gh pr ready`, which is about the current branch's, falls back to it.
    // Read through REST, as the hooks read a pull request: a cloud session refuses GraphQL.
    for (const pr of prs) {
      const { endpoint, jq } = prRead(
        pr.selector ? [pr.selector] : [],
        '.head.sha + " " + .head.ref'
      );
      const view = quiet('gh', ['api', endpoint, '--jq', jq], {
        env: pr.repo ? { ...process.env, GH_REPO: pr.repo } : process.env,
      });
      const found = /^([0-9a-f]{7,64}) (\S+)/.exec(view);
      if (found) targets.push({ sha: found[1], label: found[2], repo: pr.repo });
      else if (!pr.selector && head.sha) {
        targets.push({ sha: head.sha, label: head.name || DETACHED, repo: '' });
      }
    }
    return targets;
  }
}

/**
 * Git's own words for a push that changed nothing, that the remote refused, or that failed
 * before it sent anything. Only these: any `error:` line counted the compiler's in
 * `git push -q && cargo build` as the push's.
 */
const NOTHING_SENT = new RegExp(
  [
    'Everything up-to-date',
    String.raw`\[(?:remote )?rejected\]`,
    'error: failed to push some refs',
    'error: src refspec .{1,200}? does not match any',
    'error: unable to push to unqualified destination',
    'fatal: The current branch .{1,200}? has no upstream branch',
    'fatal: The upstream branch of your current branch does not match',
    'fatal: You are not currently on a branch',
    'fatal: No configured push destination',
    'fatal: invalid refspec',
    'does not appear to be a git repository',
    'fatal: Could not read from remote repository',
    'fatal: unable to access',
    'fatal: Authentication failed',
  ].join('|')
);

/**
 * Did the push in this output send nothing? Asked only when git printed no ref line. With more
 * than one push the words cannot be pinned on one of them, so `git push -q origin main &&
 * git push -q origin nope` still sent `main`: watching a push that sent nothing costs a quiet
 * minute of polling, and missing one that sent something costs the red run.
 */
function sentNothing(output, read) {
  return read.pushes.length <= 1 && NOTHING_SENT.test(output);
}

/**
 * The plain reading, for when the full one throws: GitHub's default types, under which a push
 * that sent something and a `gh pr create` start a run on `HEAD`, matched on text.
 */
export function textTargets(command, output, head, read = readPushes(command)) {
  if (!head.sha) return [];
  const pushed = read.pushing && !sentNothing(output, read);
  return pushed || command.includes('gh pr create')
    ? [{ sha: head.sha, label: head.name || DETACHED, repo: '' }]
    : [];
}

/**
 * `node ci-triggers.mjs <start>`, with the hook's payload on stdin, `CLAUDE_PROJECT_DIR` in the
 * environment, and `start` the epoch second the hook started. Prints nothing when there is
 * nothing to watch; otherwise the checkout to run `gh` in and the cutoff for a run's
 * `createdAt`, a minute before `start`, then one line per commit: its SHA, the name the report
 * gives it and the repository it is in when not the checkout's, all tab-separated.
 */
const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  const one = (value) => String(value).replace(/\s+/g, ' ');
  const start = Number(process.argv[2]) * 1000 || Date.now();
  const since = new Date(start - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // Not a payload: nothing to watch.
  }
  const { dir, targets } = watchTargets(payload, process.env.CLAUDE_PROJECT_DIR ?? '');
  if (targets.length > 0) {
    process.stdout.write(
      [
        `${dir}\t${since}`,
        ...targets.map((t) => [t.sha, one(t.label), one(t.repo)].join('\t')),
      ].join('\n')
    );
  }
}
