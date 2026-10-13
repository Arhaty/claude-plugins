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
    // A failing call prints nothing, which must not read as nothing having run.
    expect(staging).toContain(
      '--jq ".check_runs[] | $buckets") \\\n  && if [ -z "$runs" ]; then echo none; else sort <<<"$runs" | uniq -c; fi'
    );
    expect(staging).toContain(
      'if .status != "completed" or .conclusion == "action_required" then "pending"'
    );
    expect(staging).toContain('elif .conclusion == "success" then "success"');
    // A run cancelled by a later one on the same head is superseded, not failing.
    expect(staging).toContain(
      'elif (.conclusion | IN("skipped", "neutral", "cancelled", "stale")) then "ignored"'
    );
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

describe('staging starts CI on a head nothing has run on, once', () => {
  const staging = skill('staging');

  it("reads the configured workflow's runs on the head SHA", () => {
    expect(staging).toContain(
      'gh api --paginate "repos/{owner}/{repo}/actions/workflows/<workflow>/runs?head_sha=$sha&per_page=100"'
    );
    expect(staging).toContain(
      '--jq ".workflow_runs[] | $buckets") \\\n  && if [ -z "$runs" ]; then echo none; else sort <<<"$runs" | uniq -c; fi'
    );
    expect(staging).toMatch(/A query that fails is not an empty answer/);
  });

  it('decides on dispatching before it watches the checks', () => {
    expect(staging.indexOf('/dispatches')).toBeLessThan(staging.indexOf('gh pr checks <number>'));
    expect(staging.indexOf('sha=$(gh pr view')).toBeLessThan(staging.indexOf('head_sha=$sha'));
  });

  it("dispatches on the pull request's branch, with the base input when there is one", () => {
    expect(staging).toContain(
      "--jq 'select(.head.repo.full_name == .base.repo.full_name) | .head.ref')"
    );
    expect(staging).toMatch(/An empty `branch` is a pull request from a fork/);
    expect(staging).toContain('actions/workflows/<workflow>/dispatches');
    expect(staging).toContain('-f ref="$branch" -f "inputs[<baseInput>]=<integration>"');
    expect(staging).toMatch(/Leave out the `inputs` field when `<baseInput>` is null/);
  });

  it('refuses to dispatch on top of a run, or to retry a failure', () => {
    expect(staging).toMatch(/\*\*`success` or `pending`: do not dispatch\.\*\*/);
    expect(staging).toMatch(/\*\*`failing`: do not dispatch\.\*\*/);
    expect(staging).toMatch(/Never\s+dispatch a second time for the same head/);
    expect(staging).toMatch(/reported in one line and never retried/);
  });

  it('decides on fresh reads of the queries, not the watch or the read before the dispatch', () => {
    expect(staging).toMatch(/poll the two queries every 30 seconds instead/);
    expect(staging).toMatch(/never from the read\s+before the dispatch/);
  });

  it('tells a moved head from a run that failed to start', () => {
    expect(staging).toMatch(/\*\*The head moved\*\*/);
    expect(staging).toMatch(/\*\*Otherwise the run failed to start:\*\*/);
  });

  it('stops on a dispatched run that skipped itself rather than waiting out the timeout', () => {
    expect(staging).toMatch(/the workflow\s+skipped itself on this head/);
  });

  it('waits for a late run only when step 5 could have started one', () => {
    expect(staging).toMatch(/up to 90 seconds before taking an empty\s+answer as final/);
    expect(staging).toMatch(/Otherwise one read is enough/);
  });

  it('still needs the configured workflow to succeed before it merges', () => {
    expect(staging).toMatch(/the configured workflow's\s+success is required too/);
  });
});
