/**
 * Every hook script, executed.
 *
 * This suite exists because of a specific failure in the project this was extracted
 * from: a hook imported a function that had been renamed, so it threw a link-time
 * `SyntaxError` and exited 1 on every Bash call. The guard was dead for a whole
 * review cycle while every other check stayed green, because nothing imported it.
 *
 * **What catches it is running the file**, so that is what this does: feed each hook
 * a payload it should be indifferent to, and require it to exit cleanly with no
 * error on stderr. An import error, a typo in a top-level statement or a missing
 * dependency all fail here.
 */

import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HOOKS, describe, expect, it, run } from './helpers.mjs';

/** Hook scripts, discovered by their shebang rather than listed, so a new one is covered on arrival. */
const scripts = readdirSync(HOOKS)
  .filter((f) => /\.(mjs|sh)$/.test(f))
  .filter((f) => readFileSync(join(HOOKS, f), 'utf8').startsWith('#!'))
  .sort();

const INERT = { tool_name: 'Bash', tool_input: { command: 'git status' } };

describe('hook scripts', () => {
  it('finds the hooks to run', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(7);
  });

  it.each(scripts)('%s is executable', (script) => {
    expect(() => accessSync(join(HOOKS, script), constants.X_OK)).not.toThrow();
  });

  it.each(scripts.filter((s) => s.endsWith('.mjs')))('%s loads and runs', (script) => {
    const { status, stderr } = run(script, INERT);
    // 0 means "carry on", 2 means "blocked". Anything else is the script itself failing.
    expect([0, 2].includes(status), `${script} exited ${status}: ${stderr}`).toBe(true);
    expect(stderr).not.toMatch(
      /SyntaxError|ReferenceError|TypeError|Cannot find|does not provide an export/
    );
  });

  it.each(scripts.filter((s) => s.endsWith('.mjs')))(
    '%s survives an unreadable payload',
    (script) => {
      const { status, stderr } = run(script, 'not json at all');
      expect([0, 2].includes(status), `${script} exited ${status}: ${stderr}`).toBe(true);
      expect(stderr).not.toMatch(/SyntaxError|ReferenceError|TypeError/);
    }
  );
});
