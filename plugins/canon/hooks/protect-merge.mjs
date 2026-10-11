#!/usr/bin/env node
/**
 * PreToolUse hook on Bash and on any MCP server's `merge_pull_request`. Blocks any
 * merge whose target is the production branch, however it is issued: `gh pr merge`,
 * a `gh api` PUT to `/pulls/{n}/merge` or `/pulls/{n}/ccr/auto_merge`, or the MCP
 * merge tool. Also blocks landing on production with no pull request at all: a
 * `gh api` POST to `/merges` with that base, or any write to its branch ref.
 *
 * Production only. `/canon:staging` merges into the integration branch itself once
 * CI is green, which is the asymmetry the workflow rests on: a bad merge into
 * integration costs a revert, and waiting on a review only the owner can give is
 * the slowest part of the loop. The release into production is the owner's, always,
 * and it is the only quality gate in the system.
 *
 * A blanket deny rule on a merge cannot express that, because the base branch is a
 * property of the pull request rather than of the command line, so the decision
 * needs the API. That is what this does.
 *
 * **It fails closed, on purpose**, which is the opposite of `protect-branch.mjs`.
 * That one guards an edit, which is recoverable; this one guards a merge, which
 * ships code. When the base cannot be determined, the merge does not happen and the
 * owner presses the button. The cost of a wrong block is one sentence of
 * explanation.
 *
 * That covers the hook crashing as well as `gh` failing or hanging, and a project
 * with `docs/canon/` whose `.claude/canon.json` is missing or invalid, where the
 * production branch is unknown. Claude Code reads any exit but 2 as permission, so
 * an uncaught throw, or `lib/merge-command.mjs` failing to load, would wave every
 * merge through. Everything that can throw runs inside one `try`, the shared module
 * is imported dynamically inside it so a link failure lands there too, and the
 * `catch` refuses every call: a parser that crashed cannot say which calls are
 * merges. A `gh` read that hangs is killed by the deadline in `merge-command.mjs`
 * before this hook's own timeout, which Claude Code would otherwise treat as
 * non-blocking.
 *
 * There is no environment bypass, and it does not need one: the button in the
 * GitHub UI is the escape valve, and it is the owner's either way.
 *
 * Exit codes are the hook contract: 0 says carry on, 2 blocks the call and sends
 * stderr back to Claude.
 */

import { existsSync } from 'node:fs';

const allow = () => process.exit(0);

const block = (message) => {
  console.error(message);
  process.exit(2);
};

try {
  const { mergesIn, prDetails } = await import('./lib/merge-command.mjs');
  const { configProblem, loadConfig, projectRoot, readPayload } = await import('./lib/config.mjs');

  const payload = await readPayload();
  // An unreadable payload is not a merge, because a merge would have parsed.
  if (payload === null) allow();

  const ROOT = projectRoot(payload);
  const state = loadConfig(ROOT);
  if (state.status === 'absent') allow();
  const CWD = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : ROOT;

  /**
   * **Every merge in the call, not the first.** `gh pr merge 7 && gh pr merge 9` was
   * judged by the first alone, so the second reached no check at all.
   */
  const merges = mergesIn(payload);
  if (merges.length === 0) allow();

  if (state.status !== 'ok') block(configProblem(state, 'protect-merge.mjs'));
  const { branches, owner } = state.config;
  const production = branches.production;

  for (const merge of merges) {
    if ('branch' in merge) {
      if (merge.branch === production) refuseDirect(production, owner);
      if (merge.branch === null) {
        block(
          'Refusing the merge: it merges branches with no pull request, and its base cannot be\n' +
            `read from the command, so it may land on \`${production}\`.\n\n` +
            'Name the base literally, or merge through a pull request.'
        );
      }
      continue;
    }

    if (merge.selector === null) {
      block(
        'Refusing the merge: it names another repository, or reaches the merge through a\n' +
          'form whose pull request cannot be read, so its base branch is unknown and it may be\n' +
          `the release into \`${production}\`.\n\n` +
          `Merge by number against this repository, or hand the URL to ${owner}.`
      );
    }

    // A selector this cannot evaluate is refused, because the base branch is
    // unknown. The message is what differs: "name the number" is actionable, where
    // "could not be read" describes a lookup failure nobody can debug.
    const [selector] = merge.selector;
    if (selector !== undefined && /[$`]/.test(selector)) {
      block(
        'Refusing the merge: the pull request is named by a shell expansion\n' +
          `(\`${selector}\`), which this hook cannot evaluate, so it cannot tell whether\n` +
          `the base branch is \`${production}\`.\n\n` +
          'Pass the number literally (`gh pr merge 42 --merge`) or drop the selector to act on\n' +
          `the current branch's pull request. Merging into \`${branches.integration}\` is allowed.`
      );
    }

    // Fails closed. `prDetails` reports an unreadable pull request rather than
    // throwing, because the caller decides what that means and this one refuses.
    // From the payload's cwd, as `protect-push.mjs` reads it: with no selector, `gh`
    // acts on the branch checked out there, which in a worktree is not ROOT's.
    const details = prDetails(merge.selector, { cwd: CWD });

    if (!details.ok) {
      block(
        'Refusing the merge: the pull request it targets could not be read, so its base\n' +
          `branch is unknown and it may be the release into \`${production}\`.\n\n` +
          `Name the pull request number explicitly and try again, or hand the URL to ${owner}.`
      );
    }

    if (details.pr.baseRefName === production) {
      refuseRelease(details.pr.number, production, owner);
    }
  }

  allow();
} catch (error) {
  block(
    'Refusing the call: protect-merge.mjs crashed, so it cannot say whether this merges into\n' +
      `production.\n\n${error?.stack ?? error}\n\n` +
      'This is a bug in the canon plugin: please report it with the command above. Merge in\n' +
      'the GitHub UI in the meantime.'
  );
}

function refuseDirect(production, owner) {
  block(
    `Refusing the write: it lands on \`${production}\` with no pull request, through the\n` +
      'merges endpoint or the branch ref itself.\n\n' +
      `\`${production}\` is production and takes no direct push. The release is ${owner}'s,\n` +
      'always, and it goes through the release pull request. Run `/canon:production`, which\n' +
      'opens it and stops at the button.'
  );
}

function refuseRelease(number, production, owner) {
  block(
    `Refusing the merge: pull request #${number} targets \`${production}\`.\n\n` +
      `\`${production}\` is production. The release is ${owner}'s, always, and it is the only\n` +
      'quality gate in the system.\n\n' +
      'Run `/canon:production` instead. It opens or refreshes the release pull request, writes\n' +
      'the manifest of everything that would ship, watches CI, and stops at the button. Then\n' +
      'report the URL and say it is ready but not merged.'
  );
}
