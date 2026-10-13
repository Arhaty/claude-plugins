/**
 * Linear, behind the interface `scripts/tracker.mjs` expects of a provider:
 *
 *   createClient({ apiKey, team, fetch?, timeoutMs? }) -> {
 *     issue(id), comments(id), comment(id, body), setState(id, name),
 *     label(id, add, remove), states(),
 *   }
 *
 * Every method takes an identifier such as `ABC-123` and works in status names;
 * `tracker.mjs` owns the mapping from canon's roles to those names. Talks to the
 * GraphQL API with global `fetch` and nothing else.
 *
 * **Not the Linear MCP server.** Its OAuth needs a browser, which a cloud session
 * does not have, and two clients would drift.
 */

export const KEY_VARIABLE = 'LINEAR_API_KEY';

const ENDPOINT = 'https://api.linear.app/graphql';

/**
 * Long enough for any query here, short enough that a hung connection fails the
 * command rather than holding a session until its own timeout.
 */
const TIMEOUT_MS = 30_000;

export class LinearError extends Error {}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  team { key }
  state { name }
  labels { nodes { id name parent { id } } }
`;

/** `abc-123` and `ABC-123` alike, as Linear writes it, or a throw. */
export function parseIdentifier(identifier) {
  const match = /^([A-Za-z0-9]+)-([0-9]+)$/.exec(String(identifier ?? '').trim());
  if (!match) throw new LinearError(`'${identifier}' is not an issue identifier, e.g. ABC-123`);
  return { team: match[1].toUpperCase(), identifier: `${match[1].toUpperCase()}-${match[2]}` };
}

export function createClient({ apiKey, team, fetch: fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!apiKey) throw new LinearError(`${KEY_VARIABLE} is not set`);

  const timedOut = (error) => {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new LinearError(`Linear did not answer within ${timeoutMs / 1000}s`);
    }
    throw error;
  };

  async function request(query, variables = {}) {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        // A personal API key goes in unprefixed. `Bearer` is the OAuth form and
        // returns 400 for a plain key.
        authorization: apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(timedOut);

    // The body can echo request headers back, so only the status is safe to show.
    if (!response.ok) throw new LinearError(`Linear returned HTTP ${response.status}`);
    const payload = await response.json().catch(timedOut);
    if (payload?.errors?.length) {
      const reasons = payload.errors.map((error) => error?.message ?? 'unknown').join('; ');
      throw new LinearError(`Linear refused the request: ${reasons}`);
    }
    if (!payload?.data) throw new LinearError('Linear returned no data');
    return payload.data;
  }

  /** The raw issue, refused unless it belongs to the configured team. */
  async function raw(identifier) {
    const id = parseIdentifier(identifier).identifier;
    const data = await request(`query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, {
      id,
    });
    const node = data.issue;
    if (!node) throw new LinearError(`No issue ${id}`);
    if (node.team?.key !== team) {
      throw new LinearError(`${id} belongs to team ${node.team?.key ?? 'unknown'}, not ${team}`);
    }
    return node;
  }

  const shape = (node) => ({
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? '',
    url: node.url,
    state: node.state?.name ?? '',
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
  });

  async function issue(identifier) {
    return shape(await raw(identifier));
  }

  /**
   * Every comment, oldest first, paged to the end. No author: who wrote a comment
   * decides nothing, because the key is usually the owner's own and Claude's
   * comments and the owner's replies come from the same user.
   */
  async function comments(identifier) {
    const { id } = await raw(identifier);
    const nodes = [];
    let after = null;
    for (;;) {
      const data = await request(
        `query Comments($id: String!, $after: String) {
          issue(id: $id) {
            comments(first: 100, after: $after) {
              nodes { id body createdAt }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id, after }
      );
      const page = data.issue?.comments;
      nodes.push(...(page?.nodes ?? []));
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
      after = page.pageInfo.endCursor;
    }
    return nodes
      .map(({ id: commentId, body, createdAt }) => ({ id: commentId, body: body ?? '', createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function comment(identifier, body) {
    const { id, identifier: name } = await raw(identifier);
    const data = await request(
      `mutation Comment($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) { success }
      }`,
      { id, body }
    );
    if (!data.commentCreate?.success)
      throw new LinearError(`Linear rejected the comment on ${name}`);
  }

  /** The team's statuses in board order, as `{ name, type }`. */
  async function states() {
    const data = await request(
      `query States($team: String!) {
        workflowStates(filter: { team: { key: { eq: $team } } }, first: 100) {
          nodes { id name type position }
        }
      }`,
      { team }
    );
    const nodes = data.workflowStates?.nodes ?? [];
    if (nodes.length === 0)
      throw new LinearError(`Team ${team} has no statuses, or does not exist`);
    return nodes.sort((a, b) => a.position - b.position);
  }

  async function setState(identifier, name) {
    const node = await raw(identifier);
    const state = (await states()).find((candidate) => candidate.name === name);
    if (!state) throw new LinearError(`Team ${team} has no status named ${name}`);
    const data = await request(
      `mutation SetState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: node.id, stateId: state.id }
    );
    if (!data.issueUpdate?.success) {
      throw new LinearError(`Linear rejected moving ${node.identifier} to ${name}`);
    }
  }

  /**
   * Label names resolved to labels this team can use: its own, or the workspace's.
   * A name that resolves to nothing is reported, never created: the label set is a
   * routing contract with `docs/canon/`, and a typo would stay in the workspace.
   */
  async function resolveLabels(names) {
    if (names.length === 0) return { found: new Map(), missing: [] };
    const data = await request(
      `query Labels($names: [String!]!) {
        issueLabels(filter: { name: { in: $names } }, first: 100) {
          nodes { id name parent { id } team { key } }
        }
      }`,
      { names }
    );
    const found = new Map();
    for (const label of data.issueLabels?.nodes ?? []) {
      const key = label.team?.key ?? null;
      if (key !== null && key !== team) continue;
      // The team's own label wins over a workspace label of the same name.
      if (found.has(label.name) && key === null) continue;
      found.set(label.name, { id: label.id, parentId: label.parent?.id ?? null });
    }
    return { found, missing: names.filter((name) => !found.has(name)) };
  }

  /**
   * Add and remove labels. The write is the whole set, so it reads the current one
   * first. A label group is single-select and Linear refuses two of its members, so
   * adding one member drops the one already there.
   */
  async function label(identifier, add, remove) {
    const node = await raw(identifier);
    const [added, removed] = await Promise.all([resolveLabels(add), resolveLabels(remove)]);
    const claimed = new Set(
      [...added.found.values()].map((found) => found.parentId).filter((id) => id !== null)
    );
    const next = new Set(
      (node.labels?.nodes ?? [])
        .filter((current) => !current.parent || !claimed.has(current.parent.id))
        .map((current) => current.id)
    );
    for (const { id } of added.found.values()) next.add(id);
    for (const { id } of removed.found.values()) next.delete(id);

    const data = await request(
      `mutation Label($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) { success issue { ${ISSUE_FIELDS} } }
      }`,
      { id: node.id, labelIds: [...next] }
    );
    if (!data.issueUpdate?.success || !data.issueUpdate.issue) {
      throw new LinearError(`Linear rejected relabelling ${node.identifier}`);
    }
    return {
      labels: shape(data.issueUpdate.issue).labels,
      missing: [...added.missing, ...removed.missing],
    };
  }

  return { issue, comments, comment, setState, label, states };
}
