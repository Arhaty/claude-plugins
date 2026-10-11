#!/usr/bin/env node
/**
 * Print the project's `.claude/canon.json` for a skill to read, or say why it
 * cannot, and exit 1. Every skill except `/canon:setup` runs this first.
 *
 *   node config.mjs [project]
 *
 * `project` defaults to the git work tree holding the current directory.
 */

import { CONFIG_PATH, configProblem, loadConfig, projectRoot } from '../hooks/lib/config.mjs';

const root = process.argv[2] ?? projectRoot({ cwd: process.cwd() });
const state = loadConfig(root);

if (state.status === 'ok') {
  process.stdout.write(`${JSON.stringify({ root, ...state.config }, null, 2)}\n`);
} else {
  process.stderr.write(
    state.status === 'absent'
      ? `canon: ${root} has no ${CONFIG_PATH}. Run /canon:setup first.\n`
      : `${configProblem(state, 'this command')}\n`
  );
  process.exitCode = 1;
}
