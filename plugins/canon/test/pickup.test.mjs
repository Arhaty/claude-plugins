/**
 * How `/canon:pickup` chooses: `choose` on its own, then `scripts/pickup.mjs` end to end
 * against the fixture tracker and a repository's remote-tracking branches.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { choose, main } from '../scripts/pickup.mjs';
import {
  CONFIG,
  ROOT,
  TRACKER,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  makeProject,
} from './helpers.mjs';

const NOW = Date.parse('2026-03-01T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

/** An issue as `tracker.mjs issues` lists it. */
const issue = (identifier, role, extra = {}) => ({
  identifier,
  title: `Title of ${identifier}`,
  branchName: `${identifier.toLowerCase()}-title`,
  role,
  state: role,
  stateType: 'started',
  priority: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: hoursAgo(24),
  blockedBy: [],
  ...extra,
});
const blocker = (identifier, role, stateType = 'started') => ({
  identifier,
  role,
  state: role ?? 'Triage',
  stateType,
});
const decide = (issues, extra = {}) =>
  choose({ issues, branchTimes: {}, now: NOW, staleHours: 3, ...extra });

describe('choosing the next issue', () => {
  it('takes the most urgent approved issue, then the oldest, with no priority last', () => {
    const issues = [
      issue('ABC-1', 'approved', { priority: 0, createdAt: '2026-01-01T00:00:00Z' }),
      issue('ABC-2', 'approved', { priority: 3, createdAt: '2026-01-03T00:00:00Z' }),
      issue('ABC-3', 'approved', { priority: 3, createdAt: '2026-01-02T00:00:00Z' }),
      issue('ABC-4', 'approved', { priority: 4, createdAt: '2025-12-01T00:00:00Z' }),
    ];
    expect(decide(issues).issue).toMatchObject({ identifier: 'ABC-3', resume: false });
    issues.push(issue('ABC-5', 'approved', { priority: 1, createdAt: '2026-02-01T00:00:00Z' }));
    expect(decide(issues).issue.identifier).toBe('ABC-5');
  });

  it('resumes an answered blocked issue before any approved one', () => {
    const issues = [
      issue('ABC-1', 'approved', { priority: 1 }),
      issue('ABC-2', 'blocked', { priority: 4 }),
      issue('ABC-3', 'blocked', { priority: 1 }),
    ];
    expect(decide(issues).issue.identifier).toBe('ABC-1');
    issues[1].answered = true;
    const answered = decide(issues);
    expect(answered.issue).toMatchObject({ identifier: 'ABC-2', role: 'blocked', resume: true });
  });

  it('builds a blocker that is itself a candidate first, recursively', () => {
    const issues = [
      issue('ABC-1', 'approved', { priority: 1, blockedBy: [blocker('ABC-2', 'approved')] }),
      issue('ABC-2', 'approved', { priority: 4, blockedBy: [blocker('ABC-3', 'approved')] }),
      issue('ABC-3', 'approved', { priority: 4, createdAt: '2026-02-01T00:00:00Z' }),
    ];
    expect(decide(issues).issue).toMatchObject({ identifier: 'ABC-3', unblocks: 'ABC-1' });
  });

  it('names the candidate a blocker unblocks', () => {
    const issues = [
      issue('ABC-1', 'approved', { priority: 1, blockedBy: [blocker('ABC-2', 'approved')] }),
      issue('ABC-2', 'approved', { priority: 4 }),
    ];
    expect(decide(issues).issue).toMatchObject({ identifier: 'ABC-2', unblocks: 'ABC-1' });
  });

  it('takes a merged, completed or cancelled blocker as done', () => {
    const issues = [
      issue('ABC-1', 'approved', {
        blockedBy: [
          blocker('ABC-2', 'staging'),
          blocker('ABC-3', 'production'),
          blocker('ABC-4', null, 'completed'),
          blocker('ABC-5', null, 'canceled'),
        ],
      }),
    ];
    expect(decide(issues).issue).toMatchObject({ identifier: 'ABC-1', unblocks: null });
  });

  it('lets an issue wait on a blocker with no spec, and tries the next', () => {
    const issues = [
      issue('ABC-1', 'approved', { priority: 1, blockedBy: [blocker('ABC-9', 'ready')] }),
      issue('ABC-2', 'approved', { priority: 2 }),
    ];
    const decision = decide(issues);
    expect(decision.issue.identifier).toBe('ABC-2');
    expect(decision.waiting).toEqual([
      {
        identifier: 'ABC-1',
        title: 'Title of ABC-1',
        on: [{ identifier: 'ABC-9', why: 'it has no spec yet' }],
      },
    ]);
  });

  it('says nothing can be built, and what each issue waits on', () => {
    const issues = [
      issue('ABC-1', 'approved', { blockedBy: [blocker('ABC-8', 'spec')] }),
      issue('ABC-2', 'blocked', { blockedBy: [] }),
      issue('ABC-3', 'approved', { blockedBy: [blocker('ABC-2', 'blocked')] }),
    ];
    expect(decide(issues)).toEqual({
      decision: 'none',
      dead: [],
      waiting: [
        {
          identifier: 'ABC-1',
          title: 'Title of ABC-1',
          on: [{ identifier: 'ABC-8', why: 'its spec is not approved' }],
        },
        {
          identifier: 'ABC-3',
          title: 'Title of ABC-3',
          on: [{ identifier: 'ABC-2', why: 'it is blocked with no answer' }],
        },
      ],
    });
  });

  it('stops on a cycle rather than recursing forever, and still builds the rest', () => {
    const issues = [
      issue('ABC-1', 'approved', { priority: 1, blockedBy: [blocker('ABC-2', 'approved')] }),
      issue('ABC-2', 'approved', { priority: 1, blockedBy: [blocker('ABC-3', 'approved')] }),
      issue('ABC-3', 'approved', { priority: 1, blockedBy: [blocker('ABC-1', 'approved')] }),
      issue('ABC-4', 'approved', { priority: 4 }),
    ];
    const decision = decide(issues);
    expect(decision.issue.identifier).toBe('ABC-4');
    expect(decision.waiting[0].on).toEqual([
      { identifier: 'ABC-1', why: 'a cycle: ABC-1 → ABC-2 → ABC-3 → ABC-1' },
    ]);
    expect(decision.waiting.map((wait) => wait.identifier)).toEqual(['ABC-1', 'ABC-2', 'ABC-3']);
  });

  it('stops on a live run: a recent commit on its branch, or a recent update', () => {
    const approved = issue('ABC-1', 'approved');
    const byCommit = issue('ABC-2', 'building', { updatedAt: hoursAgo(10) });
    expect(decide([approved, byCommit], { branchTimes: { 'ABC-2': NOW - 2 * 3_600_000 } })).toEqual(
      {
        decision: 'live',
        live: [{ identifier: 'ABC-2', title: 'Title of ABC-2', lastActivity: hoursAgo(2) }],
      }
    );
    const byUpdate = issue('ABC-3', 'building', { updatedAt: hoursAgo(1) });
    expect(decide([approved, byUpdate]).decision).toBe('live');
    expect(decide([approved, byUpdate], { staleHours: 0.5 }).decision).toBe('build');
  });

  it('keeps a run live while it comments on its issue, as ship does at each step', () => {
    const quiet = issue('ABC-1', 'building', {
      updatedAt: hoursAgo(5),
      lastCommentAt: hoursAgo(1),
    });
    expect(decide([quiet, issue('ABC-2', 'approved')]).decision).toBe('live');
  });

  it('works out a board whose blockers share blockers once per issue, not once per path', () => {
    // Each issue is blocked by the two before it, and the first waits on an issue with no spec:
    // walked path by path, that is about 2^40 visits.
    const chain = [issue('ABC-1', 'approved', { blockedBy: [blocker('ABC-99', 'ready')] })];
    for (let n = 2; n <= 40; n++) {
      const before = (k) => blocker(`ABC-${k}`, 'approved');
      chain.push(
        issue(`ABC-${n}`, 'approved', {
          blockedBy: [before(n - 1), ...(n > 2 ? [before(n - 2)] : [])],
        })
      );
    }
    const started = Date.now();
    const decision = decide(chain.reverse());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(decision.decision).toBe('none');
    expect(decision.waiting.length).toBe(40);
  });

  it('lists a dead run to block, and lets nothing that waits on it through', () => {
    const issues = [
      issue('ABC-1', 'building', { updatedAt: hoursAgo(5) }),
      issue('ABC-2', 'approved', { priority: 1, blockedBy: [blocker('ABC-1', 'building')] }),
      issue('ABC-3', 'approved', { priority: 4 }),
    ];
    const decision = decide(issues, { branchTimes: { 'ABC-1': NOW - 4 * 3_600_000 } });
    expect(decision.decision).toBe('build');
    expect(decision.issue.identifier).toBe('ABC-3');
    expect(decision.dead).toEqual([{ identifier: 'ABC-1', title: 'Title of ABC-1' }]);
    expect(decision.waiting[0].on).toEqual([
      { identifier: 'ABC-1', why: 'its run stopped and it is blocked' },
    ]);
  });
});

describe('pickup.mjs', () => {
  let project;
  let savedProjectDir;
  const git = (...args) => {
    const result = spawnSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_COMMITTER_DATE: hoursAgo(1), GIT_AUTHOR_DATE: hoursAgo(1) },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const fixture = (issues) =>
    writeFileSync(
      join(project, '.claude/tracker-fixture.json'),
      JSON.stringify({ states: Object.values(TRACKER.statuses), labels: [], issues })
    );
  const config = (autonomy, extra = {}) => ({
    ...CONFIG,
    tracker: { ...TRACKER, provider: 'fixture' },
    autonomy,
    ...extra,
  });
  const run = (options = {}) => main([], { cwd: project, env: {}, now: NOW, ...options });

  beforeEach(() => {
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    project = mkdtempSync(join(tmpdir(), 'canon-pickup-'));
    makeProject({ dir: project, config: config({ pickup: true }) });
    git('init', '-q', '-b', 'staging');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  });
  afterEach(() => {
    if (savedProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    rmSync(project, { recursive: true, force: true });
  });

  it('refuses unless pickup is on, and with no tracker', async () => {
    fixture({});
    makeProject({ dir: project, config: config({ specReview: true }) });
    await assert.rejects(run(), /Pickup is off for this project/);
    makeProject({ dir: project, config: CONFIG });
    await assert.rejects(run(), /needs a tracker/);
  });

  it('reads the board and the remote branches, and finds a live run by its last commit', async () => {
    fixture({
      'ABC-1': { title: 'Old run', state: 'In Progress', updatedAt: hoursAgo(9) },
      'ABC-2': { title: 'Next', state: 'Approved', createdAt: hoursAgo(50) },
    });
    git('update-ref', 'refs/remotes/origin/feat/abc-1-old-run', 'HEAD');
    // Another issue's branch that only starts with the same digits is not this one's.
    git('update-ref', 'refs/remotes/origin/feat/abc-10-other', 'HEAD');
    expect(await run()).toMatchObject({
      decision: 'live',
      live: [{ identifier: 'ABC-1', lastActivity: hoursAgo(1) }],
    });
  });

  it('builds the next issue past a dead run, and resumes an answered one first', async () => {
    fixture({
      'ABC-1': { title: 'Old run', state: 'In Progress', updatedAt: hoursAgo(9) },
      'ABC-2': { title: 'Next', state: 'Approved', createdAt: hoursAgo(50) },
      'ABC-3': {
        title: 'Asked',
        state: 'Blocked',
        comments: [
          { body: 'canon: blocked\n\nWhich limit?', createdAt: hoursAgo(30) },
          { body: 'canon: note\n\nReport.', createdAt: hoursAgo(29) },
        ],
      },
    });
    expect(await run()).toMatchObject({
      decision: 'build',
      issue: { identifier: 'ABC-2', resume: false },
      dead: [{ identifier: 'ABC-1' }],
    });

    const data = JSON.parse(readFileSync(join(project, '.claude/tracker-fixture.json'), 'utf8'));
    data.issues['ABC-3'].comments.push({ body: 'Five a minute.', createdAt: hoursAgo(2) });
    fixture(data.issues);
    expect((await run()).issue).toMatchObject({ identifier: 'ABC-3', resume: true });
  });

  it("finds a branch by the issue's own name with tracker naming", async () => {
    makeProject({
      dir: project,
      config: config({ pickup: true }, { branches: { ...CONFIG.branches, naming: 'tracker' } }),
    });
    fixture({
      'ABC-1': {
        title: 'Old run',
        state: 'In Progress',
        branchName: 'ada/abc-1-old',
        updatedAt: hoursAgo(9),
      },
    });
    git('update-ref', 'refs/remotes/origin/ada/abc-1-old', 'HEAD');
    expect((await run()).decision).toBe('live');
  });

  it('runs as the skill runs it, and passes a tracker failure on', () => {
    fixture({ 'ABC-2': { title: 'Next', state: 'Approved' } });
    const script = join(ROOT, 'scripts/pickup.mjs');
    const ok = spawnSync(process.execPath, [script], { cwd: project, encoding: 'utf8', env: {} });
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).issue.identifier).toBe('ABC-2');

    rmSync(join(project, '.claude/tracker-fixture.json'));
    const failed = spawnSync(process.execPath, [script], {
      cwd: project,
      encoding: 'utf8',
      env: {},
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/^pickup: .*tracker-fixture\.json does not exist/);
  });
});
