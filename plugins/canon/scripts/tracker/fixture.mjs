/**
 * A tracker held in a file, for tests and evals: `.claude/tracker-fixture.json` in
 * the project. It needs no key and reaches no network, and it writes every change
 * back to the file, so a run can be checked by reading it afterwards.
 *
 *   {
 *     "states": ["Todo", "In Spec", ...],
 *     "labels": ["domain-auth", ...],
 *     "issues": {
 *       "ABC-7": { "title": "...", "description": "...", "state": "Todo",
 *                  "labels": [], "comments": [{ "body": "...", "createdAt": "..." }] }
 *     }
 *   }
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

  /** The data and the issue, refused unless it exists and belongs to the team. */
  const find = (identifier) => {
    const id = parseIdentifier(identifier).identifier;
    if (parseIdentifier(id).team !== team) {
      throw new FixtureError(`${id} belongs to team ${parseIdentifier(id).team}, not ${team}`);
    }
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
        title: issue.title ?? '',
        description: issue.description ?? '',
        url: `fixture:${id}`,
        state: issue.state ?? '',
        labels: [...issue.labels],
      };
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
      const last = issue.comments
        .map((c) => c.createdAt ?? '')
        .sort()
        .at(-1);
      const next = new Date(Math.max(Date.now(), last ? Date.parse(last) + 1000 : 0));
      issue.comments.push({
        id: `c${issue.comments.length + 1}`,
        body,
        createdAt: next.toISOString(),
      });
      save(data);
    },

    async states() {
      const states = load().states ?? [];
      if (states.length === 0) throw new FixtureError(`${FIXTURE_PATH} lists no states`);
      return states.map((name) => ({ name, type: 'fixture' }));
    },

    async setState(identifier, name) {
      const { data, issue, id } = find(identifier);
      if (!(data.states ?? []).includes(name)) {
        throw new FixtureError(`Team ${team} has no status named ${name} (moving ${id})`);
      }
      issue.state = name;
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
