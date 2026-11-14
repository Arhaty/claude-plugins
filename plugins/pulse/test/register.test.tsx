import { expect, mock, test } from 'claude-code/testing';
import type { Engine, MockClock } from 'claude-code/testing';
import type { HttpResponse, On, RenderSurface } from 'claude-code';

const BAND = {
  plugin: 'pulse',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const;

const SURFACES = ['terminal', 'desktop'] as const;

const response = (status: number, body: unknown): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { 'content-type': 'application/json' },
  text: typeof body === 'string' ? body : JSON.stringify(body),
});

// Made-up sessions, one for each case the filter decides.
const RUNNING = {
  id: 'session_01Running',
  title: 'Refactor the parser',
  status: 'active',
  worker_status: 'running',
};
const IDLE = { id: 'session_01Idle', title: 'Old idea', status: 'active', worker_status: 'idle' };
const ROWS = [
  RUNNING,
  {
    id: 'cse_01Waiting',
    title: 'Migrate the build',
    status: 'active',
    worker_status: 'requires_action',
    external_metadata: { pending_action: { tool_name: 'Bash' } },
  },
  IDLE,
  { id: 'session_01Archived', title: 'Done work', status: 'archived', worker_status: 'running' },
  {
    id: 'session_01Bridge',
    title: 'Local shared',
    status: 'active',
    worker_status: 'running',
    environment_kind: 'bridge',
  },
  { id: 'session_01Warm', title: '__warming__', status: 'active', worker_status: 'running' },
  { id: 'session_01Pool', title: 'x __CBU_POOLED__ y', status: 'active', worker_status: 'running' },
  { id: 'session_01Ditto', title: 'ditto:abc', status: 'active', worker_status: 'running' },
  { id: 'session_01Empty', title: '  ', status: 'active', worker_status: 'running' },
  { id: 'not-a-session', title: 'Bad id', status: 'active', worker_status: 'running' },
];

type Answer = { kind: 'bearer' | 'api-key'; handle: string } | null;
type Fetch = (url: string) => HttpResponse | Promise<HttpResponse>;

/** Stands for the engine: the login, the API, the clock, toasts and the band's own drawing. */
function engine(
  on: On,
  auth: Answer | 'refused' | (() => Answer),
  fetch: Fetch,
  surfaces: () => readonly RenderSurface[] = () => ['terminal']
) {
  const requests: string[] = [];
  const toasts: string[] = [];
  let authorizations = 0;
  const clock = mock.clock(on);
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.attach', (_, e) => ({ clientId: e.clientId }));
  on('session.detach', (_, e) => ({ clientId: e.clientId }));
  on('session.surfaces', () => ({ value: surfaces() }));
  on('turn.complete', () => ({ text: '' }));
  on('ui.toast', (_, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on('session.authorize', () => {
    authorizations += 1;
    const answer = typeof auth === 'function' ? auth() : auth;
    // 'refused' stands for a hook above refusing the call: authorize() rejects.
    return answer === 'refused' ? { deny: 'refused by a hook' } : { value: answer };
  });
  on('http.fetch', async (_, e) => {
    requests.push(e.url);
    return { value: await fetch(e.url) };
  });
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  return { requests, toasts, clock, authorizations: () => authorizations };
}

async function start($: Engine, clock: MockClock, isInteractive = true) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive });
  await clock.settle();
}

async function turn($: Engine, clock: MockClock, agentId?: string) {
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  });
  await clock.settle();
}

const ok = (rows: unknown[]) => () => response(200, { data: rows });
const BEARER: Answer = { kind: 'bearer', handle: 'h' };

test('keeps running and waiting sessions, drops the rest', async ($, on) => {
  const { requests, clock } = engine(on, BEARER, ok(ROWS));
  await start($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: 'Text', text: /2 cloud/ }))?.text).toContain('2 cloud');
    expect(await ui.find({ type: 'Link', text: 'Refactor the parser' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /needs you: approve Bash/ })).toBeDefined();
    for (const dropped of ['Old idea', 'Done work', 'Local shared', 'Bad id', 'ditto:abc']) {
      expect(await ui.find({ type: 'Link', text: dropped })).toBeUndefined();
    }
    await ui.unmount();
  }
  expect(requests).toEqual(['https://api.anthropic.com/v1/code/sessions?limit=100']);
});

test('links a cse_ id to its session_ page', async ($, on) => {
  const { clock } = engine(on, BEARER, ok(ROWS));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  const link = await ui.find({ type: 'Link', text: 'Migrate the build' });
  expect(link?.props.href).toBe('https://claude.ai/code/session_01Waiting');
  const plain = await ui.find({ type: 'Link', text: 'Refactor the parser' });
  expect(plain?.props.href).toBe('https://claude.ai/code/session_01Running');
  await ui.unmount();
});

test('cuts a long title by code point, never inside an emoji', async ($, on) => {
  const title = `${'a'.repeat(26)}🚀🚀🚀`;
  const { clock } = engine(on, BEARER, ok([{ ...RUNNING, title }]));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect((await ui.find({ type: 'Link' }))?.children).toEqual([`${'a'.repeat(26)}🚀…`]);
  await ui.unmount();
});

test('without a claude.ai login: no row, one toast, no timer', async ($, on) => {
  const { requests, toasts, clock, authorizations } = engine(on, null, ok(ROWS));
  await start($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine');
    await ui.unmount();
  }
  await clock.advance(5 * 60_000);
  expect(authorizations()).toBe(1);
  await turn($, clock);
  expect(authorizations()).toBe(2);
  expect(toasts).toEqual(['pulse: cloud sessions need a claude.ai login, so the row stays hidden']);
  expect(requests).toEqual([]);
});

test('an API key is not a claude.ai login', async ($, on) => {
  const { requests, toasts, clock } = engine(on, { kind: 'api-key', handle: 'h' }, ok(ROWS));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine');
  await ui.unmount();
  expect(toasts.length).toBe(1);
  expect(requests).toEqual([]);
});

test('a login that arrives later starts polling', async ($, on) => {
  let auth: Answer = null;
  const { requests, clock } = engine(on, () => auth, ok([RUNNING]));
  await start($, clock);
  expect(requests.length).toBe(0);

  auth = BEARER;
  await turn($, clock);
  expect(requests.length).toBe(1);
  await clock.advance(60_000);
  expect(requests.length).toBe(2);
});

test('authorize refused shows an error instead of throwing', async ($, on) => {
  const { clock } = engine(on, 'refused', ok(ROWS));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /cloud tasks: .*refused by a hook/ })).toBeDefined();
  expect(await ui.find({ key: 'retry' })).toBeDefined();
  await ui.unmount();
});

test('an HTTP error shows the status and the message', async ($, on) => {
  const { clock } = engine(on, BEARER, () => response(404, { error: { message: 'not found' } }));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /cloud tasks: HTTP 404 – not found/ })).toBeDefined();
  await ui.unmount();
});

test('an HTTP error without a JSON body shows the start of the body', async ($, on) => {
  const { clock } = engine(on, BEARER, () => response(502, '<html>bad gateway</html>'));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /HTTP 502 – <html>bad gateway/ })).toBeDefined();
  await ui.unmount();
});

test('nothing active draws nothing of its own', async ($, on) => {
  const { clock } = engine(on, BEARER, ok([IDLE]));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine');
  await ui.unmount();
});

test('yields the band to a survey', async ($, on) => {
  const { clock } = engine(on, BEARER, ok(ROWS));
  await start($, clock);

  const ui = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
    surface: 'terminal',
  });
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine');
  await ui.unmount();
});

test('polls again every 60 s', async ($, on) => {
  let rows: unknown[] = [];
  const { requests, clock } = engine(on, BEARER, () => response(200, { data: rows }));
  await start($, clock);
  expect(requests.length).toBe(1);

  rows = [RUNNING];
  await clock.advance(60_000);
  expect(requests.length).toBe(2);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Link', text: 'Refactor the parser' })).toBeDefined();
  await ui.unmount();
});

test('polls after a main turn, not after a subagent turn', async ($, on) => {
  const { requests, clock } = engine(on, BEARER, ok(ROWS));
  await start($, clock);
  expect(requests.length).toBe(1);

  await turn($, clock, 'agent-1');
  expect(requests.length).toBe(1);
  await turn($, clock);
  expect(requests.length).toBe(2);
});

test('↻ checks again now', async ($, on) => {
  let rows: unknown[] = [RUNNING];
  const { requests, clock } = engine(on, BEARER, () => response(200, { data: rows }));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  rows = ROWS;
  await ui.press({ key: 'refresh' });
  expect(requests.length).toBe(2);
  expect(await ui.find({ type: 'Link', text: 'Migrate the build' })).toBeDefined();
  await ui.unmount();
});

test('Hide removes the row and stops polling', async ($, on) => {
  const { requests, clock } = engine(on, BEARER, ok(ROWS));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /cloud:/ })).toBeDefined();
  await ui.press({ key: 'hide' });
  expect(await ui.find({ type: 'Text', text: /cloud:/ })).toBeUndefined();
  await ui.unmount();

  await clock.advance(5 * 60_000);
  await turn($, clock);
  expect(requests.length).toBe(1);
});

test('a non-interactive session never fetches', async ($, on) => {
  const { requests, clock, authorizations } = engine(on, BEARER, ok(ROWS));
  await start($, clock, false);
  await clock.advance(5 * 60_000);
  await turn($, clock);
  expect(requests).toEqual([]);
  expect(authorizations()).toBe(0);
});

test('an older answer arriving late does not overwrite a newer one', async ($, on) => {
  let calls = 0;
  const { clock } = engine(on, BEARER, async () => {
    calls += 1;
    if (calls === 1) {
      await clock.sleep(1_000); // the first poll is slow, and its answer is stale
      return response(200, { data: [IDLE] });
    }
    return response(200, { data: [RUNNING] });
  });
  await start($, clock);
  await turn($, clock);
  await clock.advance(1_000);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Link', text: 'Refactor the parser' })).toBeDefined();
  await ui.unmount();
});

test('follows the cursor to later pages', async ($, on) => {
  const later = { ...RUNNING, id: 'session_01Later', title: 'Still running' };
  const { requests, clock } = engine(on, BEARER, (url) =>
    url.includes('after_id=')
      ? response(200, { data: [later], has_more: false })
      : response(200, { data: [RUNNING, IDLE], has_more: true, last_id: 'session_01Idle' })
  );
  await start($, clock);

  expect(requests[1]).toBe(
    'https://api.anthropic.com/v1/code/sessions?limit=100&after_id=session_01Idle'
  );
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /2 cloud/ })).toBeDefined();
  expect(await ui.find({ type: 'Link', text: 'Still running' })).toBeDefined();
  await ui.unmount();
});

test('stops paging when the cursor is ignored', async ($, on) => {
  const { requests, clock } = engine(on, BEARER, () =>
    response(200, { data: [RUNNING], has_more: true, last_id: 'session_01Running' })
  );
  await start($, clock);

  expect(requests.length).toBe(2);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /1 cloud/ })).toBeDefined();
  await ui.unmount();
});

test('an error row can be hidden, which stops checking', async ($, on) => {
  const { requests, clock } = engine(on, BEARER, () => response(403, { error: { message: 'no' } }));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /HTTP 403/ })).toBeDefined();
  await ui.press({ key: 'hide' });
  expect(await ui.find({ type: 'Text', text: /HTTP 403/ })).toBeUndefined();
  await ui.unmount();

  await clock.advance(5 * 60_000);
  await turn($, clock);
  expect(requests.length).toBe(1);
});

test('a later page failing keeps the sessions already found', async ($, on) => {
  const { clock } = engine(on, BEARER, (url) =>
    url.includes('after_id=')
      ? response(429, { error: { message: 'slow down' } })
      : response(200, { data: [RUNNING], has_more: true, last_id: 'session_01Running' })
  );
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Link', text: 'Refactor the parser' })).toBeDefined();
  expect(
    await ui.find({ type: 'Text', text: /incomplete: cloud tasks: HTTP 429 – slow down/ })
  ).toBeDefined();
  await ui.unmount();
});

test('names a tool to approve only for a session waiting on you', async ($, on) => {
  const stale = { ...RUNNING, external_metadata: { pending_action: { tool_name: 'Bash' } } };
  const { clock } = engine(on, BEARER, ok([stale]));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /\(running ↗\)/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /approve/ })).toBeUndefined();
  await ui.unmount();
});

test('a check slower than the period still lands, and the next one follows it', async ($, on) => {
  let calls = 0;
  const { requests, clock } = engine(on, BEARER, async () => {
    calls += 1;
    if (calls === 1) {
      await clock.sleep(70_000); // longer than the 60 s period
      return response(200, { data: [IDLE] });
    }
    return response(200, { data: [RUNNING] });
  });
  await start($, clock);
  await turn($, clock); // asked while the first check runs: folded into one after it
  await clock.advance(70_000);

  expect(requests.length).toBe(2);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Link', text: 'Refactor the parser' })).toBeDefined();
  await ui.unmount();
});

test('a status named like an object key is not a status', async ($, on) => {
  const rows = ['constructor', 'toString', '__proto__'].map((worker_status, i) => ({
    ...RUNNING,
    id: `session_01Odd${i}`,
    worker_status,
  }));
  const { clock } = engine(on, BEARER, ok(rows));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine');
  await ui.unmount();
});

const BODIES: [unknown, string][] = [
  [{ error: 'rate_limited' }, 'HTTP 429 – rate_limited'],
  [{ detail: 'try later' }, 'HTTP 429 – try later'],
  [{ error: { message: { code: 1 } } }, 'HTTP 429 – {"error":{"message":{"code":1}}}'],
];
for (const [body, shown] of BODIES) {
  test(`an error body ${JSON.stringify(body)} shows ${shown}`, async ($, on) => {
    const { clock } = engine(on, BEARER, () => response(429, body));
    await start($, clock);
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
    expect((await ui.find({ type: 'Text', text: /HTTP 429/ }))?.text).toContain(shown);
    await ui.unmount();
  });
}

test('a desktop client attaching later turns the row on', async ($, on) => {
  let surfaces: RenderSurface[] = [];
  const { requests, clock } = engine(on, BEARER, ok([RUNNING]), () => surfaces);
  await $.session.start({ cwd: '/', surface: null, isInteractive: true });
  await clock.settle();
  expect(requests).toEqual([]);

  surfaces = ['desktop'];
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' });
  await clock.settle();
  expect(requests.length).toBe(1);
});

test('the no-login toast stays once across a reload', async ($, on) => {
  const { toasts, clock } = engine(on, null, ok(ROWS));
  await start($, clock);
  await start($, clock); // a reload runs session.start again
  expect(toasts.length).toBe(1);
});

test('an unknown status left in a stored snapshot is not counted', async ($, on) => {
  const stored = {
    tasks: [
      ...[1, 2, 3].map((i) => ({
        id: `session_0${i}`,
        title: `Gone ${i}`,
        status: 'retired',
        url: 'u',
        pendingTool: null,
      })),
      { id: 'session_04', title: 'Known', status: 'running', url: 'u', pendingTool: null },
    ],
    error: null,
  };
  // What a version before a reload wrote, read back by the new one.
  on('state.get', (_, e, next) =>
    e.key === 'snapshot' ? { value: { value: stored, version: 1 } } : next(e)
  );

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /☁ 1 cloud/ })).toBeDefined();
  expect(await ui.find({ type: 'Link', text: 'Known' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /more/ })).toBeUndefined();
  await ui.unmount();
});

test('a phone attaching never starts a check', async ($, on) => {
  let surfaces: RenderSurface[] = [];
  const { requests, clock } = engine(on, BEARER, ok([RUNNING]), () => surfaces);
  await $.session.start({ cwd: '/', surface: null, isInteractive: true });
  await clock.settle();

  surfaces = ['mobile'];
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:a' });
  await clock.settle();
  await clock.advance(5 * 60_000);
  expect(requests).toEqual([]);
});

test('a desktop attaching to a non-interactive session never starts a check', async ($, on) => {
  const { requests, clock } = engine(on, BEARER, ok([RUNNING]), () => ['desktop']);
  await $.session.start({ cwd: '/', surface: null, isInteractive: false });
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' });
  await clock.settle();
  await clock.advance(5 * 60_000);
  expect(requests).toEqual([]);
});

test('a desktop attaching to a session already polling adds no check', async ($, on) => {
  const { requests, clock } = engine(on, BEARER, ok([RUNNING]), () => ['terminal', 'desktop']);
  await start($, clock);
  expect(requests.length).toBe(1);
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' });
  await clock.settle();
  expect(requests.length).toBe(1);
});

test('the last surface leaving stops checking and clears the row', async ($, on) => {
  let surfaces: RenderSurface[] = ['desktop'];
  const { requests, clock } = engine(on, BEARER, ok([RUNNING]), () => surfaces);
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
  await clock.settle();
  expect(requests.length).toBe(1);

  surfaces = [];
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' });
  await clock.settle();
  await clock.advance(5 * 60_000);
  expect(requests.length).toBe(1);
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' });
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine');
  await ui.unmount();
});

test('a failed first page keeps the sessions the last check found', async ($, on) => {
  let fail = false;
  const { clock } = engine(on, BEARER, () =>
    fail ? response(429, { error: { message: 'slow down' } }) : response(200, { data: [RUNNING] })
  );
  await start($, clock);
  fail = true;
  await clock.advance(60_000);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Link', text: 'Refactor the parser' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /incomplete: cloud tasks: HTTP 429/ })).toBeDefined();
  expect(await ui.find({ key: 'retry' })).toBeUndefined();
  await ui.unmount();
});

test('a long or multi-line error stays one short line', async ($, on) => {
  const html = `<html>\n  <body>\n${'x'.repeat(500)}\n</body></html>`;
  const { clock } = engine(on, BEARER, () => response(502, html));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  const row = (await ui.find({ type: 'Text', text: /HTTP 502/ }))?.text ?? '';
  expect(row).not.toContain('\n');
  expect(row.length).toBeLessThan(170);
  await ui.unmount();
});

test('a login lost after one that worked tells again', async ($, on) => {
  let auth: Answer = null;
  const { toasts, clock } = engine(on, () => auth, ok([RUNNING]));
  await start($, clock);
  expect(toasts.length).toBe(1);

  auth = BEARER;
  await turn($, clock);
  auth = null;
  await turn($, clock);
  expect(toasts.length).toBe(2);
});
