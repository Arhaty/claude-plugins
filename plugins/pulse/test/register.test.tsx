import { expect, mock, test } from 'claude-code/testing';
import type { Engine, MockClock } from 'claude-code/testing';
import type { HttpResponse, On } from 'claude-code';

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
const ROWS = [
  {
    id: 'session_01Running',
    title: 'Refactor the parser',
    status: 'active',
    worker_status: 'running',
  },
  {
    id: 'cse_01Waiting',
    title: 'Migrate the build',
    status: 'active',
    worker_status: 'requires_action',
    external_metadata: { pending_action: { tool_name: 'Bash' } },
  },
  { id: 'session_01Idle', title: 'Old idea', status: 'active', worker_status: 'idle' },
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

/** Stands for the engine: the login, the API, the clock, and the prompt's own row. */
function engine(on: On, auth: Answer, res: () => HttpResponse) {
  const requests: string[] = [];
  const clock = mock.clock(on);
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.authorize', () => ({ value: auth }));
  on('http.fetch', (_, e) => {
    requests.push(e.url);
    return { value: res() };
  });
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  return { requests, clock };
}

async function start($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
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
  expect(requests[0]).toBe('https://api.anthropic.com/v1/code/sessions?limit=100');
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

test('without a claude.ai login it says so and fetches nothing', async ($, on) => {
  const { requests, clock } = engine(on, null, ok(ROWS));
  await start($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(
      await ui.find({ type: 'Text', text: /cloud tasks need a claude.ai login/ })
    ).toBeDefined();
    expect(await ui.find({ key: 'retry' })).toBeDefined();
    await ui.unmount();
  }
  expect(requests).toEqual([]);
});

test('an API key is not a claude.ai login', async ($, on) => {
  const { requests, clock } = engine(on, { kind: 'api-key', handle: 'h' }, ok(ROWS));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /need a claude.ai login/ })).toBeDefined();
  await ui.unmount();
  expect(requests).toEqual([]);
});

test('an HTTP error shows the status and the message', async ($, on) => {
  const { clock } = engine(on, BEARER, () => response(404, { error: { message: 'not found' } }));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /cloud tasks: HTTP 404 – not found/ })).toBeDefined();
  await ui.unmount();
});

test('nothing active draws nothing of its own', async ($, on) => {
  const { clock } = engine(on, BEARER, ok([ROWS[2]]));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /cloud/ })).toBeUndefined();
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine');
  await ui.unmount();
});

test('Hide removes the row', async ($, on) => {
  const { clock } = engine(on, BEARER, ok(ROWS));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /cloud:/ })).toBeDefined();
  await ui.press({ key: 'hide' });
  expect(await ui.find({ type: 'Text', text: /cloud:/ })).toBeUndefined();
  await ui.unmount();
});

test('an HTTP error without a JSON body shows the start of the body', async ($, on) => {
  const { clock } = engine(on, BEARER, () => response(502, '<html>bad gateway</html>'));
  await start($, clock);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /HTTP 502 – <html>bad gateway/ })).toBeDefined();
  await ui.unmount();
});

test('polls again every 60 s', async ($, on) => {
  let rows: unknown[] = [];
  const { requests, clock } = engine(on, BEARER, () => response(200, { data: rows }));
  await start($, clock);
  expect(requests.length).toBe(1);

  rows = [ROWS[0]];
  await clock.advance(60_000);
  expect(requests.length).toBe(2);

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Link', text: 'Refactor the parser' })).toBeDefined();
  await ui.unmount();
});
