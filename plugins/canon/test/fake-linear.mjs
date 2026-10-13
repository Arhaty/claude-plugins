/**
 * A fake Linear GraphQL API, so no test reaches the network.
 *
 * `fakeLinear(state)` returns a `fetch` that answers the operations
 * `scripts/tracker/linear.mjs` sends, by operation name, from `state` and writes
 * mutations back into it. Every request is appended to `state.requests` with its
 * operation, variables and whether it carried the key.
 *
 * Preloaded with `node --import`, this module replaces the global `fetch` for the
 * whole process, reading and writing the state as JSON in `$CANON_LINEAR_STUB`, so
 * a test can run `scripts/tracker.mjs` as a skill would and inspect what it did.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** A team `ABC` with the seven statuses `TRACKER` maps, and one issue in Todo. */
export function linearState(overrides = {}) {
  const names = ['Todo', 'In Spec', 'Approved', 'In Progress', 'Blocked', 'In Staging', 'Done'];
  return {
    key: 'lin_api_test',
    states: { ABC: names.map((name, i) => ({ id: `s${i}`, name, type: 'started', position: i })) },
    labels: [
      { id: 'l1', name: 'domain-auth', team: 'ABC', parent: null },
      { id: 'l2', name: 'domain-billing', team: null, parent: null },
      { id: 'l3', name: 'domain-auth', team: 'XYZ', parent: null },
      { id: 'g1', name: 'surface-app', team: 'ABC', parent: 'group' },
      { id: 'g2', name: 'surface-site', team: 'ABC', parent: 'group' },
    ],
    issues: {
      'ABC-1': {
        id: 'uuid-1',
        team: 'ABC',
        title: 'Rate-limit password reset',
        description: 'Limit reset requests per account.',
        state: 'Todo',
        labels: [],
        comments: [],
      },
    },
    requests: [],
    ...overrides,
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeLinear(state, { onChange = () => {} } = {}) {
  const byId = (id) =>
    Object.entries(state.issues).find(([key, issue]) => key === id || issue.id === id);
  const label = (id) => state.labels.find((candidate) => candidate.id === id);
  const shape = ([identifier, issue]) => ({
    id: issue.id,
    identifier,
    title: issue.title,
    description: issue.description,
    url: `https://linear.app/example/issue/${identifier}`,
    team: { key: issue.team },
    state: { name: issue.state },
    labels: {
      nodes: issue.labels.map((id) => ({
        id,
        name: label(id).name,
        parent: label(id).parent ? { id: label(id).parent } : null,
      })),
    },
  });

  return async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
    state.requests.push({
      operation,
      variables,
      url,
      authorized: init.headers.authorization === state.key,
    });
    onChange(state);
    if (state.fail)
      return state.fail === 'graphql'
        ? json(200, { errors: [{ message: 'Entity not found' }] })
        : json(state.fail, { echoed: init.headers });
    if (init.headers.authorization !== state.key) return json(400, { error: 'bad key' });

    const found = variables.id === undefined ? null : byId(variables.id);
    let data;
    switch (operation) {
      case 'Issue':
        data = { issue: found ? shape(found) : null };
        break;
      case 'Comments': {
        const all = found[1].comments;
        const start = variables.after ? Number(variables.after) : 0;
        const page = all.slice(start, start + 2);
        data = {
          issue: {
            comments: {
              nodes: page,
              pageInfo: {
                hasNextPage: start + 2 < all.length,
                endCursor: start + 2 < all.length ? String(start + 2) : null,
              },
            },
          },
        };
        break;
      }
      case 'Comment':
        found[1].comments.push({
          id: `c${found[1].comments.length + 1}`,
          body: variables.body,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, found[1].comments.length)).toISOString(),
        });
        data = { commentCreate: { success: true } };
        break;
      case 'States':
        data = { workflowStates: { nodes: state.states[variables.team] ?? [] } };
        break;
      case 'SetState': {
        const target = Object.values(state.states)
          .flat()
          .find((candidate) => candidate.id === variables.stateId);
        found[1].state = target.name;
        data = { issueUpdate: { success: true } };
        break;
      }
      case 'Labels':
        data = {
          issueLabels: {
            nodes: state.labels
              .filter((candidate) => variables.names.includes(candidate.name))
              .map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
                parent: candidate.parent ? { id: candidate.parent } : null,
                team: candidate.team ? { key: candidate.team } : null,
              })),
          },
        };
        break;
      case 'Label': {
        const groups = variables.labelIds.map((id) => label(id).parent).filter(Boolean);
        if (new Set(groups).size !== groups.length) {
          return json(200, { errors: [{ message: 'two labels from one group' }] });
        }
        found[1].labels = variables.labelIds;
        data = { issueUpdate: { success: true, issue: shape(found) } };
        break;
      }
      default:
        return json(200, { errors: [{ message: `unknown operation ${operation}` }] });
    }
    onChange(state);
    return json(200, { data });
  };
}

const file = process.env.CANON_LINEAR_STUB;
if (file) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  globalThis.fetch = fakeLinear(state, {
    onChange: (next) => writeFileSync(file, JSON.stringify(next, null, 2)),
  });
}
