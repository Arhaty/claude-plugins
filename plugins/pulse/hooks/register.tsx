import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';

import type { CloudSnapshot, CloudTask } from '../types';

const snapshot = atom({ plugin: 'pulse', key: 'snapshot' } as const, null);
const isHidden = atom({ plugin: 'pulse', key: 'isHidden' } as const, false);
// In session state, not the module: a reload starts the module over and would toast again.
const toldNoLogin = atom({ plugin: 'pulse', key: 'toldNoLogin' } as const, false);

const POLL_MS = 60_000;
const API = 'https://api.anthropic.com/v1/code/sessions?limit=100';
// Idle sessions that were never archived fill pages too; follow the cursor this far at most.
const MAX_PAGES = 5;
const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]+$/;
const TITLE_MAX = 28;
const NO_LOGIN = 'pulse: cloud sessions need a claude.ai login, so the row stays hidden';

// Only sessions doing something right now, or waiting on you; idle ones are just unarchived history.
// A Map, so an inherited key such as `constructor` is never a status.
const LABELS = new Map<string, { icon: string; color: string; text: string }>([
  ['running', { icon: '●', color: 'green', text: 'running' }],
  ['starting', { icon: '●', color: 'green', text: 'starting' }],
  ['pending', { icon: '◌', color: 'gray', text: 'queued' }],
  ['requires_action', { icon: '◆', color: 'yellow', text: 'needs you' }],
  ['waiting', { icon: '◆', color: 'yellow', text: 'needs you' }],
]);
// Only these are waiting on you; a pending_action left on a running session is stale.
const NEEDS_YOU = new Set(['requires_action', 'waiting']);

// claude.ai addresses sessions as session_…, the API may hand back cse_….
function webId(id: string): string {
  return id.startsWith('cse_') ? `session_${id.slice(4)}` : id;
}

// Placeholder rows the service keeps warm; never real tasks.
function isPlaceholder(title: string): boolean {
  return (
    title === '' ||
    title === '__warming__' ||
    title.includes('__CBU_POOLED__') ||
    title.startsWith('ditto:')
  );
}

// By code point, so an emoji is never cut in half.
function shorten(title: string): string {
  const chars = [...title];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : title;
}

function toTask(r: any): CloudTask | null {
  if (r?.environment_kind === 'bridge') return null; // a local session shared over Remote Control
  const id = String(r?.id ?? '');
  if (!SESSION_ID.test(id)) return null;
  const title = String(r?.title ?? '').trim();
  // `status` is only "active" or "archived"; the run state lives in `worker_status`.
  const status = r?.status === 'archived' ? 'archived' : String(r?.worker_status ?? 'idle');
  if (isPlaceholder(title) || !LABELS.has(status)) return null;
  const tool = NEEDS_YOU.has(status) ? r?.external_metadata?.pending_action?.tool_name : null;
  return {
    id,
    title,
    status,
    url: `https://claude.ai/code/${webId(id)}`,
    pendingTool: typeof tool === 'string' ? tool : null,
  };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// The row is one line: whitespace collapsed, and never longer than DETAIL_MAX.
const DETAIL_MAX = 120;
function oneLine(s: string): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > DETAIL_MAX ? `${chars.slice(0, DETAIL_MAX - 1).join('')}…` : chars.join('');
}

// The API's own message when the body says one, else the start of the body.
function errorDetail(body: string): string {
  try {
    const json = JSON.parse(body);
    const found =
      text(json?.error?.message) || text(json?.error) || text(json?.detail) || text(json?.message);
    if (found) return oneLine(found);
  } catch {
    // not JSON: fall through to the raw body
  }
  return oneLine(body);
}

/** One check: the snapshot to show, or 'no-login'. Never throws. */
async function check($: EngineInterface): Promise<CloudSnapshot | 'no-login'> {
  try {
    const auth = await $.session.authorize();
    if (auth === null || auth.kind !== 'bearer') return 'no-login';

    const headers = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    const tasks = new Map<string, CloudTask>();
    const seen = new Set<string>();
    let url = API;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await $.http.fetch(url, { headers, auth: auth.handle });
      if (!res.ok) {
        const detail = errorDetail(res.text);
        // A later page failing keeps what the earlier pages found, marked as incomplete.
        return {
          tasks: [...tasks.values()],
          error: `cloud tasks: HTTP ${res.status}${detail ? ` – ${detail}` : ''}`,
        };
      }

      const body = JSON.parse(res.text);
      const rows: any[] = Array.isArray(body?.data) ? body.data : [];
      const before = seen.size;
      for (const r of rows) {
        seen.add(String(r?.id ?? ''));
        const task = toTask(r);
        if (task !== null) tasks.set(task.id, task);
      }
      // Stop when there is no next page, or a page brought nothing new (the cursor was ignored).
      if (body?.has_more !== true || typeof body?.last_id !== 'string' || seen.size === before) {
        break;
      }
      url = `${API}&after_id=${encodeURIComponent(body.last_id)}`;
    }

    return { tasks: [...tasks.values()], error: null };
  } catch (err) {
    const message = oneLine(err instanceof Error ? err.message : String(err));
    return { tasks: [], error: `cloud tasks: ${message}` };
  }
}

// The session's own: the module starts over on a reload, and session.start sets them again.
let isInteractive = false;
let timer: Timer | null = null;
let running: Promise<void> | null = null;
let isAgain = false;

function stop(): void {
  timer?.cancel();
  timer = null;
}

// Asked on every poll, not once at start: a desktop client may attach later.
async function canDraw($: EngineInterface): Promise<boolean> {
  if (!isInteractive) return false;
  const surfaces = await $.session.surfaces();
  return surfaces.some((s) => s === 'terminal' || s === 'desktop');
}

/**
 * One check at a time. A poll asked for while one runs is folded into a single
 * check after it, so a slow API never leaves every answer superseded.
 */
function poll($: EngineInterface): Promise<void> {
  if (running !== null) {
    isAgain = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        isAgain = false;
        try {
          await pollOnce($);
        } catch {
          // State torn down mid-check (the session ending): nothing left to draw on.
        }
      } while (isAgain);
    } finally {
      running = null;
      isAgain = false;
    }
  })();
  return running;
}

async function pollOnce($: EngineInterface): Promise<void> {
  if (await read($, isHidden)) return;
  if (!(await canDraw($))) {
    // The last surface with a prompt left: stop, and drop what it would redraw on return.
    stop();
    await update($, snapshot, () => null);
    return;
  }
  const result = await check($);
  if (await read($, isHidden)) return;

  if (result === 'no-login') {
    // Permanent until the person logs in: no row and no timer; each main turn checks again.
    stop();
    await update($, snapshot, () => null);
    if (!(await read($, toldNoLogin))) {
      await update($, toldNoLogin, () => true);
      $.ui.toast(NO_LOGIN);
    }
    return;
  }

  if (await read($, toldNoLogin)) await update($, toldNoLogin, () => false); // a later logout tells again
  timer ??= $.clock.every(POLL_MS, () => void poll($));
  await update($, snapshot, (prev) => (result.error === null ? result : keepFound(prev, result)));
}

/**
 * A failed check keeps the sessions the last good one found, under the new ones, so one
 * transient error marks the row incomplete rather than replacing it.
 */
function keepFound(prev: CloudSnapshot | null, failed: CloudSnapshot): CloudSnapshot {
  const tasks = new Map((prev?.tasks ?? []).map((t) => [t.id, t] as const));
  for (const t of failed.tasks) tasks.set(t.id, t);
  return { tasks: [...tasks.values()], error: failed.error };
}

async function hide($: EngineInterface): Promise<void> {
  stop();
  await update($, isHidden, () => true);
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    stop();
    isInteractive = e.isInteractive;
    void poll($);
    return started;
  });

  // A desktop client attaching can turn the row on for a session that started without one.
  // Only desktop: a phone never draws the row, and a session already polling needs no extra check.
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    const result = await next(e);
    if (timer === null) void poll($);
    return result;
  });

  // The last surface with a prompt leaving stops the timer; the check says whether it was.
  on('session.detach', async ($, e, next) => {
    const result = await next(e);
    if (timer !== null && !(await canDraw($))) {
      stop();
      await update($, snapshot, () => null);
    }
    return result;
  });

  // Refresh when a main turn ends, so new tasks you just launched show up quickly.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) void poll($);
    return result;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot);
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) {
      return next(e);
    }
    // A snapshot stored before a reload may hold a status this version no longer shows.
    const tasks = snap.tasks.filter((t) => LABELS.has(t.status));
    if (snap.error === null && tasks.length === 0) return next(e);

    const { Box, Button, Link, Text } = $.ui.resolve(e);

    if (tasks.length === 0) {
      return (
        <Box>
          <Text dimColor>☁ {snap.error} </Text>
          <Button key="retry" label="Retry" onPress={() => poll($)} />
          <Button key="hide" label="Hide" onPress={() => hide($)} />
        </Box>
      );
    }

    const shown = tasks.slice(0, 4);
    const extra = tasks.length - shown.length;

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>☁ {tasks.length} cloud: </Text>
        {shown.map((t) => {
          const l = LABELS.get(t.status)!; // filtered above
          const state = t.pendingTool ? `${l.text}: approve ${t.pendingTool}` : l.text;
          return (
            <Text key={t.id}>
              <Text color={l.color}>{l.icon}</Text> <Link href={t.url}>{shorten(t.title)}</Link>{' '}
              <Text dimColor>({state} ↗) </Text>
            </Text>
          );
        })}
        {extra > 0 ? <Text dimColor>+{extra} more </Text> : null}
        {snap.error !== null ? <Text dimColor>(incomplete: {snap.error}) </Text> : null}
        <Button key="refresh" label="↻" onPress={() => poll($)} />
        <Button key="hide" label="Hide" onPress={() => hide($)} />
      </Box>
    );
  });
};
