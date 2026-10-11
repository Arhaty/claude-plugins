#!/usr/bin/env node
/**
 * PreToolUse hook on Bash and on any MCP server's `merge_pull_request`. Blocks
 * `gh pr create`, `gh pr ready` and `gh pr merge`, and an MCP merge, when the pull
 * request changes code in a governed domain and updates no file in `docs/canon/`.
 *
 * The canon changes in the same pull request as the code that depends on it. A
 * rule nothing checks is a rule the next reader trusts and the code has quietly
 * stopped following. This is the check.
 *
 * **The trigger is the pull request as well as the merge.** Asking at
 * `gh pr create` is earlier than asking at the merge: the branch is complete, the
 * reasoning is still in context, and the pull request that opens already carries
 * the rule rather than gaining it in a follow-up commit that reviewers see after
 * they have read the diff. `merge` stays on the list as a backstop for a pull
 * request opened by hand or in the browser, where the create hook never ran.
 *
 * `gh pr create` is judged on the branch diff from git, because there is no pull
 * request to read yet. `gh pr merge` and `gh pr ready` are judged the same way when
 * they act on the checked-out feature branch, and on the pull request GitHub
 * describes, like an MCP merge, when they name one (a number, a URL, a branch) or
 * run from a protected branch. Diffing the checked-out branch there judged a
 * different pull request, or none: on the integration branch the backstop allowed
 * every merge.
 *
 * It only ever asks. It cannot tell whether a change decided anything, so a branch
 * that touches a governed path and settles nothing is a normal outcome: say so and
 * set `ALLOW_UNDECIDED_MERGE=1`, in the session environment or as an assignment on
 * the `gh` command itself: `ALLOW_UNDECIDED_MERGE=1 gh pr create ...`. The hook
 * runs in its own process and never inherits the command's environment, so it reads
 * that assignment off the parsed command, which is the form `/canon:canon` and
 * `/canon:ship` use. Text in a quoted `--body` is an argument, not an assignment, and does not
 * count. What it prevents is the silent case, where a rule
 * changes and the canon file that records it never hears about it.
 *
 * The project's `.claude/canon-domains.json` owns the map. Do not add a path here.
 *
 * Fails open on a diff or a pull request it cannot read, unlike `protect-merge.mjs`.
 * That one guards what ships and refuses when it cannot see; this one guards the
 * canon, and blocking a pull request because git could not resolve a ref would cost
 * more than the missing rule.
 *
 * Fails closed when it crashes. A crash is not a slow git but a deterministic one,
 * such as a malformed `canon-domains.json` or `lib/merge-command.mjs` failing to load,
 * and exiting anything but 2 would switch the gate off on every pull request,
 * silently, which is the case it exists to prevent. Everything that can throw runs
 * inside one `try`, the shared module is imported dynamically inside it so a link
 * failure lands there too, and the `catch` refuses every call.
 * `ALLOW_UNDECIDED_MERGE` from the session environment is read before the `try`, so
 * it still bypasses a crash; the inline form is read off the parsed command, so it
 * does not. A missing or invalid `.claude/canon.json`, or a missing map, refuses
 * the calls this hook judges, with the reason, until `/canon:setup` repairs it.
 *
 * Exit codes are the hook contract: 0 says carry on, 2 blocks the call and sends
 * stderr back to Claude.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const allow = () => process.exit(0);

const block = (message) => {
  console.error(message);
  process.exit(2);
};

if (process.env.ALLOW_UNDECIDED_MERGE === '1') allow();

try {
  const { mergesIn, prCalls, prDetails, prFiles } = await import('./lib/merge-command.mjs');
  const { DOMAINS_PATH, canonical, configProblem, loadConfig, projectRoot, readPayload } =
    await import('./lib/config.mjs');

  const payload = await readPayload();
  if (payload === null) allow();

  const ROOT = projectRoot(payload);
  const state = loadConfig(ROOT);
  if (state.status === 'absent') allow();
  const MAP = join(ROOT, DOMAINS_PATH);

  const isMcpMerge = /^mcp__.+__merge_pull_request$/.test(payload?.tool_name ?? '');
  const judged =
    isMcpMerge || prCalls(payload?.tool_input?.command, ['create', 'ready', 'merge']).length > 0;
  if (!judged) allow();
  if (state.status !== 'ok') block(configProblem(state, 'require-canon.mjs'));
  if (!existsSync(MAP)) {
    block(
      `canon: require-canon.mjs cannot run. ${DOMAINS_PATH} is missing.\n\n` +
        'Run /canon:setup to restore it. It maps repository paths to the canon file that\n' +
        'governs them, and without it this hook cannot tell which changes need a canon update.'
    );
  }
  const { integration, production } = state.config.branches;

  /**
   * Where the command runs: the payload's cwd, as `protect-push.mjs` reads it. A
   * worktree has its own `HEAD`, so reading ROOT judged a pull request from a
   * worktree by whatever the main checkout had out, and `gh` with no selector acts on
   * the cwd's branch too.
   */
  const DIR = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : ROOT;

  // A command run in another repository is about that repository's pull requests,
  // which this project's map does not govern. Unreadable on either side is judged
  // as before, against the project.
  const commonDir = (dir) => {
    try {
      return canonical(
        execFileSync(
          'git',
          ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        ).trim()
      );
    } catch {
      return null;
    }
  };
  const here = commonDir(DIR);
  const project = commonDir(ROOT);
  if (here !== null && project !== null && here !== project) allow();

  // A merge through an MCP server's tool carries no command, so it is judged on the pull
  // request it names rather than on a local diff: the files GitHub lists for it. Without
  // this branch the tool's `settings.json` entry ran the hook and the hook found nothing
  // to read. Unreadable fails open, as below; `protect-merge.mjs` refuses it anyway.
  if (isMcpMerge) {
    const [merge] = mergesIn(payload);
    const refused = merge?.selector == null ? null : fromPullRequest(merge.selector, 'the merge');
    if (refused) block(refused);
    allow();
  }

  // Any of the three is enough to ask the question; which one it was only affects the
  // wording of the refusal. Reading them all matters for the same reason it does in
  // `protect-merge.mjs`: one Bash call can hold more than one.
  const calls = prCalls(payload?.tool_input?.command, ['create', 'ready', 'merge']);
  if (calls.length === 0) allow();

  // A git failure is an unreadable diff, not a crash: it fails open, per the header.
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', DIR, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  const current = git('rev-parse', '--abbrev-ref', 'HEAD')?.trim() ?? null;
  const protectedBranch = current === integration || current === production;

  for (const call of calls) {
    // The assignment on this `gh` command, not one anywhere in the text: a `--body` that
    // quotes the bypass is an argument, and `invocations` never reads it as an assignment.
    if (call.env.ALLOW_UNDECIDED_MERGE === '1') continue;

    const verb = `\`gh pr ${call.subcommand}\``;
    const [selector] = call.positionals;
    const refused =
      call.subcommand !== 'create' && (selector !== undefined || protectedBranch)
        ? fromCall(call, verb)
        : fromDiff(call, verb);
    if (refused) block(refused);
  }

  allow();

  /**
   * A `gh pr merge` or `gh pr ready` judged on the pull request it acts on. Aimed at
   * another repository, or fed its selector by `xargs`, it cannot be read by number
   * here, and fails open like any other unreadable pull request.
   */
  function fromCall(call, verb) {
    if (call.flags.has('--repo') || call.flags.has('-R')) return null;
    if (call.env.GH_REPO !== undefined || call.appended) return null;
    return fromPullRequest(call.positionals.slice(0, 1), `Refusing ${verb}`);
  }

  /** Reads the pull request `selector` names and judges the files GitHub lists for it. */
  function fromPullRequest(selector, action) {
    const details = prDetails(selector, { cwd: DIR });
    // A release pull request: see `fromDiff`.
    if (!details.ok || details.pr.baseRefName === production) return null;
    const files = prFiles(details.pr, { cwd: DIR });
    if (!files.ok) return null;
    return refusal(files.paths, `${action}: pull request #${details.pr.number}`);
  }

  /** A `gh pr` subcommand judged on the branch diff from git. */
  function fromDiff(call, verb) {
    /**
     * `--base` and `--head` as the command actually gave them, in any spelling gh
     * takes: `-B`, `--base=main`, `--base "main"`.
     *
     * **Ignoring these blocked the release.** `/canon:production` deliberately does not
     * check anything out (`--head` does that work) and runs
     * `gh pr create --base <production> --head <integration>` from wherever the session is.
     * Reading the diff from the checked-out branch then judged a pull request by the
     * contents of a different one, so a feature branch with governed changes refused the
     * release over files that were not in it.
     *
     * **Read from the parsed arguments, not the text.** A `--body` that mentions
     * `--base main` in prose once made this return `main`, and the early return below
     * then skipped the whole canon gate. Parsed, the body is one argument and the flag
     * inside it is that argument's text.
     */
    const flag = (...names) => {
      const value = call.pairs.filter(([name]) => names.includes(name)).at(-1)?.[1];
      return typeof value === 'string' ? value.replace(/^refs\/heads\//, '') : null;
    };
    const base = flag('--base', '-B');
    const head = flag('--head', '-H');

    /**
     * A release pull request carries no new code: every change in it was checked on the
     * way into the integration branch. Asking again would ask twice, and the second ask
     * lands on whoever is cutting the release rather than on whoever wrote the code.
     */
    if (base === production) return null;

    // The branch whose diff this is about: what `--head` named, or the checked-out one.
    const branch = head ?? current;
    if (!branch || branch === integration || branch === production) return null;

    // **Refresh the tracking ref before diffing against it.** Three dots resolves
    // through the merge base, so a stale tracking ref picks an older base and the diff
    // then lists every file that landed on the base in between: the hook refuses
    // `gh pr create` over paths the branch never touched, which is the most
    // infuriating shape a false refusal can take because the diff it names looks real.
    const baseBranch = base ?? integration;

    /**
     * **Bounded, because this runs in front of a tool call.** An unbounded fetch in a
     * PreToolUse hook is a hook that can hang: a slow network, a credential prompt or an
     * unreachable remote would stall every `gh pr create` for as long as git is willing
     * to wait, with nothing on screen explaining why. Ten seconds is longer than this
     * fetch takes and shorter than anyone's patience.
     *
     * Failing is fine and silent. The old tracking ref stays in place and the check runs
     * against it, which is exactly the behaviour this had before the fetch existed.
     */
    try {
      execFileSync('git', ['-C', DIR, 'fetch', '--quiet', 'origin', baseBranch], {
        stdio: 'ignore',
        timeout: 10_000,
        // No terminal prompt for credentials: a hook must never wait on input nobody can
        // see it asking for.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      // Stale ref, and the diff below is computed against it.
    }

    // Three dots: what this branch changed, ignoring what landed on the base since it
    // was cut. A two-dot range would blame the branch for every unrelated merge.
    //
    // `head` is compared as a ref rather than as `HEAD`, so a pull request opened for
    // another branch is judged by that branch's contents.
    const diff = git('diff', '--name-only', `origin/${baseBranch}...${head ?? 'HEAD'}`);
    if (diff === null) return null;

    return refusal(diff.split('\n').filter(Boolean), `Refusing ${verb}: \`${branch}\``);
  }

  /** The refusal for the paths a pull request changes, naming `subject`, or `null`. */
  function refusal(paths, subject) {
    if (paths.length === 0) return null;

    // A canon file changed. Whether it is the right one, and whether it says the right
    // thing, is `/canon:review`'s question and the owner's, not a path map's.
    if (paths.some((path) => path.startsWith('docs/canon/'))) return null;

    const map = JSON.parse(readFileSync(MAP, 'utf8'));

    /**
     * Trailing slash is a directory prefix, an inner slash is an exact path, and a
     * bare name matches that basename anywhere. Kept dumb so the map stays readable:
     * see the `$comment` block in the project's `.claude/canon-domains.json`.
     */
    const matches = (path, pattern) =>
      pattern.endsWith('/')
        ? path.startsWith(pattern)
        : pattern.includes('/')
          ? path === pattern
          : basename(path) === pattern;

    const governed = Object.entries(map)
      .filter(([file]) => file !== '$comment')
      .map(([file, patterns]) => [
        file,
        paths.filter((path) => patterns.some((p) => matches(path, p))),
      ])
      .filter(([, hits]) => hits.length > 0);

    if (governed.length === 0) return null;

    const listed = governed
      .map(([file, hits]) => `  ${file}\n${hits.map((hit) => `    ${hit}`).join('\n')}`)
      .join('\n');

    return (
      `${subject} changes code in a governed domain and\n` +
      `carries no update to \`docs/canon/\`.\n\n${listed}\n\n` +
      'The canon changes in the same pull request as the code that depends on it.\n' +
      'After the pull request is open the reasoning is out of context, and what gets written\n' +
      'later is a summary of the diff rather than a decision.\n\n' +
      'Run `/canon:canon <file>` for each one above. It writes the rule and commits it on this\n' +
      'branch, or says in one line that the change settles nothing.\n\n' +
      'If the change genuinely settles nothing, which is a normal outcome for a rename, a fix,\n' +
      'a dependency bump or a test, say so in one line and re-run with ALLOW_UNDECIDED_MERGE=1\n' +
      'in front of the `gh` command. Do not set it without saying which change it covers and\n' +
      'why no rule moved.'
    );
  }
} catch (error) {
  block(
    'Refusing the call: require-canon.mjs crashed, so it cannot say whether this pull request\n' +
      `needs a canon update.\n\n${error?.stack ?? error}\n\n` +
      'This is a bug in the canon plugin, or a malformed .claude/canon-domains.json: check the\n' +
      'map first, and report the plugin bug otherwise.\n' +
      'ALLOW_UNDECIDED_MERGE=1 in the session environment still works, because it is read before\n' +
      'anything that can throw. In front of the command it does not: the hook reads that form\n' +
      'off the parsed command, and a crash can come before the parse.'
  );
}
