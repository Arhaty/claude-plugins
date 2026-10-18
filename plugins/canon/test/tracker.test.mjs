/**
 * The tracker client, against a fake Linear API: `scripts/tracker/linear.mjs` on its
 * own, then `scripts/tracker.mjs` as the skills run it. No test reaches the network.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { trust, trustKeyCommand } from '../hooks/lib/config.mjs';
import {
  BLOCKED_MARKER,
  blockedState,
  envFileValue,
  Relaunched,
  httpsProxy,
  main,
  noProxyCovers,
  nodeHasEnvProxy,
  resolveKey,
} from '../scripts/tracker.mjs';
import { LinearError, createClient, parseIdentifier } from '../scripts/tracker/linear.mjs';
import { fakeLinear, linearState } from './fake-linear.mjs';
import {
  CONFIG,
  ROOT,
  TRACKER,
  afterEach,
  beforeEach,
  describe,
  expect,
  fakeHome,
  it,
  makeProject,
} from './helpers.mjs';

/** `fn` must reject with a message matching `pattern`. */
async function rejects(fn, pattern) {
  try {
    await fn();
  } catch (error) {
    expect(String(error?.message)).toMatch(pattern);
    return error;
  }
  throw new Error(`expected a rejection matching ${pattern}`);
}

describe('the Linear provider', () => {
  let state;
  let client;

  beforeEach(() => {
    state = linearState();
    client = createClient({ apiKey: state.key, team: 'ABC', fetch: fakeLinear(state) });
  });

  it('reads an issue, sending the key unprefixed', async () => {
    expect(await client.issue('abc-1')).toEqual({
      identifier: 'ABC-1',
      title: 'Rate-limit password reset',
      description: 'Limit reset requests per account.',
      url: 'https://linear.app/example/issue/ABC-1',
      state: 'Todo',
      labels: [],
    });
    expect(state.requests[0]).toMatchObject({
      operation: 'Issue',
      url: 'https://api.linear.app/graphql',
      authorized: true,
    });
  });

  it('refuses an identifier that is not one, an issue that does not exist, and another team', async () => {
    expect(() => parseIdentifier('ABC 1')).toThrow();
    await rejects(() => client.issue('ABC-99'), /No issue ABC-99/);
    state.issues['XYZ-4'] = { ...state.issues['ABC-1'], id: 'uuid-4', team: 'XYZ' };
    await rejects(() => client.issue('XYZ-4'), /belongs to team XYZ, not ABC/);
  });

  it('pages every comment, oldest first, with no author', async () => {
    const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
    state.issues['ABC-1'].comments = [3, 1, 4, 2, 0].map((minute) => ({
      id: `c${minute}`,
      body: `comment ${minute}`,
      createdAt: at(minute),
      user: { name: 'Same Person' },
    }));
    const comments = await client.comments('ABC-1');
    expect(comments.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(Object.keys(comments[0]).sort()).toEqual(['body', 'createdAt', 'id']);
    expect(state.requests.filter((r) => r.operation === 'Comments').length).toBe(3);
  });

  it('moves an issue to a status by name, and refuses a name the team does not have', async () => {
    await client.setState('ABC-1', 'In Spec');
    expect(state.issues['ABC-1'].state).toBe('In Spec');
    await rejects(() => client.setState('ABC-1', 'Shipped'), /no status named Shipped/);
    expect(state.issues['ABC-1'].state).toBe('In Spec');
  });

  it("labels with the team's own or the workspace's labels, and creates none", async () => {
    const result = await client.label(
      'ABC-1',
      ['domain-auth', 'domain-billing', 'domain-typo'],
      []
    );
    expect(result).toEqual({ labels: ['domain-auth', 'domain-billing'], missing: ['domain-typo'] });
    // The team's `domain-auth`, not XYZ's.
    expect(state.issues['ABC-1'].labels).toEqual(['l1', 'l2']);

    await client.label('ABC-1', [], ['domain-billing']);
    expect(state.issues['ABC-1'].labels).toEqual(['l1']);
  });

  it('removes a label by the name on the issue, whichever team it belongs to', async () => {
    // The issue carries the workspace's domain-billing; the team has none, and XYZ's
    // domain-auth on the issue is not the team's own.
    state.issues['ABC-1'].labels = ['l2', 'l3'];
    expect(
      await client.label('ABC-1', [], ['domain-billing', 'domain-auth', 'domain-none'])
    ).toEqual({
      labels: [],
      missing: ['domain-none'],
    });
  });

  it('names two members of one single-select group rather than sending both', async () => {
    await rejects(
      () => client.label('ABC-1', ['surface-app', 'surface-site'], []),
      /surface-app and surface-site are both in the label group Surface/
    );
    expect(state.requests.some((r) => r.operation === 'Label')).toBe(false);
  });

  it('finds a label a parent team holds, and works where there are no sub-teams', async () => {
    expect(await client.label('ABC-1', ['domain-search'], [])).toEqual({
      labels: ['domain-search'],
      missing: [],
    });
    const flat = linearState({ ancestorsFail: true });
    const plain = createClient({ apiKey: flat.key, team: 'ABC', fetch: fakeLinear(flat) });
    expect(await plain.label('ABC-1', ['domain-search', 'domain-auth'], [])).toEqual({
      labels: ['domain-auth'],
      missing: ['domain-search'],
    });
  });

  it('swaps a member of a single-select group rather than adding a second', async () => {
    await client.label('ABC-1', ['surface-app'], []);
    await client.label('ABC-1', ['surface-site'], []);
    expect(state.issues['ABC-1'].labels).toEqual(['g2']);
  });

  it('reports an HTTP failure by status alone, never the body', async () => {
    state.fail = 500;
    const error = await rejects(() => client.issue('ABC-1'), /HTTP 500/);
    expect(error.message).not.toContain(state.key);
  });

  it('reports a GraphQL error and a timeout', async () => {
    state.fail = 'graphql';
    await rejects(() => client.issue('ABC-1'), /Entity not found/);

    const hung = createClient({
      apiKey: 'k',
      team: 'ABC',
      timeoutMs: 50,
      fetch: (_, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        ),
    });
    // `AbortSignal.timeout` does not hold the event loop open, and a real request's socket
    // would. Without this, Node 20 and 22 end the test before the timeout fires.
    const alive = setInterval(() => {}, 1_000);
    try {
      await rejects(() => hung.issue('ABC-1'), /did not answer within/);
    } finally {
      clearInterval(alive);
    }
  });

  it('refuses to start without a key', () => {
    expect(() => createClient({ apiKey: '', team: 'ABC' })).toThrow();
    expect(new LinearError('x') instanceof Error).toBe(true);
  });
});

describe('a blocked issue', () => {
  // With the owner's own key, Claude's question and the owner's reply come from the
  // same user, so these carry one author on purpose: nothing may read it.
  const comment = (id, body) => ({
    id,
    body,
    createdAt: `2026-01-01T00:0${id}:00.000Z`,
    user: { name: 'Owner' },
  });

  it('is open from the marked question until a later comment without the marker', () => {
    expect(blockedState([])).toBeNull();
    expect(blockedState([comment(1, 'The spec, posted.')])).toBeNull();

    const question = comment(1, `${BLOCKED_MARKER}\n\nWhich limit?`);
    expect(blockedState([question])).toEqual({ question, answers: [] });

    const answer = comment(2, 'Five per hour.');
    expect(blockedState([question, answer])).toEqual({ question, answers: [answer] });
  });

  it('reads the newest question, and only what came after it', () => {
    const first = comment(1, `${BLOCKED_MARKER}\n\nWhich limit?`);
    const reply = comment(2, 'Five per hour.');
    const second = comment(3, `  ${BLOCKED_MARKER}\n\nPer account or per address?`);
    expect(blockedState([first, reply, second])).toEqual({ question: second, answers: [] });
    const later = comment(4, 'Per account.');
    expect(blockedState([first, reply, second, later])?.answers).toEqual([later]);
  });

  it('does not take a marked comment as the answer', () => {
    const first = comment(1, `${BLOCKED_MARKER}\n\nWhich limit?`);
    const again = comment(2, `${BLOCKED_MARKER}\n\nStill waiting on the limit.`);
    expect(blockedState([first, again])).toEqual({ question: again, answers: [] });
  });
});

describe('tracker.mjs', () => {
  let project;
  let state;
  let home;
  let restoreHome;
  let savedProjectDir;
  const env = () => ({ LINEAR_API_KEY: state.key });
  const run = (argv, options = {}) =>
    main(argv, { cwd: project, env: env(), fetch: fakeLinear(state), ...options });

  beforeEach(() => {
    // A developer's own session sets this, and it would point the client at their checkout.
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    restoreHome = fakeHome(home);
    project = makeProject({ config: { ...CONFIG, tracker: TRACKER } });
    state = linearState();
  });
  afterEach(() => {
    restoreHome();
    if (savedProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('reads an issue with the role its status maps to', async () => {
    expect(await run(['issue', 'ABC-1'])).toMatchObject({ state: 'Todo', role: 'ready' });
    state.issues['ABC-1'].state = 'Triage';
    expect((await run(['issue', 'ABC-1'])).role).toBeNull();
  });

  it("sets the four roles a skill owns, by the team's names", async () => {
    for (const [role, name] of [
      ['spec', 'In Spec'],
      ['approved', 'Approved'],
      ['building', 'In Progress'],
      ['blocked', 'Blocked'],
    ]) {
      expect(await run(['set-state', 'ABC-1', role])).toEqual({ ok: true, role, state: name });
      expect(state.issues['ABC-1'].state).toBe(name);
    }
  });

  it('reports a usage error before looking for a key', async () => {
    for (const argv of [
      ['issue'],
      ['set-state', 'ABC-1'],
      ['label', 'ABC-1'],
      ['issue', '--bogus', 'ABC-1'],
    ]) {
      const error = await rejects(() => run(argv, { env: {} }), /needs|does not take/);
      expect(error.code, argv.join(' ')).toBe(2);
    }
  });

  it('refuses to set ready, staging or production, and sends nothing', async () => {
    for (const role of ['ready', 'staging', 'production']) {
      await rejects(() => run(['set-state', 'ABC-1', role]), /Refusing to set/);
    }
    const error = await rejects(() => run(['set-state', 'ABC-1', 'done']), /needs a role/);
    expect(error.code).toBe(2);
    expect(state.requests.filter((r) => r.operation === 'SetState')).toEqual([]);
  });

  it('marks a blocked question, and reads the answer after it', async () => {
    await run(['comment', 'ABC-1', '--blocked'], { stdin: 'Which limit applies?' });
    const [question] = state.issues['ABC-1'].comments;
    expect(question.body).toBe(`${BLOCKED_MARKER}\n\nWhich limit applies?`);
    expect((await run(['comments', 'ABC-1'])).blocked).toMatchObject({ answers: [] });

    // canon's own report after the question is not an answer.
    await run(['comment', 'ABC-1'], { stdin: 'Stopped. Waiting on the limit.' });
    expect((await run(['comments', 'ABC-1'])).blocked.answers).toEqual([]);

    // The owner answers with the same key, so as the same user, with no marker.
    state.issues['ABC-1'].comments.push({
      id: 'owner',
      body: 'Five per hour.',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const { blocked } = await run(['comments', 'ABC-1']);
    expect(blocked.question.body).toBe(question.body);
    expect(blocked.answers.map((c) => c.body)).toEqual(['Five per hour.']);
  });

  it('refuses an empty comment and a body given as arguments', async () => {
    await rejects(() => run(['comment', 'ABC-1'], { stdin: '  ' }), /body on stdin/);
    await rejects(() => run(['comment', 'ABC-1', 'hello'], { stdin: 'x' }), /on stdin, not as/);
  });

  it("marks every comment as canon's, and reads a flag wherever it is", async () => {
    await run(['comment', '--blocked', 'ABC-1'], { stdin: 'Which limit?' });
    await run(['comment', 'ABC-1'], { stdin: 'Shipped.' });
    expect(state.issues['ABC-1'].comments.map((c) => c.body)).toEqual([
      'canon: blocked\n\nWhich limit?',
      'canon: note\n\nShipped.',
    ]);
    const error = await rejects(
      () => run(['comment', 'ABC-1', '--loud'], { stdin: 'x' }),
      /does not take --loud/
    );
    expect(error.code).toBe(2);
    await rejects(() => run(['issue', '--blocked', 'ABC-1']), /does not take --blocked/);
  });

  it("takes the project from the environment it is given, not the process's", async () => {
    const elsewhere = makeProject();
    try {
      process.env.CLAUDE_PROJECT_DIR = elsewhere;
      expect(
        (await run(['issue', 'ABC-1'], { env: { ...env(), CLAUDE_PROJECT_DIR: project } })).role
      ).toBe('ready');
      await rejects(
        () => run(['issue', 'ABC-1'], { env: { ...env(), CLAUDE_PROJECT_DIR: elsewhere } }),
        /sets no tracker/
      );
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('adds and removes labels, reporting a name that does not exist', async () => {
    expect(await run(['label', 'ABC-1', '+domain-auth,domain-billing,+nope'])).toEqual({
      labels: ['domain-auth', 'domain-billing'],
      missing: ['nope'],
    });
    expect((await run(['label', 'ABC-1', '-domain-billing'])).labels).toEqual(['domain-auth']);
    const both = await rejects(
      () => run(['label', 'ABC-1', '+domain-auth,-domain-auth']),
      /adds and removes domain-auth/
    );
    expect(both.code).toBe(2);
  });

  it("lists a team's statuses from a partial config, for setup", async () => {
    const answers = join(project, 'answers.json');
    writeFileSync(answers, JSON.stringify({ tracker: { provider: 'linear', team: 'ABC' } }));
    const states = await run(['--config', answers, 'states']);
    expect(states.map((s) => s.name)).toEqual([
      'Todo',
      'In Spec',
      'Approved',
      'In Progress',
      'Blocked',
      'In Staging',
      'Done',
    ]);
    // With no tracker configured at all, the team comes from the argument.
    const bare = makeProject();
    try {
      expect((await run(['states', 'abc'], { cwd: bare })).length).toBe(7);
      await rejects(() => run(['states'], { cwd: bare }), /needs a team key/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('refuses every issue command in a project with no tracker', async () => {
    const bare = makeProject();
    try {
      await rejects(() => run(['issue', 'ABC-1'], { cwd: bare }), /sets no tracker/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    await rejects(() => run(['frobnicate']), /unknown command/);
  });

  it('runs end to end as a skill would, without printing the key', () => {
    const stub = join(project, 'linear.json');
    writeFileSync(stub, JSON.stringify(state));
    const cli = (args, input) =>
      spawnSync(process.execPath, [join(ROOT, 'scripts/tracker.mjs'), ...args], {
        cwd: project,
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          LINEAR_API_KEY: state.key,
          CANON_LINEAR_STUB: stub,
          NODE_OPTIONS: `--import=${pathToFileURL(join(ROOT, 'test/fake-linear.mjs'))}`,
        },
      });

    const set = cli(['set-state', 'ABC-1', 'spec']);
    expect(set.status, set.stderr).toBe(0);
    expect(JSON.parse(readFileSync(stub, 'utf8')).issues['ABC-1'].state).toBe('In Spec');

    const issue = cli(['issue', 'ABC-1']);
    expect(JSON.parse(issue.stdout).role).toBe('spec');
    expect(issue.stdout + issue.stderr).not.toContain(state.key);

    const refused = cli(['set-state', 'ABC-1', 'production']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^tracker: Refusing to set production/);
    expect(cli(['set-state', 'ABC-1']).status).toBe(2);
  });
});

describe('behind a proxy', () => {
  const PROXY = { HTTPS_PROXY: 'http://proxy.internal:3128' };
  const NODE = '24.12.0';
  let project;
  let home;
  let restoreHome;
  let savedProjectDir;
  let state;
  let spawned;
  let globals;
  const fakeSpawn = (...args) => {
    spawned.push(args);
    return { status: 3, signal: null };
  };
  const run = (env, options = {}) =>
    main(options.argv ?? ['issue', 'ABC-1'], {
      cwd: project,
      env: { LINEAR_API_KEY: 'placeholder', ...env },
      version: NODE,
      fetch: fakeLinear(state),
      setGlobalProxy: null,
      execArgv: [],
      spawn: fakeSpawn,
      ...options,
    });

  beforeEach(() => {
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    restoreHome = fakeHome(home);
    project = makeProject({ config: { ...CONFIG, tracker: TRACKER } });
    state = linearState({ key: 'placeholder' });
    spawned = [];
    globals = [];
  });
  afterEach(() => {
    restoreHome();
    if (savedProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('re-runs once with the flag when the proxy is set and the flag is not, sending nothing', async () => {
    for (const env of [
      PROXY,
      { https_proxy: PROXY.HTTPS_PROXY },
      { HTTP_PROXY: PROXY.HTTPS_PROXY },
    ]) {
      spawned = [];
      const result = await run(env, { argv: ['--config', '.claude/canon.json', 'issue', 'ABC-1'] });
      expect(result).toEqual(new Relaunched(3, null));
      expect(spawned.length).toBe(1);
      const [execPath, args, options] = spawned[0];
      expect(execPath).toBe(process.execPath);
      expect(args.slice(-6)).toEqual([
        '--disable-warning=UNDICI-EHPA',
        join(ROOT, 'scripts/tracker.mjs'),
        '--config',
        '.claude/canon.json',
        'issue',
        'ABC-1',
      ]);
      expect(options).toEqual({
        env: { LINEAR_API_KEY: 'placeholder', ...env, NODE_USE_ENV_PROXY: '1' },
        stdio: 'inherit',
      });
    }
    expect(state.requests).toEqual([]);
  });

  it('turns the proxy on in-process instead, where Node can', async () => {
    const setGlobalProxy = (env) => globals.push(env);
    expect(await run(PROXY, { setGlobalProxy })).toMatchObject({ identifier: 'ABC-1' });
    expect(globals).toEqual([{ LINEAR_API_KEY: 'placeholder', ...PROXY }]);
    expect(spawned).toEqual([]);
  });

  it('passes on a signal, and reports a child that would not start', async () => {
    const killed = await run(PROXY, { spawn: () => ({ status: null, signal: 'SIGINT' }) });
    expect(killed).toEqual(new Relaunched(null, 'SIGINT'));
    const error = await rejects(
      () => run(PROXY, { spawn: () => ({ error: new Error('spawnSync node EAGAIN') }) }),
      /could not re-run/
    );
    expect(error.message).toBe('could not re-run through the proxy: spawnSync node EAGAIN');
  });

  it('does nothing when the flag is already set, which is also the second run', async () => {
    for (const value of ['1', '0']) {
      await run({ ...PROXY, NODE_USE_ENV_PROXY: value });
    }
    await run({ ...PROXY, NODE_OPTIONS: '--use-env-proxy' });
    await run(PROXY, { execArgv: ['--use-env-proxy'] });
    expect(spawned).toEqual([]);
    expect(state.requests.length).toBe(4);
    // Node reads an empty flag as unset, and so does the relaunch.
    expect(await run({ ...PROXY, NODE_USE_ENV_PROXY: '' })).toEqual(new Relaunched(3, null));
  });

  it('hands a body given to main to the child on its stdin', async () => {
    await run(PROXY, { argv: ['comment', 'ABC-1'], stdin: 'the body' });
    expect(spawned[0][2]).toMatchObject({
      input: 'the body',
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  });

  it('does nothing with no proxy, a NO_PROXY that covers Linear, or a Node without the flag', async () => {
    for (const env of [
      {},
      { ...PROXY, NO_PROXY: 'localhost,api.linear.app' },
      { ...PROXY, no_proxy: '.linear.app' },
      { ...PROXY, NO_PROXY: '*' },
      { https_proxy: '', HTTPS_PROXY: PROXY.HTTPS_PROXY },
    ]) {
      await run(env);
    }
    for (const version of ['20.19.0', '22.20.0', '23.11.0']) await run(PROXY, { version });
    expect(spawned).toEqual([]);
  });

  it('does nothing before argv is sound, or for a provider that sends no request', async () => {
    await rejects(() => run(PROXY, { argv: ['frobnicate'] }), /unknown command/);
    await rejects(() => run(PROXY, { argv: ['set-state', 'ABC-1'] }), /needs a role/);
    const fixture = makeProject({
      config: { ...CONFIG, tracker: { ...TRACKER, provider: 'fixture' } },
    });
    try {
      await rejects(() => run(PROXY, { cwd: fixture }), /tracker-fixture\.json does not exist/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
    expect(spawned).toEqual([]);
  });

  it('reads the variables as Node does', () => {
    expect(httpsProxy({ https_proxy: 'a', HTTPS_PROXY: 'b' })).toBe('a');
    expect(httpsProxy({ https_proxy: '', HTTPS_PROXY: 'b' })).toBeNull();
    expect(httpsProxy({ HTTPS_PROXY: '', HTTP_PROXY: 'c' })).toBe('c');
    expect(httpsProxy({ http_proxy: '', HTTP_PROXY: 'c' })).toBeNull();
    const host = 'api.linear.app';
    for (const entry of [
      '.linear.app',
      '*.linear.app',
      'API.LINEAR.APP',
      'x.com api.linear.app:443',
      '.app',
      '*',
    ]) {
      expect(noProxyCovers(host, entry), entry).toBe(true);
    }
    for (const entry of ['linear.app', 'api.linear.app:8443', 'xapi.linear.app', '']) {
      expect(noProxyCovers(host, entry), entry).toBe(false);
    }
    for (const version of ['22.21.0', '24.0.0', '24.4.1', '25.0.0']) {
      expect(nodeHasEnvProxy(version), version).toBe(true);
    }
    for (const version of ['20.19.0', '22.20.0', '23.11.0']) {
      expect(nodeHasEnvProxy(version), version).toBe(false);
    }
  });

  describe('a 401', () => {
    beforeEach(() => {
      state.fail = 401;
    });

    it('with a placeholder key and an unused proxy, says Node skipped the proxy', async () => {
      let error = await rejects(() => run({ ...PROXY, NODE_USE_ENV_PROXY: '0' }), /HTTP 401/);
      expect(error.message).toBe(
        'Linear returned HTTP 401: LINEAR_API_KEY is a placeholder the HTTPS proxy replaces ' +
          'on the way out, and Node is not sending the request through the proxy. ' +
          'Set NODE_USE_ENV_PROXY=1.'
      );
      error = await rejects(() => run(PROXY, { version: '20.19.0' }), /HTTP 401/);
      expect(error.message).toMatch(
        /through the proxy\. Node 20\.19\.0 cannot: use Node 22\.21, 24 or later\.$/
      );
      error = await rejects(() => run({ ...PROXY, NO_PROXY: 'api.linear.app' }), /HTTP 401/);
      expect(error.message).toMatch(
        /through the proxy\. NO_PROXY sends api\.linear\.app direct: take that entry out\.$/
      );
    });

    it("with a placeholder key through the proxy, blames the proxy's credential", async () => {
      const error = await rejects(() => run({ ...PROXY, NODE_USE_ENV_PROXY: '1' }), /HTTP 401/);
      expect(error.message).toBe(
        'Linear returned HTTP 401: LINEAR_API_KEY is a placeholder and the request went ' +
          "through the HTTPS proxy, so the credential the proxy put in its place was rejected. Fix it in the proxy's " +
          'credentials; the placeholder needs no change.'
      );
    });

    it('with the proxy on by the command-line flag, blames the proxy, not the flag', async () => {
      const error = await rejects(
        () => run({ ...PROXY, NODE_USE_ENV_PROXY: '0', NODE_OPTIONS: '--use-env-proxy' }),
        /HTTP 401/
      );
      expect(error.message).toMatch(/so the credential the proxy put in its place was rejected/);
    });

    it('with a key that is not one from a file, names the file rather than the proxy', async () => {
      writeFileSync(join(project, '.env.local'), 'LINEAR_API_KEY=lin-api-typo\n');
      const env = { ...PROXY, NODE_USE_ENV_PROXY: '0' };
      const error = await rejects(() => run(PROXY, { env }), /HTTP 401/);
      expect(error.message).toBe(
        'Linear returned HTTP 401: it rejected the LINEAR_API_KEY from .env.local at the ' +
          'project root. Change it there.'
      );
    });

    it('with a real-looking key, or no proxy, names where the key was read from', async () => {
      let error = await rejects(
        () => run({ ...PROXY, NODE_USE_ENV_PROXY: '0', LINEAR_API_KEY: 'lin_api_x' }),
        /HTTP 401/
      );
      expect(error.message).toBe(
        'Linear returned HTTP 401: it rejected the LINEAR_API_KEY from the environment. ' +
          'Change it there.'
      );
      error = await rejects(() => run({}), /HTTP 401/);
      expect(error.message).toMatch(/from the environment\. Change it there\.$/);

      writeFileSync(join(project, '.env.local'), 'LINEAR_API_KEY=lin_api_old\n');
      error = await rejects(() => run({}, { env: {} }), /HTTP 401/);
      expect(error.message).toBe(
        'Linear returned HTTP 401: it rejected the LINEAR_API_KEY from .env.local at the ' +
          'project root. Change it there.'
      );
      expect(error.message).not.toContain('lin_api_old');

      state.fail = 500;
      await rejects(() => run({}), /^Linear returned HTTP 500$/);
    });
  });

  it('sends the request through the proxy, with no warning, when run as a skill would', async (t) => {
    if (!nodeHasEnvProxy()) {
      t.skip(`Node ${process.versions.node} cannot send fetch through a proxy`);
      return;
    }
    t.diagnostic(http.setGlobalProxyFromEnv ? 'in-process' : 'relaunched');
    const seen = [];
    const proxy = createServer((socket) => {
      socket.once('data', (chunk) => {
        seen.push(chunk.toString('latin1').split('\r\n')[0]);
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
    });
    await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const project = makeProject({ config: { ...CONFIG, tracker: TRACKER } });
    try {
      const env = { ...process.env };
      for (const name of [
        'NODE_USE_ENV_PROXY',
        'NODE_OPTIONS',
        'https_proxy',
        'http_proxy',
        'HTTP_PROXY',
        'NO_PROXY',
        'no_proxy',
      ]) {
        delete env[name];
      }
      const child = spawn(process.execPath, [join(ROOT, 'scripts/tracker.mjs'), 'issue', 'ABC-1'], {
        cwd: project,
        env: {
          ...env,
          HOME: home,
          CLAUDE_PROJECT_DIR: project,
          LINEAR_API_KEY: 'placeholder',
          HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
        },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const status = await new Promise((done) => child.on('close', done));
      expect(status, stderr).toBe(1);
      expect(seen).toEqual(['CONNECT api.linear.app:443 HTTP/1.1']);
      expect(stderr).not.toMatch(/Warning/);
      expect(stderr.match(/^tracker:/gm)?.length, stderr).toBe(1);
    } finally {
      proxy.close();
      rmSync(project, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the API key', () => {
  let project;
  let home;
  let restoreHome;
  const tracker = { ...TRACKER, apiKeyCommand: ['secret-tool', 'lookup', 'linear'] };
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    return 'from-command\n';
  };
  const key = (env = {}, t = tracker) =>
    resolveKey({ root: project, tracker: t, variable: 'LINEAR_API_KEY', env, run });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    restoreHome = fakeHome(home);
    project = makeProject({ config: { ...CONFIG, tracker } });
    calls.length = 0;
  });
  afterEach(() => {
    restoreHome();
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('comes from the environment, then .env.local, then the approved command', () => {
    trustKeyCommand(project, tracker.apiKeyCommand);
    writeFileSync(join(project, '.env.local'), 'OTHER=1\nLINEAR_API_KEY="from-file"\n');
    expect(key({ LINEAR_API_KEY: ' from-env ' })).toBe('from-env');
    expect(key()).toBe('from-file');
    expect(calls).toEqual([]);
    rmSync(join(project, '.env.local'));
    expect(key()).toBe('from-command');
    expect(calls).toEqual([tracker.apiKeyCommand]);
  });

  it('never runs a command the owner has not approved, or approved as something else', () => {
    expect(() => key()).toThrow(/not approved/);
    // The same argv approved as the formatter, written out rather than read from the
    // key command, which is not something the trust store ever hashes.
    trust(project, ['secret-tool', 'lookup', 'linear']);
    expect(() => key()).toThrow(/not approved/);
    trustKeyCommand(project, [...tracker.apiKeyCommand, '--changed']);
    expect(() => key()).toThrow(/not approved/);
    expect(calls).toEqual([]);
  });

  it('refuses a key command that names the repository, and runs the rest from home', () => {
    mkdirSync(join(project, 'scripts'));
    writeFileSync(join(project, 'scripts/key.sh'), 'echo key\n');
    symlinkSync(join(project, 'scripts/key.sh'), join(home, 'key-link'));
    for (const command of [
      ['./scripts/key.sh'],
      ['bash', join(project, 'scripts/key.sh')],
      ['sh', '-c', `${project}/scripts/key.sh | tr -d x`],
      ['node', `--require=${project}/k.js`, '-e', ''],
      [join(home, 'key-link')],
    ]) {
      trustKeyCommand(project, command);
      expect(
        () => key({}, { ...TRACKER, apiKeyCommand: command }),
        JSON.stringify(command)
      ).toThrow(/so it was not run/);
    }
    expect(calls).toEqual([]);
    // A relative argument is the home directory's business: the command runs there.
    const relative = ['bash', 'scripts/key.sh'];
    trustKeyCommand(project, relative);
    expect(key({}, { ...TRACKER, apiKeyCommand: relative })).toBe('from-command');
  });

  it('ignores a .env.local the repository commits', () => {
    spawnSync('git', ['init', '-q'], { cwd: project });
    writeFileSync(join(project, '.env.local'), 'LINEAR_API_KEY=someone-elses\n');
    spawnSync('git', ['add', '-f', '.env.local'], { cwd: project });
    expect(() => key({}, TRACKER)).toThrow(/committed to the repository, so it was not read/);
    trustKeyCommand(project, tracker.apiKeyCommand);
    expect(key()).toBe('from-command');
  });

  it('says where it looked when there is no key anywhere', () => {
    expect(() => key({}, TRACKER)).toThrow(/environment or in \.env\.local/);
  });

  it('reads one key out of a dotenv file and nothing else', () => {
    const file = [
      '# comment',
      'LINEAR_API_KEY_OLD=no',
      "export LINEAR_API_KEY='quoted value'",
      'NEXT=1',
    ].join('\n');
    expect(envFileValue(file, 'LINEAR_API_KEY')).toBe('quoted value');
    expect(envFileValue('LINEAR_API_KEY=bare # note', 'LINEAR_API_KEY')).toBe('bare');
    expect(envFileValue('LINEAR_API_KEY=', 'LINEAR_API_KEY')).toBeNull();
    expect(envFileValue('NOT_IT=1', 'LINEAR_API_KEY')).toBeNull();
  });
});

describe('the fixture tracker', () => {
  let project;
  let savedProjectDir;
  const fixture = () =>
    JSON.parse(readFileSync(join(project, '.claude/tracker-fixture.json'), 'utf8'));
  const run = (argv, options = {}) => main(argv, { cwd: project, env: {}, ...options });

  beforeEach(() => {
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    project = makeProject({ config: { ...CONFIG, tracker: { ...TRACKER, provider: 'fixture' } } });
    writeFileSync(
      join(project, '.claude/tracker-fixture.json'),
      JSON.stringify({
        states: Object.values(TRACKER.statuses),
        labels: ['domain-auth'],
        issues: { 'ABC-7': { title: 'Rate-limit resets', state: 'In Progress' } },
      })
    );
  });
  afterEach(() => {
    if (savedProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    rmSync(project, { recursive: true, force: true });
  });

  it('reads and moves an issue with no key and no network', async () => {
    expect(await run(['issue', 'ABC-7'])).toMatchObject({ state: 'In Progress', role: 'building' });
    await run(['set-state', 'ABC-7', 'blocked']);
    expect(fixture().issues['ABC-7'].state).toBe('Blocked');
    await rejects(() => run(['set-state', 'ABC-7', 'production']), /Refusing to set production/);
  });

  it('keeps comments and labels in the file, marked as the client marks them', async () => {
    await run(['comment', 'ABC-7', '--blocked'], { stdin: 'Which limit?' });
    expect((await run(['comments', 'ABC-7'])).blocked).toMatchObject({ answers: [] });
    expect(await run(['label', 'ABC-7', '+domain-auth,+domain-typo'])).toEqual({
      labels: ['domain-auth'],
      missing: ['domain-typo'],
    });
    expect(fixture().issues['ABC-7'].comments[0].body).toBe('canon: blocked\n\nWhich limit?');
  });

  it('posts after a comment whose date it cannot read', async () => {
    const data = fixture();
    data.issues['ABC-7'].comments = [{ body: 'old', createdAt: 'yesterday' }];
    writeFileSync(join(project, '.claude/tracker-fixture.json'), JSON.stringify(data));
    await run(['comment', 'ABC-7'], { stdin: 'new' });
    expect(fixture().issues['ABC-7'].comments.length).toBe(2);
  });

  it('refuses a missing issue, another team, and a symlinked file', async () => {
    await rejects(() => run(['issue', 'ABC-99']), /No issue ABC-99/);
    await rejects(() => run(['issue', 'XYZ-7']), /belongs to team XYZ/);
    const elsewhere = join(tmpdir(), `canon-fixture-${process.pid}.json`);
    writeFileSync(elsewhere, readFileSync(join(project, '.claude/tracker-fixture.json')));
    rmSync(join(project, '.claude/tracker-fixture.json'));
    symlinkSync(elsewhere, join(project, '.claude/tracker-fixture.json'));
    try {
      await rejects(() => run(['issue', 'ABC-7']), /is a symlink/);
    } finally {
      rmSync(elsewhere, { force: true });
    }
  });
});
