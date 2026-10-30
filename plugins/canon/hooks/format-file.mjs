#!/usr/bin/env node
/**
 * PostToolUse hook on Edit, Write and NotebookEdit. Runs the project's `formatFile` command on
 * the one file that was just written, and on nothing else.
 *
 * **It exists because the obvious one-liner is dangerous.** Wiring the hook as
 * `prettier --write "$CLAUDE_TOOL_INPUT_FILE_PATH"` looks fine and is not: that
 * variable is not populated, so the command degrades to `prettier --write ""`, and
 * prettier resolves an empty pattern to the working directory. The result is a
 * whole-repository reformat after every single edit. So the path is read from the
 * payload on stdin, where the hook contract puts it, and the run is skipped
 * entirely when there is no path to read.
 *
 * **No shell.** `formatFile` in `.claude/canon.json` is an argv list, and the file
 * path is appended as one more argument to `execFileSync`. A path holding spaces,
 * quotes or `$(...)` reaches the formatter as text, never as shell syntax.
 *
 * **It runs only a command the owner approved, for this project, outside it.**
 * `formatFile` comes from the repository, so a clone can name any program in it,
 * and any switch kept in the repository (an `enabledPlugins` key, say) is one the
 * same commit can flip. `/canon:setup` asks, then records the approval in
 * `~/.claude/canon/trusted.json`, keyed by the repository's git directory (shared
 * by its worktrees, not by another clone) and the sha256 of the argv list. The hook runs only on an exact match: a command that changes, from a
 * pull, a branch switch or an edit, turns the hook off until setup asks again.
 *
 * A cloud container never has that file. There, `CANON_TRUST_FORMAT_SHA256` set to the same
 * sha256 in the cloud environment's settings is the approval; set in the project's own
 * `.claude/settings*.json`, it is the repository approving itself, and ignored.
 *
 * Exit code is always 0. A formatter that fails is not a reason to fail the edit,
 * and the project's format check is there to catch what this misses.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { canonical, isTrusted, loadConfig, projectRoot, readPayload } from './lib/config.mjs';

const done = () => process.exit(0);

const payload = await readPayload();
if (payload === null) done();

const target = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
// The whole point: no path means no run, never a run over everything.
if (typeof target !== 'string' || target.trim() === '') done();

const ROOT = projectRoot(payload);
const state = loadConfig(ROOT);
if (state.status !== 'ok') done();

const argv = state.config.formatFile;
if (argv === null) done();
if (!isTrusted(ROOT, argv)) done();

const cwd = typeof payload.cwd === 'string' ? payload.cwd : ROOT;
const full = canonical(resolve(cwd, target));
if (!full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) done();
if (!existsSync(full)) done();

try {
  execFileSync(argv[0], [...argv.slice(1), full], {
    cwd: ROOT,
    stdio: 'ignore',
    timeout: 25_000,
  });
} catch {
  // Deliberately silent. See the header.
}
done();
