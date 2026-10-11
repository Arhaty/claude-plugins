#!/usr/bin/env node
/**
 * UserPromptSubmit hook. Says, once per turn, that a protected branch is checked
 * out and the next thing to do is branch.
 *
 * `protect-branch.mjs` is the refusal and it arrives at the first write, which is
 * already one step late. This says it before the first tool call, which is where
 * "branch from the integration branch" was always meant to happen.
 *
 * It also says when the project has `docs/canon/` but a missing or invalid
 * `.claude/canon.json`, because that is the state in which the other guards
 * refuse what they protect, and finding out at the first push is late.
 *
 * It never blocks. Stdout on exit 0 is added to the turn as context, and a prompt
 * that has nothing to do with the repository is not worth refusing over.
 */

import { execFileSync } from 'node:child_process';

import { configProblem, loadConfig, projectRoot, readPayload } from './lib/config.mjs';

const payload = await readPayload();
const ROOT = projectRoot(payload);
const state = loadConfig(ROOT);

if (state.status === 'absent') process.exit(0);
if (state.status !== 'ok') {
  process.stdout.write(`${configProblem(state, 'canon')}\n`);
  process.exit(0);
}

if (process.env.ALLOW_PROTECTED_BRANCH_EDIT === '1') process.exit(0);

const { branches } = state.config;

let branch;
try {
  branch = execFileSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  process.exit(0);
}

if (branch !== branches.integration && branch !== branches.production) process.exit(0);

const prefixes = branches.prefixes.map((p) => `\`${p}/\``).join(', ');
process.stdout.write(
  `\`${branch}\` is checked out, which takes no direct commit. If this turn changes anything ` +
    'in the repository, create the branch first and say so:\n\n' +
    '  git checkout -b <branch>\n\n' +
    `Branch names take one of these prefixes and a kebab-case description: ${prefixes}. ` +
    `Branch off \`${branches.integration}\`, never off \`${branches.production}\` and never off ` +
    'another feature branch. Reading, running the test suite and answering a question are all ' +
    'fine here and need no branch.\n'
);
