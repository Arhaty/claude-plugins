/**
 * Which commits and pushes does a Bash command run, and which branch names may
 * hold canon work?
 *
 * Split out so it can be tested: a hook whose logic nothing imports is a hook
 * that ships broken and green.
 *
 * Commands are read through `invocations` in `merge-command.mjs`, the reader every
 * other guard uses, so only a real `git commit` or `git push` counts. A commit
 * message that says `push` or `claude/` is one argument of a commit, never a
 * command of its own. Git's own options are read by `gitCall` and pushes by
 * `readPush`, both in `push-command.mjs`, so a `-C` and a refspec mean here what
 * they mean to `protect-push.mjs`.
 */

import { invocations } from './merge-command.mjs';
import { gitCall, readPush } from './push-command.mjs';

/**
 * The subcommands that add commits to the checked-out branch. `commit` is the plain
 * one; the rest commit as they go, so a branch could fill up through them alone.
 */
const COMMITS = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am', 'pull', 'rebase']);

/** Options that end one of those without committing anything. */
const STOPS = new Set(['--abort', '--quit']);

/**
 * Every commit-making git command and every `git push` in the command, in order, as
 * `{ kind, subcommand, dir, dirKnown, env, push }`, `kind` being `commit` or `push`: `dir` is the `-C` directory or `null`,
 * `dirKnown` is false after a `cd` this cannot follow, `env` holds the inline
 * assignments before the command (where a bypass is set), and `push` is what
 * `readPush` returns for a push.
 */
export function commitsAndPushes(command) {
  if (typeof command !== 'string') return [];
  const found = [];
  for (const call of invocations(command)) {
    if (call.argv[0] !== 'git') continue;
    const { subcommand, index, dir, dirKnown } = gitCall(call.argv, call.dirKnown ?? true);
    const args = call.argv.slice(index + 1);
    if (COMMITS.has(subcommand) && !args.some((arg) => STOPS.has(arg))) {
      found.push({ kind: 'commit', subcommand, dir, dirKnown, env: call.env, push: null });
    } else if (subcommand === 'push') {
      found.push({ kind: 'push', subcommand, dir, dirKnown, env: call.env, push: readPush(call) });
    }
  }
  return found;
}

/**
 * The branches a push's refspecs write, by name, with `HEAD` left for the caller to
 * resolve. Only a refspec that sends something writes: a delete (`--delete`, `-d`,
 * `:x`) sends nothing, so deleting a stray `claude/x` from the remote is allowed.
 */
export const writtenBranches = (push) => push.sent.map((one) => one.dst);

/** Leading segments of generated branches, never a person's name: a cloud session's `claude/<name>`. */
const GENERATED = new Set(['claude']);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `branch` take canon work under this config? A branch is allowed when it is
 * `<prefix>/<something>` for one of `branches.prefixes`, or, with
 * `branches.naming` set to `tracker`, when it is Linear's `branchName` for an issue
 * of the tracker's team: `abc-123-slug`, or `ada/abc-123-slug` with the user name
 * Linear puts first by default. Every teammate's name cannot be listed, so any one
 * leading segment is accepted except a generator's: `claude/abc-123-slug` is a cloud
 * session's branch named after the issue, which is the case this exists to stop.
 *
 * The integration and production branches are neither: `protect-push.mjs` and
 * `protect-branch.mjs` own the rules for those, and this answers `true` so a caller
 * leaves them to those hooks.
 */
export function branchAllowed(branch, config) {
  const { branches, tracker } = config;
  if (branch === branches.integration || branch === branches.production) return true;
  const prefixes = branches.prefixes ?? [];
  if (prefixes.some((p) => branch.startsWith(`${p}/`) && branch.length > p.length + 1)) {
    return true;
  }
  if (branches.naming === 'tracker' && tracker?.team) {
    const [first, ...rest] = branch.split('/');
    if (rest.length > 1 || (rest.length === 1 && GENERATED.has(first))) return false;
    return new RegExp(`^${escape(tracker.team)}-\\d+(?:-|$)`, 'i').test(rest[0] ?? first);
  }
  return false;
}

/** The allowed names, in a phrase for a refusal. */
export function allowedNames(config) {
  const { branches, tracker } = config;
  const parts = [];
  if (branches.prefixes?.length) {
    const prefixes = branches.prefixes.map((p) => `\`${p}/\``).join(', ');
    parts.push(`one of these prefixes and a slash: ${prefixes}`);
  }
  if (branches.naming === 'tracker' && tracker?.team) {
    const id = `${tracker.team.toLowerCase()}-123`;
    parts.push(`the tracker issue's own branch name, \`${id}-slug\` or \`<user>/${id}-slug\``);
  }
  return parts.join(', or ');
}
