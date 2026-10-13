/**
 * The rules in a skill that decide whether code merges. A skill is prose, so these
 * pin the text: rewording it is fine, and dropping the rule fails here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, describe, expect, it } from './helpers.mjs';

const skill = (name) => readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');

describe('staging merges only on a success for the head commit', () => {
  const staging = skill('staging');

  it('reads every check run on the head SHA, not one that happens to have passed', () => {
    expect(staging).toContain('sha=$(gh pr view <number> --json headRefOid -q .headRefOid)');
    expect(staging).toContain('commits/$sha/check-runs');
    expect(staging).toContain('if .status != "completed" then "pending"');
    expect(staging).toContain('elif .conclusion == "success" then "success"');
    expect(staging).toContain('elif (.conclusion | IN("skipped", "neutral")) then "ignored"');
    expect(staging).toContain('else "failing" end');
    // A query that only counts successes passes on one quick check beside a failing one.
    expect(staging).not.toContain('select(.conclusion == "success")] | length');
  });

  it('passes only on a success with nothing pending or failing', () => {
    expect(staging).toMatch(/Only a success on the head SHA is a pass/);
    expect(staging).toMatch(/missing run and a run that\s+ended `skipped` or `neutral` are not/);
    expect(staging).toMatch(
      /passes only when at least one is `success`, none is `pending` and none is `failing`/
    );
  });

  it('merges on the head CI verified', () => {
    expect(staging).toContain('--match-head-commit "$sha"');
  });
});
