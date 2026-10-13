#!/usr/bin/env node
/**
 * PreToolUse hook on Bash. Refuses a `git push` that would write to the
 * integration or production branch named in `.claude/canon.json`.
 *
 * Neither branch takes a direct push. `git push` is commonly pre-approved, so
 * there is no prompt; `writesToWorktree` returns false for a push, so
 * `protect-branch.mjs` never looks; and `protect-merge.mjs` only watches merges.
 * Without this, a push straight to production has neither a gate nor a question
 * in front of it.
 *
 * Git's own `push.default=simple` catches one shape of this — a bare `git push`
 * from a branch whose upstream has a different name is refused — but it then
 * prints `git push origin HEAD:<integration>` as the suggested fix, which is
 * exactly the command nothing was checking. A branch created with
 * `git checkout -b work origin/<integration>` has the integration branch as its
 * upstream, so this is the normal state of a correctly created branch.
 *
 * The destination is resolved the way git resolves it rather than read off the
 * text: `src:dst` takes `dst`, a refspec with no colon takes its source, `HEAD` is
 * the checked-out branch, `heads/x` is `x`, and a push naming no refspec is
 * judged against the checked-out branch, its upstream, `push.default` and any
 * `remote.<name>.push`, because which one git uses depends on configuration. A
 * delete (`--delete`, `-d`, `:x`) writes the branch it names, and `:`, a
 * wildcard refspec and `push.default=matching` write every branch. Config set on
 * the command itself (`git -c`, `GIT_CONFIG_KEY_<n>`) wins over the repository's,
 * as it does in git, and `git -C` changes whose `HEAD` is read.
 *
 * `git push -u origin HEAD` is the right way to push a feature branch and must keep
 * working.
 *
 * **It fails open on a command it cannot parse**, and that is a deliberate trade
 * rather than an oversight. Pushing a feature branch is something that happens
 * many times an hour, so a guard that refuses whatever it fails to understand
 * would be switched off within a day. What it is here to catch is the explicit,
 * readable case, which is also the only case anyone actually types.
 *
 * Two bypasses, one per check. `ALLOW_PROTECTED_PUSH=1` permits a push that lands on
 * a protected branch, which is a real thing to do once when setting up a remote.
 * `ALLOW_FORCE_PUSH=1` permits a history rewrite. They are separate on purpose: a
 * hotfix to a protected branch and a rewrite of shared history are different decisions and
 * must not be granted by the same variable.
 *
 * **It fails closed when it crashes**, which is a different thing from a parse it
 * cannot do. A crash is deterministic, `push-command.mjs` failing to load or a
 * throw on some input, and Claude Code reads any exit but 2 as permission, so an
 * uncaught one would wave every push through, production included, on every call until
 * someone noticed. Everything that can throw runs inside one `try`, the shared
 * module is imported dynamically inside it so a link failure lands there too, and
 * the `catch` refuses every call, as `protect-merge.mjs` and `require-canon.mjs` do.
 * The bypasses are read before the `try`. A crashed hook has checked neither the
 * force nor the destination, so only both together let a call past it.
 *
 * A project with `docs/canon/` but a missing or invalid `.claude/canon.json` has
 * no protected branches this hook can name, so every push is refused with the
 * reason until `/canon:setup` repairs it. A project with neither is not a canon
 * project and is left alone.
 *
 * Exit codes are the hook contract: 0 says carry on, 2 blocks the call and sends
 * stderr back to Claude.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const allow = () => process.exit(0);

let PROTECTED = new Set();
let OWNER = 'the owner';
let BOTH = 'a protected branch';

const ALLOW_FORCE = process.env.ALLOW_FORCE_PUSH === '1';
const ALLOW_PROTECTED = process.env.ALLOW_PROTECTED_PUSH === '1';

try {
  const { pushTargets, readRefspec } = await import('./lib/push-command.mjs');
  const { configProblem, loadConfig, projectRoot, readPayload } = await import('./lib/config.mjs');

  const payload = await readPayload();
  if (payload === null) allow();

  const ROOT = projectRoot(payload);
  const state = loadConfig(ROOT);
  if (state.status === 'absent') allow();

  const push = pushTargets(payload?.tool_input?.command);
  if (!push) allow();

  if (state.status !== 'ok') {
    console.error(configProblem(state, 'protect-push.mjs'));
    process.exit(2);
  }
  const { branches, owner } = state.config;
  PROTECTED = new Set([branches.integration, branches.production]);
  OWNER = owner;
  BOTH = `${branches.integration}\` and \`${branches.production}`;

  /**
   * **Every read shares one deadline inside the hook's 15 seconds.** A hook that times
   * out is non-blocking, so a hung git would let the push through. A read that runs out
   * of time refuses the push: an empty answer would read as "not protected".
   */
  const deadline = Date.now() + 10_000;
  const git = (dir, ...args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: Math.max(1, deadline - Date.now()),
      }).trim();
    } catch (error) {
      if (error?.code === 'ETIMEDOUT' || Date.now() >= deadline) {
        fail(
          push.targets.join('`, `') || 'an unknown branch',
          `\`git ${args.join(' ')}\`, which did not answer in time. Name the branch literally`
        );
      }
      return '';
    }
  };

  // **A force push is refused wherever it points.** Never force-push and never
  // rewrite a pushed commit is not a rule about
  // protected branches: rewriting a feature branch someone else has pulled, or that a
  // pull request has already been reviewed against, costs the same either way.
  //
  // A permission deny rule on `git push --force` is a prefix rule, so
  // `git push origin HEAD --force` satisfies it and arrives here unexamined. A `+`
  // refspec and `--mirror` are force pushes too.
  if (push.force && !ALLOW_FORCE) {
    console.error(
      'Refusing `git push`: it forces (a force flag, a `+` refspec or `--mirror`).\n\n' +
        'Never force-push, and never rewrite a commit that has already been pushed. A rewritten\n' +
        'branch breaks anyone who has pulled it and silently invalidates a review done against\n' +
        'the old history.\n\n' +
        'The usual alternative is a new commit that undoes what is wrong, which keeps the history\n' +
        'honest. `git revert` is the tool.\n\n' +
        'If a rewrite is genuinely what was meant, say in one line which branch and why nobody else\n' +
        'holds it, and re-run with ALLOW_FORCE_PUSH=1.'
    );
    process.exit(2);
  }

  // A target this cannot evaluate is refused, for the reason `protect-merge.mjs`
  // refuses an unreadable pull request: the destination may be production, and answering
  // "not protected" because the string does not literally name it is the wrong
  // direction for a guard on what ships. `xargs` supplying the refspec is the same.
  if (push.unresolved) {
    fail(
      push.targets.join('`, `') || 'an unknown branch',
      'a shell expansion or `xargs` input this hook cannot evaluate. Name the branch literally'
    );
  }

  // **Two independent bypasses, because these are two independent checks.**
  // `ALLOW_FORCE_PUSH=1` covers the rewrite above; `ALLOW_PROTECTED_PUSH=1` covers
  // where the push lands. Collapsing them into one variable means asking for a hotfix
  // to the integration branch also silently permits a history rewrite, which is not the same
  // decision and should not travel with it.
  if (ALLOW_PROTECTED) allow();

  // `--all`, `--branches`, `--mirror`, `:`, a wildcard refspec and a command-level
  // `push.default=matching` write every branch, which necessarily includes both
  // protected ones. There is no refspec to inspect and no configuration that makes it
  // safe, so this is refused before anything else is considered.
  if (push.everyBranch) {
    fail(BOTH, 'a push of every branch (`--all`, `--mirror`, `:` or a wildcard)');
  }

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ROOT;

  for (const one of push.pushes) {
    const dir = resolve(cwd, one.dir ?? '.');
    // The command's own config wins over the repository's, as it does in git.
    const setting = (key) => one.config[key.toLowerCase()] ?? git(dir, 'config', key);
    const settings = (key) =>
      key.toLowerCase() in one.config
        ? [one.config[key.toLowerCase()]]
        : git(dir, 'config', '--get-all', key).split('\n').filter(Boolean);
    // After a `cd` this cannot follow, nothing here knows which checkout's `HEAD`
    // or upstream the push reads.
    if (!one.dirKnown && (one.bare || one.targets.includes('HEAD'))) {
      fail(
        push.targets.join('`, `') || 'an unknown branch',
        'a `cd` earlier in the command, so this hook cannot tell which checkout reads `HEAD` and the upstream. Run the `cd` in its own call, or name the branch literally'
      );
    }
    const current = git(dir, 'symbolic-ref', '--short', '-q', 'HEAD');

    // `HEAD` and a bare push both mean the checked-out branch. When there is none to
    // read (a detached `HEAD`, a `-C` naming no repository, or a git read that timed
    // out), comparing `''` against the protected set answers "not protected" about a
    // push that may land on a protected branch.
    if (!current && (one.bare || one.targets.includes('HEAD'))) {
      fail(
        push.targets.join('`, `') || 'an unknown branch',
        `\`HEAD\` in \`${dir}\`, which names no branch this hook can read. Name the branch literally`
      );
    }

    // `HEAD` means the current branch, which is how a feature branch is meant to be
    // pushed and must not be refused on the strength of the word alone.
    for (const target of one.targets) {
      const branch = target === 'HEAD' ? current : target;
      if (PROTECTED.has(branch)) fail(branch, 'the refspec');
    }

    if (!one.bare) continue;

    /**
     * A push with no refspec goes where configuration sends it: the current branch to
     * itself or to its upstream, depending on `push.default`, every matching branch
     * under `matching`, or whatever `remote.<name>.push` says, which replaces both.
     * Git refuses some of these itself under the default `simple`; agreeing with it
     * costs nothing.
     */
    if (setting('push.default') === 'matching') {
      fail(BOTH, '`push.default=matching`, which pushes every matching branch');
    }
    if (PROTECTED.has(current)) fail(current, 'the current branch');
    const upstream = current
      ? setting(`branch.${current}.merge`).replace(/^(?:refs\/)?heads\//, '')
      : '';
    if (PROTECTED.has(upstream)) fail(upstream, `this branch's upstream (\`${upstream}\`)`);

    for (const refspec of settings(`remote.${one.remote ?? 'origin'}.push`)) {
      const read = readRefspec(refspec);
      const branch = read.target === 'HEAD' ? current : read.target;
      if (read.everyBranch) fail(BOTH, `\`remote.${one.remote ?? 'origin'}.push\``);
      if (PROTECTED.has(branch)) fail(branch, `\`remote.${one.remote ?? 'origin'}.push\``);
    }
  }

  allow();
} catch (error) {
  if (ALLOW_FORCE && ALLOW_PROTECTED) allow();
  console.error(
    'Refusing the call: protect-push.mjs crashed, so it cannot say whether this pushes to\n' +
      `a protected branch, or forces.\n\n${error?.stack ?? error}\n\n` +
      'This is a bug in the canon plugin: please report it with the command above.\n' +
      'Setting both ALLOW_PROTECTED_PUSH=1 and ALLOW_FORCE_PUSH=1 in the session environment\n' +
      'lets calls past the crash, because they are read before anything that can throw; say in\n' +
      'one line why, and unset them after.'
  );
  process.exit(2);
}

function fail(target, how) {
  console.error(
    `Refusing \`git push\`: it would write to \`${target}\`, named by ${how}.\n\n` +
      `\`${BOTH}\` take no direct push. Work reaches the integration branch through a pull\n` +
      'request that `/canon:staging` opens, checks and merges, and reaches production only\n' +
      `through the release pull request, which is ${OWNER}'s to merge.\n\n` +
      'To push the current branch, name it rather than relying on the upstream:\n\n' +
      '  git push -u origin HEAD\n\n' +
      'That is also the fix for the hint git prints when a bare push is refused: it suggests\n' +
      '`git push origin HEAD:<branch>`, which is the thing this hook exists to stop.\n\n' +
      'If pushing a protected branch is genuinely what was meant, which is a real thing to do once\n' +
      'when setting up a remote, say so in one line and re-run with ALLOW_PROTECTED_PUSH=1.'
  );
  process.exit(2);
}
