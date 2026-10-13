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

  it('counts check runs on the head SHA that concluded success, and nothing else', () => {
    expect(staging).toContain('sha=$(gh pr view <number> --json headRefOid -q .headRefOid)');
    expect(staging).toContain('commits/$sha/check-runs');
    expect(staging).toContain('select(.conclusion == "success")');
    // No other conclusion counts toward the pass.
    expect(staging).not.toMatch(/select\([^)]*"(skipped|neutral)"/);
  });

  it('says a missing, skipped or neutral run is not a pass', () => {
    expect(staging).toMatch(/Only a success on the head SHA is a pass/);
    expect(staging).toMatch(/missing run and a run that\s+ended `skipped` or `neutral` are not/);
  });

  it('merges on the head CI verified', () => {
    expect(staging).toContain('--match-head-commit "$sha"');
  });
});
