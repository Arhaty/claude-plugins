/**
 * Which branches would this `git push` write to?
 *
 * Split out so it can be tested: a hook whose logic nothing imports is a hook
 * that ships broken and green.
 *
 * It reads pushes through `invocations` in `merge-command.mjs`, the same reader the
 * merge guard uses, so a push hidden behind `bash -c`, `eval`, `timeout`, a path to
 * the binary, a heredoc fed to a shell or `echo ... | bash` is seen the way a merge
 * there is. An earlier version matched a pattern over `commandSkeleton`, which saw
 * none of those.
 *
 * It answers from the command line alone. What depends on the repository (which
 * branch `HEAD` is, where a bare push goes, what `push.default` says) is left to
 * `protect-push.mjs`, which has a working directory to ask; each push carries what
 * that hook needs to ask it: the `-C` directory, the config set for this one
 * command, and the remote.
 */

import { CMD_START, GIT, commandSkeleton, invocations, parseArgs } from './merge-command.mjs';

/** Git's own options before the subcommand that take a separate value. */
const GIT_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/**
 * `git push` long options taking a separate value. The short `-o` is handled with
 * its cluster.
 *
 * Git's other long push options take their value with `=` (`--force-with-lease=<ref>`,
 * `--signed=true`), which makes them a single word. Listing one here ate the *next*
 * word instead, so `git push --signed origin main` lost `origin`, left no refspec,
 * and was reported as a bare push, which skipped the refspec check and allowed a
 * direct push to `main`.
 */
const PUSH_VALUES = new Set(['--repo', '--receive-pack', '--exec', '--push-option']);

/**
 * Anything that rewrites what is already on the remote. `.claude/settings.json`
 * denies `git push --force` and `git push -f`, but those are prefix rules, so
 * `git push origin HEAD --force` passed both. `--force-with-lease` is the careful
 * variant and still a rewrite. `--mirror` force-updates and deletes remote refs.
 */
const FORCE = new Set(['--force', '--force-with-lease', '--force-if-includes', '--mirror']);

/**
 * Options that push every branch at once, so there is no refspec to read and every
 * protected branch is a target. These parsed as a bare push once, which sent the
 * hook to the current branch and its upstream, both unprotected on a feature
 * branch, while the push itself wrote `main` and `staging`.
 */
const EVERY_BRANCH = new Set(['--all', '--branches', '--mirror']);

/** `main`, `heads/main` and `refs/heads/main` all name the same branch to git. */
const branchName = (ref) => ref.replace(/^(?:refs\/)?heads\//, '');

/**
 * What one refspec does: the branch it lands on or deletes, `HEAD` for the
 * checked-out one, and whether it forces or reaches every branch.
 *
 * Exported because a bare push takes its refspecs from `remote.<name>.push`, which
 * only `protect-push.mjs` can read, and those are judged the same way.
 */
export function readRefspec(refspec, { deleting = false } = {}) {
  const force = refspec.startsWith('+');
  const spec = refspec.replace(/^\+/, '');

  // A bare `:` is the matching refspec, not a delete of an empty name, and a
  // wildcard is `--all` spelled as a pattern.
  if (spec === ':' || spec.includes('*')) return { target: null, force, everyBranch: true };

  if (deleting) return { target: branchName(spec), force, everyBranch: false };

  // `src:dst` lands on `dst`, `:dst` deletes it, and a lone `name` lands on the
  // branch of that name.
  const colon = spec.indexOf(':');
  const named = colon === -1 ? spec : spec.slice(colon + 1) || spec.slice(0, colon);
  const target = named === 'HEAD' || named === '@' ? 'HEAD' : branchName(named);
  return { target, force, everyBranch: false };
}

/**
 * Config set for this one command, from `git -c key=value` and from inline
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pairs. Keys are lowercased, as git
 * compares them. `git -c push.default=matching push` would otherwise be judged by
 * the repository's config, which says something else.
 */
function commandConfig(env) {
  const config = {};
  for (const [name, key] of Object.entries(env)) {
    const index = /^GIT_CONFIG_KEY_(\d+)$/.exec(name)?.[1];
    if (index !== undefined) config[key.toLowerCase()] = env[`GIT_CONFIG_VALUE_${index}`] ?? '';
  }
  return config;
}

/** One `git push`, or `null` when the invocation is some other git command. */
function readPush({ argv, env, appended }) {
  let dir = null;
  const config = commandConfig(env);

  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    const [name] = argv[i].split('=');
    if (GIT_VALUES.has(name) && !argv[i].includes('=')) {
      if (name === '-C') dir = dir === null ? argv[i + 1] : `${dir}/${argv[i + 1]}`;
      if (name === '-c') {
        const [key, ...value] = (argv[i + 1] ?? '').split('=');
        config[key.toLowerCase()] = value.join('=');
      }
      i += 1;
    }
    i += 1;
  }
  if (argv[i] !== 'push') return null;

  let force = false;
  let everyBranch = false;
  let deleting = false;
  let tagsOnly = false;
  // `echo HEAD:main | xargs git push origin` pushes a refspec nothing here can read.
  let unresolved = appended;
  const rest = [];

  // Short options come in clusters, so `-uf` is a force push and `-d` a delete.
  // `-o` takes the rest of its cluster, or the next word, as its value.
  const args = argv.slice(i + 1);
  for (let j = 0; j < args.length; j += 1) {
    const arg = args[j];
    if (/^-[A-Za-z0-9]+$/.test(arg)) {
      for (const [k, flag] of [...arg.slice(1)].entries()) {
        if (flag === 'f') force = true;
        if (flag === 'd') deleting = true;
        if (flag === 'o') {
          if (k === arg.length - 2) j += 1;
          break;
        }
      }
      continue;
    }
    rest.push(arg);
  }

  const { positionals, flags } = parseArgs(rest, PUSH_VALUES);
  for (const name of flags.keys()) {
    if (FORCE.has(name)) force = true;
    if (EVERY_BRANCH.has(name)) everyBranch = true;
    if (name === '--delete') deleting = true;
    // `--tags` with no refspec writes tags and no branch. `--follow-tags` is not
    // this: it pushes whatever a bare push would, and the tags beside it.
    if (name === '--tags') tagsOnly = true;
  }

  // With `--repo`, git reads every positional as a refspec rather than the first
  // as the remote. Read as a remote, `git push --repo=origin main` left no refspec
  // and reported a bare push.
  const repo = flags.get('--repo');
  const refspecs = flags.has('--repo') ? positionals : positionals.slice(1);
  const remote = typeof repo === 'string' ? repo : (positionals[0] ?? null);

  const targets = [];
  for (const refspec of refspecs) {
    // A target naming a shell variable cannot be compared against the protected
    // set, and comparing it anyway silently answers "not protected". Braces are the
    // same: bash expands `{main,feat}` into two refspecs after this has read one.
    if (/[$`{}]/.test(refspec)) unresolved = true;
    const read = readRefspec(refspec, { deleting });
    force ||= read.force;
    everyBranch ||= read.everyBranch;
    if (read.target !== null) targets.push(read.target);
  }

  const bare = refspecs.length === 0 && !everyBranch && !tagsOnly;
  if (bare && config['push.default'] === 'matching') everyBranch = true;

  return { dir, config, remote, targets, bare, everyBranch, force, unresolved };
}

/**
 * A `git push` whose refspec is a backtick substitution splits at the backtick, so
 * the push reads as bare and the substitution as a command of its own. The older
 * skeleton keeps the two together, and a push whose arguments hold a `$` or a
 * backtick there is one this cannot evaluate.
 */
const PUSH = new RegExp(`${CMD_START}${GIT}\\s+push\\b([^\\n;&|)]*)`, 'g');
const hidesSubstitution = (command) =>
  [...commandSkeleton(command).matchAll(PUSH)].some(([, args]) => /[$`]/.test(args ?? ''));

/**
 * `null` when the command does not push. Otherwise every push in it, and the
 * union of them: the destination branch names they would write (`HEAD` left for
 * the hook to resolve), `bare` when any push carried no refspec and its target
 * therefore depends on configuration, `everyBranch` when any would write every
 * branch, `force` when any would rewrite what is on the remote, and `unresolved`
 * when a target is one this cannot evaluate.
 *
 * **Folded as well as listed.** Reading only the first push meant
 * `git push origin feat/x && git push origin main` was judged by the harmless half.
 * The union answers the question every caller asks first, and `pushes` keeps what
 * each one needs resolved against the repository.
 */
export function pushTargets(command) {
  if (typeof command !== 'string') return null;

  const pushes = invocations(command)
    .filter(({ argv }) => argv[0] === 'git')
    .map(readPush)
    .filter(Boolean);
  if (pushes.length === 0) return null;

  return {
    targets: pushes.flatMap((push) => push.targets),
    bare: pushes.some((push) => push.bare),
    everyBranch: pushes.some((push) => push.everyBranch),
    force: pushes.some((push) => push.force),
    unresolved: pushes.some((push) => push.unresolved) || hidesSubstitution(command),
    pushes,
  };
}
