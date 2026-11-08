/**
 * A tracker held in a file, for tests and evals: `.claude/tracker-fixture.json` in
 * the project. It needs no key and reaches no network, and it writes every change
 * back to the file, so a run can be checked by reading it afterwards.
 *
 *   {
 *     "states": ["Todo", "In Spec", ..., { "name": "Cancelled", "type": "canceled" }],
 *     "labels": ["domain-auth", ...],
 *     "issues": {
 *       "ABC-7": { "title": "...", "description": "...", "state": "Todo", "branchName": "...",
 *                  "labels": [], "comments": [{ "body": "...", "createdAt": "..." }],
 *                  "priority": 2, "createdAt": "...", "updatedAt": "...",
 *                  "blockedBy": ["ABC-5"] }
 *     }
 *   }
 *
 * A state is a name, or `{ name, type }` with Linear's type (`completed`, `canceled`...).
 *
 * Same interface as `linear.mjs`. Not something `/canon:setup` offers: a project
 * picks it by writing `"provider": "fixture"` by hand.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { symlinkIn } from '../../hooks/lib/config.mjs';
import { parseIdentifier } from './linear.mjs';

/** No key: the provider reads nothing but the file. */
export const KEY_VARIABLE = null;

export const FIXTURE_PATH = '.claude/tracker-fixture.json';

export class FixtureError extends Error {}

/** `ABC-7` titled "Rate-limit password resets" is `abc-7-rate-limit-password-resets`. */
export function defaultBranchName(id, title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug ? `${id.toLowerCase()}-${slug}` : id.toLowerCase();
}

export function createClient({ root, team }) {
  const file = join(root, FIXTURE_PATH);

  const load = () => {
    if (symlinkIn(root, FIXTURE_PATH) !== null) {
      throw new FixtureError(`${FIXTURE_PATH} is a symlink. Refusing to read or write through it.`);
    }
    if (!existsSync(file)) throw new FixtureError(`${FIXTURE_PATH} does not exist`);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new FixtureError(`${FIXTURE_PATH} is not valid JSON (${error.message})`);
    }
  };
  const save = (data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

  /** Each state as `{ name, type }`, from a name or an object. */
  const stateList = (data) =>
    (data.states ?? []).map((state) =>
      typeof state === 'string' ? { name: state, type: 'fixture' } : state
    );
  const typeOf = (data, name) => stateList(data).find((state) => state.name === name)?.type ?? '';

  /** The data and the issue, refused unless it exists and belongs to the team. */
  const find = (identifier) => {
    const { team: owner, identifier: id } = parseIdentifier(identifier);
    if (owner !== team) throw new FixtureError(`${id} belongs to team ${owner}, not ${team}`);
    const data = load();
    const issue = data.issues?.[id];
    if (!issue) throw new FixtureError(`No issue ${id}`);
    issue.labels ??= [];
    issue.comments ??= [];
    return { data, issue, id };
  };

  return {
    async issue(identifier) {
      const { issue, id } = find(identifier);
      return {
        identifier: id,
        // Linear's default form when the fixture names none: the identifier, then the title.
        branchName: issue.branchName ?? defaultBranchName(id, issue.title ?? ''),
        title: issue.title ?? '',
        description: issue.description ?? '',
        url: `fixture:${id}`,
        state: issue.state ?? '',
        labels: [...issue.labels],
      };
    },

    async issues(names) {
      const data = load();
      const all = data.issues ?? {};
      return Object.entries(all)
        .filter(([, issue]) => names.includes(issue.state))
        .map(([id, issue]) => ({
          identifier: id,
          title: issue.title ?? '',
          branchName: issue.branchName ?? defaultBranchName(id, issue.title ?? ''),
          priority: issue.priority ?? 0,
          createdAt: issue.createdAt ?? '',
          updatedAt: issue.updatedAt ?? issue.createdAt ?? '',
          state: issue.state ?? '',
          stateType: typeOf(data, issue.state),
          blockedBy: (issue.blockedBy ?? []).map((blocker) => ({
            identifier: blocker,
            state: all[blocker]?.state ?? '',
            stateType: typeOf(data, all[blocker]?.state),
          })),
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async comments(identifier) {
      const { issue } = find(identifier);
      return issue.comments
        .map((comment, i) => ({
          id: comment.id ?? `c${i + 1}`,
          body: comment.body ?? '',
          createdAt: comment.createdAt ?? '',
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async comment(identifier, body) {
      const { data, issue } = find(identifier);
      // One second after the newest comment that has a readable date, or now if later.
      const times = issue.comments
        .map((c) => Date.parse(c.createdAt ?? ''))
        .filter(Number.isFinite);
      const next = new Date(Math.max(Date.now(), ...times.map((t) => t + 1000)));
      issue.comments.push({
        id: `c${issue.comments.length + 1}`,
        body,
        createdAt: next.toISOString(),
      });
      save(data);
    },

    async states() {
      const states = stateList(load());
      if (states.length === 0) throw new FixtureError(`${FIXTURE_PATH} lists no states`);
      return states.map(({ name, type }) => ({ name, type }));
    },

    async setState(identifier, name) {
      const { data, issue, id } = find(identifier);
      if (!stateList(data).some((state) => state.name === name)) {
        throw new FixtureError(`Team ${team} has no status named ${name} (moving ${id})`);
      }
      issue.state = name;
      // Linear moves `updatedAt` on every change to the issue; pickup reads it as activity.
      issue.updatedAt = new Date().toISOString();
      save(data);
    },

    async label(identifier, add, remove) {
      const { data, issue } = find(identifier);
      const known = new Set(data.labels ?? []);
      const missing = [...add, ...remove].filter((name) => !known.has(name));
      const next = new Set(issue.labels);
      for (const name of add) if (known.has(name)) next.add(name);
      for (const name of remove) next.delete(name);
      issue.labels = [...next];
      save(data);
      return { labels: [...issue.labels], missing };
    },
  };
}
