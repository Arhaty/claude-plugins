/**
 * `gh-get.mjs` is pre-approved in staging and production, so it must only ever read:
 * it passes an endpoint, `--paginate` and `--jq` to `gh api --method GET`, and refuses
 * everything else before gh runs.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, ROOT } from './helpers.mjs';

const SCRIPT = join(ROOT, 'scripts/gh-get.mjs');

/** Run the script with a `gh` that prints its arguments one per line and exits `code`. */
function get(args, code = 0) {
  const bin = mkdtempSync(join(tmpdir(), 'canon-bin-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@"\nexit ${code}\n`, {
    mode: 0o755,
  });
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  rmSync(bin, { recursive: true, force: true });
  return {
    status: result.status,
    argv: result.stdout.split('\n').slice(0, -1),
    stderr: result.stderr,
  };
}

describe('gh-get', () => {
  it('reads with GET, passing --paginate and --jq through', () => {
    const endpoint = 'repos/{owner}/{repo}/commits/abc/check-runs?per_page=100';
    expect(get([endpoint, '--paginate', '--jq', '.check_runs[].name'])).toEqual({
      status: 0,
      argv: ['api', '--method', 'GET', endpoint, '--paginate', '--jq', '.check_runs[].name'],
      stderr: '',
    });
    expect(get(['--paginate', 'repos/o/r/pulls', '--jq=.[].number']).argv).toEqual([
      'api',
      '--method',
      'GET',
      'repos/o/r/pulls',
      '--paginate',
      '--jq=.[].number',
    ]);
  });

  it("exits with gh's status", () => {
    expect(get(['repos/o/r/pulls/5'], 1).status).toBe(1);
  });

  it.each([
    [['repos/o/r/pulls', '-f', 'base=main']],
    [['repos/o/r/pulls/5/merge', '-X', 'PUT']],
    [['repos/o/r/pulls/5', '--method', 'PATCH']],
    [['repos/o/r/pulls', '--input', 'body.json']],
    [['repos/o/r/pulls', '-H', 'X-HTTP-Method-Override: PUT']],
    [['repos/o/r/pulls', 'repos/o/r/issues']],
    [['graphql', '--jq', '.data']],
    [['/graphql']],
    [['--jq', '.x']],
    [[]],
  ])('refuses %j without running gh', (args) => {
    const { status, argv, stderr } = get(args);
    expect(status).toBe(2);
    expect(argv).toEqual([]);
    expect(stderr).toMatch(/^canon: gh-get /);
  });
});
