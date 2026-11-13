#!/usr/bin/env node
/**
 * Which issue `/canon:pickup` builds next, read from the tracker and the remote branches.
 *
 *   node pickup.mjs              decide, and change nothing
 *   node pickup.mjs claim <ID>   take the picked issue for this run, or learn another has
 *   node pickup.mjs block <ID>   block a dead run with the question for the owner
 *
 * The decision is one JSON object:
 *
 *   { "decision": "live", "live": [...] }        a run is going: stop
 *   { "decision": "build", "issue": {...},       build this one, after blocking `dead`
 *     "dead": [...], "waiting": [...] }
 *   { "decision": "none", "dead": [...],         nothing can be built yet
 *     "waiting": [...] }
 *
 * **One run at a time.** An issue in the `building` role whose branch has a commit, or
 * whose issue was updated or commented on, within `autonomy.staleHours` is a live run.
 * `/canon:pickup` claims the issue it picks by moving it to `building` before it ships,
 * and with pickup on, `/canon:ship` and `/canon:build` note their progress on the issue,
 * attended or not, so a run that is working stays live. Older than that, the run died:
 * it is listed in `dead`, for the skill to block, and counts as blocked with no answer
 * from then on.
 *
 * **A claim** moves the issue to `building` and posts a note naming this run. Two runs
 * that decided at the same moment both claim; each then reads the issue's claim notes
 * from the last `CLAIM_WINDOW_MS`, and only the run whose note came first goes on.
 *
 * **Candidates** are `blocked` issues the owner has answered, then `approved` ones, each
 * group by priority (urgent first, none last), then oldest first. A candidate whose
 * blockers are all done is picked. A blocker that is itself a candidate is resolved
 * first, recursively, and picked in its place. Any other blocker makes the candidate
 * wait. A cycle waits too.
 *
 * Every tracker read goes through `tracker.mjs`; run `git fetch --prune origin` first,
 * since the branch times come from the remote-tracking refs.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_PATH, loadConfig, projectRoot, withDefaults } from '../hooks/lib/config.mjs';
import { TrackerError } from './tracker.mjs';

/**
 * Run `tracker.mjs` as a skill would, in a process of its own, so it finds the key and
 * the proxy exactly as it does for the skills, and return what it printed.
 */
function tracker(argv, { cwd, env, execArgv }, input) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'tracker.mjs');
  const child = spawnSync(process.execPath, [...execArgv, script, ...argv], {
    cwd,
    env,
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
    timeout: 300_000,
    // The whole board, pretty-printed: far past the 1 MB default on a large backlog.
    maxBuffer: 256 * 1024 * 1024,
  });
  if (child.status !== 0) {
    const reason = (child.stderr || child.error?.message || 'no output').trim();
    throw new TrackerError(reason.replace(/^tracker: /, ''));
  }
  return JSON.parse(child.stdout);
}

/** Linear's priority: 1 urgent to 4 low, and 0 for none, which sorts last. */
const rank = (priority) => (priority >= 1 && priority <= 4 ? priority : 5);

const byPriorityThenAge = (a, b) =>
  rank(a.priority) - rank(b.priority) || String(a.createdAt).localeCompare(String(b.createdAt));

/** Is a blocker out of the way: merged, or completed or cancelled on the tracker? */
export const isDone = (blocker) =>
  ['staging', 'production'].includes(blocker.role) ||
  ['completed', 'canceled'].includes(blocker.stateType);

/** Why a blocker that is not a candidate holds an issue up, in a few words. */
function holdUp(blocker, dead) {
  if (dead.has(blocker.identifier)) return 'its run stopped and it is blocked';
  return (
    {
      ready: 'it has no spec yet',
      spec: 'its spec is not approved',
      approved: 'it is approved but cannot be built yet',
      building: 'it is being built',
      blocked: 'it is blocked with no answer',
    }[blocker.role] ?? `it is in ${blocker.state || 'a status canon does not map'}`
  );
}

/**
 * The decision, from what the tracker and git returned.
 *
 * - `issues`: the `building`, `blocked` and `approved` issues, as `tracker.mjs issues` lists
 *   them, each with `role`, `priority`, `createdAt`, `updatedAt` and `blockedBy`, and for
 *   blocked and building ones `answered` and `lastCommentAt`.
 * - `branchTimes`: identifier to the newest commit time on its remote branch, in ms.
 */
export function choose({ issues, branchTimes = {}, now, staleHours }) {
  const cutoff = now - staleHours * 3_600_000;
  const lastActivity = (issue) =>
    Math.max(
      Date.parse(issue.updatedAt) || 0,
      Date.parse(issue.lastCommentAt ?? '') || 0,
      branchTimes[issue.identifier] ?? 0
    );
  const brief = (issue) => ({ identifier: issue.identifier, title: issue.title });

  const building = issues.filter((issue) => issue.role === 'building');
  const live = building.filter((issue) => lastActivity(issue) >= cutoff);
  if (live.length) {
    return {
      decision: 'live',
      live: live.map((issue) => ({
        ...brief(issue),
        lastActivity: new Date(lastActivity(issue)).toISOString(),
      })),
    };
  }
  const dead = new Set(building.map((issue) => issue.identifier));

  const resumes = issues
    .filter((issue) => issue.role === 'blocked' && issue.answered)
    .sort(byPriorityThenAge);
  const fresh = issues.filter((issue) => issue.role === 'approved').sort(byPriorityThenAge);
  const candidates = [...resumes, ...fresh];
  const candidate = new Map(candidates.map((issue) => [issue.identifier, issue]));

  /**
   * `{ pick }` for the issue to build so that `issue` can be, or `{ waits }` on what. An
   * issue's answer does not depend on how it was reached, so each is worked out once: a
   * board where blockers share blockers would otherwise be walked once per path.
   */
  const settled = new Map();
  const resolveIssue = (issue, path) => {
    // Back on the path is a cycle, and says nothing about the issue on its own: not cached.
    if (path.includes(issue.identifier)) {
      const loop = [...path.slice(path.indexOf(issue.identifier)), issue.identifier];
      return { waits: [{ identifier: issue.identifier, why: `a cycle: ${loop.join(' → ')}` }] };
    }
    if (!settled.has(issue.identifier)) settled.set(issue.identifier, resolveOnce(issue, path));
    return settled.get(issue.identifier);
  };
  const resolveOnce = (issue, path) => {
    const open = (issue.blockedBy ?? []).filter((blocker) => !isDone(blocker));
    if (open.length === 0) return { pick: issue };
    // One entry per issue waited on, so lists that share blockers do not add up.
    const waits = new Map();
    const add = (wait) => {
      if (!waits.has(wait.identifier)) waits.set(wait.identifier, wait);
    };
    for (const blocker of open) {
      const next = candidate.get(blocker.identifier);
      if (!next) {
        add({ identifier: blocker.identifier, why: holdUp(blocker, dead) });
        continue;
      }
      const found = resolveIssue(next, [...path, issue.identifier]);
      if (found.pick) return found;
      for (const wait of found.waits) add(wait);
    }
    return { waits: [...waits.values()] };
  };

  const waiting = [];
  for (const issue of candidates) {
    const found = resolveIssue(issue, []);
    if (found.pick) {
      const pick = found.pick;
      return {
        decision: 'build',
        issue: {
          ...brief(pick),
          role: pick.role,
          resume: pick.role === 'blocked',
          // The candidate this unblocks, when the pick is one of its blockers.
          unblocks: pick === issue ? null : issue.identifier,
        },
        dead: building.map(brief),
        waiting,
      };
    }
    waiting.push({ ...brief(issue), on: found.waits });
  }
  return { decision: 'none', dead: building.map(brief), waiting };
}

/**
 * The newest commit time on each building issue's remote branch, found as
 * `references/tracker.md` says under Names: `origin/<branchName>` with tracker naming,
 * otherwise `origin/<prefix>/<id in lowercase>-*`.
 */
export function branchTimes(root, config, issues) {
  let refs;
  try {
    refs = execFileSync(
      'git',
      [
        '-C',
        root,
        'for-each-ref',
        '--format=%(refname:strip=3)%09%(committerdate:unix)',
        'refs/remotes/origin',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return {};
  }
  const branches = refs
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, seconds] = line.split('\t');
      return { name, at: Number(seconds) * 1000 };
    });
  const byTracker = config.branches.naming === 'tracker';
  const times = {};
  for (const issue of issues) {
    const id = issue.identifier.toLowerCase();
    const matches = branches.filter(({ name }) =>
      byTracker
        ? issue.branchName && name === issue.branchName
        : (config.branches.prefixes ?? []).some((prefix) => name.startsWith(`${prefix}/${id}-`))
    );
    if (matches.length) times[issue.identifier] = Math.max(...matches.map(({ at }) => at));
  }
  return times;
}

/** How far back a claim note by another run counts against this one. */
export const CLAIM_WINDOW_MS = 15 * 60_000;

const CLAIM_NOTE = /^canon: note\s+Picked up by \/canon:pickup, run ([0-9a-f]+)\./;

export const DEAD_QUESTION =
  'The run stopped without finishing. Reply `resume` to carry on from the branch, or say what ' +
  'to do instead.';

/**
 * Of the claim notes on an issue, the run whose note came first in the window, or null.
 * Comments come oldest first, so the first match wins.
 */
export function claimant(comments, now) {
  for (const comment of comments) {
    const run = CLAIM_NOTE.exec(comment.body ?? '')?.[1];
    if (run && now - Date.parse(comment.createdAt) <= CLAIM_WINDOW_MS) return run;
  }
  return null;
}

/** Take `id` for this run: move it to `building`, post the note, and see who was first. */
function claim(id, options, token) {
  tracker(['set-state', id, 'building'], options);
  tracker(['comment', id], options, `Picked up by /canon:pickup, run ${token}.`);
  const { comments } = tracker(['comments', id], options);
  const first = claimant(comments, Date.now());
  return first === token
    ? { claimed: true, run: token }
    : { claimed: false, run: token, by: first };
}

/** Block a dead run, as `references/tracker.md` says under Blocked, minus the chat question. */
function block(id, options) {
  tracker(['comment', id, '--blocked'], options, DEAD_QUESTION);
  tracker(['set-state', id, 'blocked'], options);
  return { blocked: id };
}

/**
 * Decide, claim or block. `now`, `execArgv` and `token` are for tests.
 */
export async function main(
  argv,
  { cwd = process.cwd(), env = process.env, now, execArgv = [], token } = {}
) {
  const [command, id, ...extra] = argv;
  const writes = ['claim', 'block'].includes(command);
  if (argv.length && !(writes && /^[A-Za-z0-9]+-[0-9]+$/.test(id ?? '') && !extra.length)) {
    throw new TrackerError(
      `pickup takes nothing, claim <ID> or block <ID>, not ${argv.join(' ')}`,
      2
    );
  }
  const root = projectRoot({ cwd }, env);
  const state = loadConfig(root);
  if (state.status !== 'ok') {
    throw new TrackerError(
      state.status === 'invalid'
        ? `${CONFIG_PATH} is invalid:\n  - ${state.errors.join('\n  - ')}`
        : `${root} has no ${CONFIG_PATH}. Run /canon:setup first.`
    );
  }
  const config = withDefaults(state.config);
  if (!config.tracker) {
    throw new TrackerError('/canon:pickup needs a tracker: it picks issues from its board.');
  }
  if (!config.autonomy.pickup) {
    throw new TrackerError(
      'Pickup is off for this project (`autonomy.pickup`). /canon:setup turns it on.'
    );
  }

  const options = { cwd: root, env, execArgv };
  if (command === 'claim') return claim(id, options, token ?? randomBytes(4).toString('hex'));
  if (command === 'block') return block(id, options);
  const issues = tracker(['issues', 'building,blocked,approved'], options);
  const building = issues.filter(({ role }) => role === 'building');
  return choose({
    issues,
    branchTimes: branchTimes(root, config, building),
    now: now ?? Date.now(),
    staleHours: config.autonomy.staleHours,
  });
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  main(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`pickup: ${error?.message ?? error}\n`);
      process.exitCode = error instanceof TrackerError ? error.code : 1;
    });
}
