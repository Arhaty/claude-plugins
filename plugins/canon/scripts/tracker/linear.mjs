/**
 * Linear, behind the interface `scripts/tracker.mjs` expects of a provider:
 *
 *   createClient({ apiKey, team, fetch?, timeoutMs? }) -> {
 *     issue(id), issues(names), comments(id), comment(id, body),
 *     setState(id, name), label(id, add, remove), states(),
 *   }
 *
 * Every method takes an identifier such as `ABC-123` and works in status names;
 * `tracker.mjs` owns the mapping from canon's roles to those names. Talks to the
 * GraphQL API with global `fetch` and nothing else.
 *
 * **Not the Linear MCP server.** Its OAuth needs a browser, which a cloud session
 * does not have, and two clients would drift.
 */

export const NAME = 'Linear';

export const KEY_VARIABLE = 'LINEAR_API_KEY';

export const ENDPOINT = 'https://api.linear.app/graphql';

/**
 * Long enough for any query here, short enough that a hung connection fails the
 * command rather than holding a session until its own timeout.
 */
const TIMEOUT_MS = 30_000;

export class LinearError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

/**
 * Whether `key` could be a personal API key at all. Every one starts `lin_api_`; a
 * key that does not is a stand-in, such as the `placeholder` a cloud session's
 * egress proxy swaps for the real credential.
 */
export const looksLikeKey = (key) => /^lin_api_\S+$/.test(key ?? '');

const ISSUE_FIELDS = `
  id
  identifier
  branchName
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
    if (!response.ok) {
      throw new LinearError(`Linear returned HTTP ${response.status}`, response.status);
    }
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
    branchName: node.branchName ?? '',
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

  /**
   * Page sizes for `issues`, kept under Linear's 10,000-point complexity limit: a
   * connection's children cost its `first` times over, so the nested relations cost
   * about `ISSUE_PAGE * RELATION_PAGE * 4` points. `test/tracker.test.mjs` checks it.
   */
  const ISSUE_PAGE = 25;
  const RELATION_PAGE = 25;
  const RELATION_FIELDS = `nodes { type issue { identifier state { name type } } }
    pageInfo { hasNextPage endCursor }`;

  /**
   * The team's issues in any of the statuses `names`, oldest first, paged to the end,
   * each with what `/canon:pickup` orders and gates on: the priority, when it was
   * created and last updated, its branch name, and the issues that block it with their
   * status. Linear stores "A blocks B" as a relation on A, so B's blockers are its
   * inverse relations of type `blocks`. An issue with more relations than one page
   * holds is paged to the end on its own, so no blocker is cut off.
   */
  async function issues(names) {
    const nodes = [];
    let after = null;
    for (;;) {
      const data = await request(
        `query Issues($team: String!, $states: [String!]!, $after: String) {
          issues(
            filter: { team: { key: { eq: $team } }, state: { name: { in: $states } } }
            first: ${ISSUE_PAGE}
            after: $after
          ) {
            nodes {
              id
              identifier
              title
              branchName
              priority
              createdAt
              updatedAt
              state { name type }
              inverseRelations(first: ${RELATION_PAGE}) { ${RELATION_FIELDS} }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { team, states: names, after }
      );
      const page = data.issues;
      nodes.push(...(page?.nodes ?? []));
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
      after = page.pageInfo.endCursor;
    }
    for (const node of nodes) {
      const relations = node.inverseRelations ?? {};
      relations.nodes ??= [];
      let info = relations.pageInfo;
      while (info?.hasNextPage && info.endCursor) {
        const data = await request(
          `query Blockers($id: String!, $after: String) {
            issue(id: $id) { inverseRelations(first: 50, after: $after) { ${RELATION_FIELDS} } }
          }`,
          { id: node.id, after: info.endCursor }
        );
        const more = data.issue?.inverseRelations;
        relations.nodes.push(...(more?.nodes ?? []));
        info = more?.pageInfo;
      }
      node.inverseRelations = relations;
    }
    return nodes
      .map((node) => ({
        identifier: node.identifier,
        title: node.title,
        branchName: node.branchName ?? '',
        priority: node.priority ?? 0,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        state: node.state?.name ?? '',
        stateType: node.state?.type ?? '',
        blockedBy: node.inverseRelations.nodes
          .filter((relation) => relation.type === 'blocks' && relation.issue)
          .map(({ issue: blocker }) => ({
            identifier: blocker.identifier,
            state: blocker.state?.name ?? '',
            stateType: blocker.state?.type ?? '',
          })),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
   * The team's parent teams, nearest first, whose labels a sub-team inherits. A
   * workspace without sub-teams, or an API that refuses the field, answers none.
   */
  let ancestry;
  async function ancestors() {
    ancestry ??= request(
      `query Ancestors($team: String!) {
        teams(filter: { key: { eq: $team } }, first: 1) {
          nodes { parent { key parent { key parent { key } } } }
        }
      }`,
      { team }
    ).then(
      (data) => {
        const keys = [];
        for (let at = data.teams?.nodes?.[0]?.parent; at; at = at.parent) keys.push(at.key);
        return keys;
      },
      () => []
    );
    return ancestry;
  }

  /**
   * Label names resolved to labels this team can use: its own, a parent team's, or
   * the workspace's, preferred in that order when two share a name. A name that
   * resolves to nothing is reported, never created: the label set is a routing
   * contract with `docs/canon/`, and a typo would stay in the workspace.
   */
  async function resolveLabels(names) {
    if (names.length === 0) return { found: new Map(), missing: [] };
    const [data, parents] = await Promise.all([
      request(
        `query Labels($names: [String!]!) {
          issueLabels(filter: { name: { in: $names } }, first: 100) {
            nodes { id name parent { id name } team { key } }
          }
        }`,
        { names }
      ),
      ancestors(),
    ]);
    const owners = [team, ...parents];
    const rank = (key) => (key === null ? owners.length : owners.indexOf(key));
    const found = new Map();
    for (const label of data.issueLabels?.nodes ?? []) {
      const at = rank(label.team?.key ?? null);
      if (at === -1) continue;
      if (found.has(label.name) && found.get(label.name).rank <= at) continue;
      found.set(label.name, {
        id: label.id,
        parentId: label.parent?.id ?? null,
        group: label.parent?.name ?? null,
        rank: at,
      });
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
    const added = await resolveLabels(add);
    // A single-select group takes one member: two of them in one call is a mistake to
    // name, not a write for Linear to refuse.
    const byGroup = new Map();
    for (const [name, found] of added.found) {
      if (found.parentId === null) continue;
      const other = byGroup.get(found.parentId);
      if (other) {
        throw new LinearError(
          `${other} and ${name} are both in the label group ${found.group ?? found.parentId}, which takes one`
        );
      }
      byGroup.set(found.parentId, name);
    }
    const claimed = new Set(
      [...added.found.values()].map((found) => found.parentId).filter((id) => id !== null)
    );
    const next = new Set(
      (node.labels?.nodes ?? [])
        .filter((current) => !current.parent || !claimed.has(current.parent.id))
        .map((current) => current.id)
    );
    for (const { id } of added.found.values()) next.add(id);
    // Removal goes by the names on the issue, whichever team's label each one is: the
    // label a name resolves to for adding may not be the one the issue carries.
    const current = node.labels?.nodes ?? [];
    for (const label of current) if (remove.includes(label.name)) next.delete(label.id);
    const notOn = remove.filter((name) => !current.some((label) => label.name === name));

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
      missing: [...added.missing, ...notOn],
    };
  }

  return { issue, issues, comments, comment, setState, label, states };
}
