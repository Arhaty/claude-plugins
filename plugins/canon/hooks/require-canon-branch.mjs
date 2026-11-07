#!/usr/bin/env node
/**
 * PreToolUse hook on Bash and the MCP GitHub write tools. Refuses a commit made on a
 * branch whose name canon does not allow, a push that writes to such a branch, and
 * an MCP file push, file write or branch creation that names one in this project's
 * repository.
 *
 * A branch is allowed when it takes one of `branches.prefixes` in
 * `.claude/canon.json` and a slash, `feat/abc-6-data-model`, or with
 * `branches.naming` set to `tracker`, when it carries the issue's identifier. The
 * integration and production branches are left to `protect-push.mjs` and
 * `protect-branch.mjs`, whose rules for them this changes in no way.
 *
 * What this exists for is a Claude Code cloud session. It is handed a generated
 * branch, `claude/<random-name>`, and told to push only there. Work built on it is
 * invisible to everything canon reads by branch: the spec's branch, the tracker,
 * `/canon:review`, `/canon:staging`. A whole issue can be built on the generated
 * branch while the canon branch holds only the spec, and nothing said so.
 *
 * Only real commits and pushes count: the command is read through `invocations`, so
 * `git commit -m "never push to claude/x"` is a commit with a message, not a push.
 * A commit is judged by the checked-out branch, and so are `merge`, `cherry-pick`,
 * `revert`, `am`, `pull` and `rebase`, which commit too; their `--abort` and `--quit`
 * do not. A push is judged by every branch it
 * writes, resolved as git resolves it: `HEAD` is the checked-out branch, a push with
 * no refspec follows `push.default`, the upstream and `remote.<name>.push`, and
 * `--all`, `--mirror` or a wildcard write every local branch. So `git push origin
 * HEAD:claude/x` from a canon branch is refused, and `git push -u origin feat/x` from
 * `claude/x` is not. Deleting a branch writes nothing and is allowed, so a stray
 * `claude/x` can be removed from the remote.
 *
 * Only this project's checkouts count: a `git -C` into another repository, a
 * submodule included, is not canon's to judge.
 *
 * **It fails open on what it cannot read**, like `protect-branch.mjs`: a detached
 * `HEAD`, a `cd` it cannot follow, a refspec built from a shell expansion, a git
 * read that does not answer. It guards against a branch picked by mistake, which is
 * always the plain case. **It fails closed when it crashes**, like
 * `protect-push.mjs`: Claude Code reads any exit but 2 as permission, so a crash
 * would pass every commit in silence. The bypass is read before anything that can
 * throw.
 *
 * Set `ALLOW_UNLISTED_BRANCH=1` in the session environment or on the command
 * itself (`ALLOW_UNLISTED_BRANCH=1 git commit ...`) to bypass it, with a one-line
 * reason.
 *
 * With no `.claude/canon.json` this does nothing. A project with `docs/canon/` and a
 * missing or invalid config is left to the other guards, which already refuse
 * there and say why.
 *
 * Exit codes are the hook contract: 0 says carry on, 2 blocks the call and sends
 * stderr back to Claude.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const allow = () => process.exit(0);
const BYPASS = 'ALLOW_UNLISTED_BRANCH';

if (process.env[BYPASS] === '1') allow();

try {
  const { allowedNames, branchAllowed, commitsAndPushes, writtenBranches } =
    await import('./lib/branch-command.mjs');
  const { bareTargets } = await import('./lib/push-command.mjs');
  const { branchNaming, canonical, loadConfig, projectRoot, readPayload } =
    await import('./lib/config.mjs');

  const payload = await readPayload();
  if (payload === null) allow();

  const mcp = payload?.tool_name?.startsWith('mcp__') ?? false;
  const calls = mcp
    ? []
    : commitsAndPushes(payload?.tool_input?.command).filter((call) => call.env?.[BYPASS] !== '1');
  if (!mcp && calls.length === 0) allow();

  const ROOT = projectRoot(payload);
  const state = loadConfig(ROOT);
  if (state.status !== 'ok') allow();
  const { config } = state;

  const cwd = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : ROOT;

  /**
   * A git read, or `''` when git cannot answer: the hook fails open on it. Every read
   * shares one deadline inside the hook's 15 seconds, and each answer is cached, so a
   * call that commits and pushes in the same checkout reads it once.
   */
  const deadline = Date.now() + 10_000;
  const cache = new Map();
  const git = (dir, ...args) => {
    const key = JSON.stringify([dir, args]);
    if (!cache.has(key)) {
      let out = '';
      try {
        out = execFileSync('git', ['-C', dir, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: Math.max(1, deadline - Date.now()),
        }).trim();
      } catch {
        // No answer: allowed, like every case this cannot read.
      }
      cache.set(key, out);
    }
    return cache.get(key);
  };
  /** The repository's common git directory, shared by its worktrees; `''` outside one. */
  const common = (dir) => {
    const found = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return found ? canonical(found) : '';
  };
  /** Is `dir` this project's main checkout or one of its worktrees? Another repository is not canon's. */
  const inProject = (dir) => common(dir) !== '' && common(dir) === common(ROOT);
  const refs = (dir) =>
    new Set(git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags').split('\n'));
  const isTag = (dir, name) =>
    refs(dir).has(`refs/tags/${name}`) && !refs(dir).has(`refs/heads/${name}`);
  const localBranches = (dir) =>
    [...refs(dir)].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice(11));

  // An MCP GitHub write names its branch outright. Judged only when it names this
  // project's own repository, read off `origin`.
  if (mcp) {
    const branch = payload.tool_input?.branch;
    const { owner, repo } = payload.tool_input ?? {};
    const origin = /([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      git(ROOT, 'remote', 'get-url', 'origin')
    );
    const same =
      origin &&
      String(owner).toLowerCase() === origin[1].toLowerCase() &&
      String(repo).toLowerCase() === origin[2].toLowerCase();
    if (typeof branch === 'string' && same && !branchAllowed(branch, config)) {
      refuse(`\`${payload.tool_name}\``, branch, 'is where it writes', false);
    }
    allow();
  }

  for (const call of calls) {
    // After a `cd` this cannot follow, nothing here knows which checkout the call is in.
    if (!call.dirKnown) continue;
    const dir = resolve(cwd, call.dir ?? '.');
    if (!inProject(dir)) continue;
    const current = git(dir, 'symbolic-ref', '--short', '-q', 'HEAD');

    if (call.kind === 'commit') {
      if (current && !branchAllowed(current, config))
        refuse(`\`git ${call.subcommand}\``, current, 'is checked out');
      continue;
    }

    // A push is judged by what it writes, not by what is checked out: `git push -u origin
    // feat/x` from `claude/x` is how commits moved off a generated branch get published.
    const { push } = call;
    let written = [];
    if (push.everyBranch) written = localBranches(dir);
    else if (push.bare) {
      const bare = bareTargets(push, current, {
        get: (key) => git(dir, 'config', key),
        getAll: (key) => git(dir, 'config', '--get-all', key).split('\n').filter(Boolean),
      });
      written = [
        ...bare.found.map((one) => one.branch),
        ...(bare.everyBranch ? localBranches(dir) : []),
      ];
    } else if (!push.unresolved) {
      written = writtenBranches(push).map((target) => (target === 'HEAD' ? current : target));
    }

    for (const branch of written) {
      // A ref outside `refs/heads/`, or a tag, is not a branch.
      if (!branch || branch.startsWith('refs/') || isTag(dir, branch)) continue;
      if (!branchAllowed(branch, config)) {
        refuse('`git push`', branch, 'is where it writes', branch === current);
      }
    }
  }

  allow();

  /**
   * `onIt` is true when the refused branch is the checked-out one, so the way out is
   * getting onto the issue's branch. Otherwise the session is on a canon branch and
   * the push only aimed elsewhere: push the branch to its own name.
   */
  function refuse(what, branch, how, onIt = true) {
    const { branches } = config;
    const naming = branchNaming(config);
    const wayOut = onIt
      ? "Get onto the issue's branch:\n\n" +
        '- It exists (its spec or tracker issue names it):\n' +
        '    git fetch origin && git checkout <branch>\n' +
        `- It does not: cut one from \`${branches.integration}\`. ${naming.rule}.\n` +
        `    git fetch origin && git checkout -b ${naming.example} --no-track origin/${branches.integration}\n\n` +
        'Uncommitted changes carry across a checkout. Commits already made here move with\n' +
        '`git cherry-pick`; say which ones you moved. Push with `git push -u origin HEAD`.\n\n'
      : 'Push the checked-out branch to its own name instead: `git push -u origin HEAD`.\n\n';
    console.error(
      `Refusing ${what}: \`${branch}\` ${how}, and canon work never goes on it.\n\n` +
        `Branch names here take ${allowedNames(config)}.\n` +
        "A branch the session was handed, such as a cloud session's `claude/<name>`, is never\n" +
        'used: work on it is invisible to the spec, the tracker, `/canon:review` and\n' +
        '`/canon:staging`. The canon branch is standing permission to commit and push there instead.\n\n' +
        wayOut +
        `If this branch is genuinely what was meant, say why in one line and re-run with\n` +
        `${BYPASS}=1 on the command.`
    );
    process.exit(2);
  }
} catch (error) {
  console.error(
    'Refusing the call: require-canon-branch.mjs crashed, so it cannot say whether this\n' +
      `commits or pushes from a branch canon allows.\n\n${error?.stack ?? error}\n\n` +
      'This is a bug in the canon plugin: please report it with the command above.\n' +
      `Setting ${BYPASS}=1 in the session environment lets calls past the crash, because it is\n` +
      'read before anything that can throw; say in one line why, and unset it after.'
  );
  process.exit(2);
}
