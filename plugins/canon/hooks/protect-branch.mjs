#!/usr/bin/env node
/**
 * PreToolUse hook on Edit, Write, NotebookEdit and Bash. Refuses to let a file in
 * the project be changed while the integration or production branch is checked
 * out, whether the change comes through the file tools or a Bash command that
 * writes.
 *
 * The push and merge guards stop a protected branch being written remotely. What
 * none of them covers is the *start* of the work: nothing stops an edit being made
 * on a protected branch, and the refusal only arrives at commit time, once the
 * change is already written. That gap is what this closes.
 *
 * Bash is covered because that is how a guard on the file tools gets walked past.
 * A session told to prefer Bash edits with a heredoc, `sed -i` or an inline
 * `node -e` script, and a hook watching only Edit and Write never sees any of it.
 * The intent test in `lib/writes-to-worktree.mjs` is a list of shapes rather than
 * a parser, so it is wrong in both directions occasionally: that is why the
 * refusal names the bypass in the same breath.
 *
 * Uncommitted work moves with `git checkout -b`, so being on the wrong branch is
 * free to fix right up until something is committed to it. Blocking at the first
 * edit means the recoverable window is the only one that ever exists.
 *
 * **It fails open, on purpose.** Every case this cannot answer, whether no git, a
 * detached HEAD, an unreadable payload, a path outside the repository's work trees, or a missing
 * or invalid `.claude/canon.json`, allows the edit. A hook that blocks when its own
 * check is broken costs more than the mistake it prevents, and the mistake here is
 * recoverable by construction. `/canon:setup` also has to be able to write the
 * config this hook would otherwise need.
 *
 * Set `ALLOW_PROTECTED_BRANCH_EDIT=1` to bypass it for a session. A hotfix
 * committed straight to the integration branch is a decision the owner may
 * legitimately make, and an unbypassable hook gets deleted rather than overridden.
 *
 * Exit codes are the hook contract: 0 says carry on, 2 blocks the call and sends
 * stderr back to Claude.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { canonical, loadConfig, projectRoot, readPayload } from './lib/config.mjs';
import { writesToWorktree } from './lib/writes-to-worktree.mjs';

/** Allow, silently. Used for every case this hook cannot answer. */
const allow = () => process.exit(0);

if (process.env.ALLOW_PROTECTED_BRANCH_EDIT === '1') allow();

const payload = await readPayload();
if (payload === null) allow();

const ROOT = projectRoot(payload);
const state = loadConfig(ROOT);
if (state.status !== 'ok') allow();
const { branches, owner } = state.config;
const PROTECTED = new Set([branches.integration, branches.production]);

const cwd = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : ROOT;

const bash = payload.tool_name === 'Bash';
const command = payload.tool_input?.command;
// Edit and Write carry `file_path`; NotebookEdit carries `notebook_path`.
const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;

if (bash) {
  if (!writesToWorktree(command)) allow();
} else if (typeof file !== 'string' || file.length === 0) {
  allow();
}

/**
 * **The branch of the work tree the write lands in**, not the project root's. A
 * worktree has its own `HEAD`, so reading ROOT judged work in a worktree by the main
 * checkout's branch: refused on a feature branch, allowed on `main`. Bash writes
 * where it runs, so that is the payload's cwd, as `protect-push.mjs` reads it; a file
 * tool writes where the file is, so that is its nearest existing directory.
 */
let dir = bash ? cwd : canonical(resolve(cwd, file));
while (!existsSync(dir) || !statSync(dir).isDirectory()) {
  const parent = dirname(dir);
  if (parent === dir) allow();
  dir = parent;
}

const git = (at, ...args) =>
  execFileSync('git', ['-C', at, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

let branch;
try {
  // A work tree of another repository is not this project's business, whatever its
  // branch is called. One sharing this project's git directory is.
  const common = (at) => canonical(resolve(at, git(at, 'rev-parse', '--git-common-dir')));
  if (common(dir) !== common(ROOT)) allow();
  const top = canonical(git(dir, 'rev-parse', '--show-toplevel'));
  if (!bash && !canonical(resolve(cwd, file)).startsWith(top.endsWith(sep) ? top : top + sep)) {
    allow();
  }
  branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
} catch {
  allow();
}

// `HEAD` is what a detached checkout reports. Not a protected branch, and not a
// situation this hook has an opinion about.
if (!PROTECTED.has(branch)) allow();

const prefixes = branches.prefixes.map((p) => `\`${p}/\``).join(', ');
console.error(
  (bash
    ? `Refusing to run a command that writes while \`${branch}\` is checked out:\n  ${command}\n\n`
    : `Refusing to edit ${file} while \`${branch}\` is checked out.\n\n`) +
    'Work belongs on a feature branch, made before the first edit rather than before the\n' +
    'commit. Nothing is lost by switching now: `git checkout -b` carries uncommitted\n' +
    'changes across.\n\n' +
    `Branch names take one of these prefixes and a kebab-case description: ${prefixes}.\n` +
    `Branch off \`${branches.integration}\`, never off \`${branches.production}\` and never off ` +
    'another feature branch.\n\n' +
    'Tell the user which branch you created and why, rather than doing it silently.\n\n' +
    `If ${owner} has deliberately chosen to work on this branch, they can set\n` +
    'ALLOW_PROTECTED_BRANCH_EDIT=1, but ask before assuming that is what they meant.'
);
process.exit(2);
