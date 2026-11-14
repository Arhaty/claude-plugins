import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';

import type { CloudSnapshot, CloudTask } from '../types';

const snapshot = atom({ plugin: 'pulse', key: 'snapshot' } as const, null);
const isHidden = atom({ plugin: 'pulse', key: 'isHidden' } as const, false);

const POLL_MS = 60_000;
const API = 'https://api.anthropic.com/v1/code/sessions?limit=100';
// Idle sessions that were never archived fill pages too; follow the cursor this far at most.
const MAX_PAGES = 5;
const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]+$/;
const TITLE_MAX = 28;
const NO_LOGIN = 'pulse: cloud sessions need a claude.ai login, so the row stays hidden';

// Only sessions doing something right now, or waiting on you; idle ones are just unarchived history.
const LABELS: Record<string, { icon: string; color: string; text: string }> = {
  running: { icon: '●', color: 'green', text: 'running' },
  starting: { icon: '●', color: 'green', text: 'starting' },
  pending: { icon: '◌', color: 'gray', text: 'queued' },
  requires_action: { icon: '◆', color: 'yellow', text: 'needs you' },
  waiting: { icon: '◆', color: 'yellow', text: 'needs you' },
};

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
  if (isPlaceholder(title) || !(status in LABELS)) return null;
  const tool = r?.external_metadata?.pending_action?.tool_name;
  return {
    id,
    title,
    status,
    url: `https://claude.ai/code/${webId(id)}`,
    pendingTool: typeof tool === 'string' ? tool : null,
  };
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
        let detail = '';
        try {
          detail = JSON.parse(res.text)?.error?.message ?? '';
        } catch {
          detail = res.text.slice(0, 120);
        }
        return {
          tasks: [],
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
    return { tasks: [], error: `cloud tasks: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// The session's own: the module starts over on a reload, and session.start sets them again.
let isActive = false; // the session can draw the row: interactive, on a surface with a prompt
let timer: Timer | null = null;
let latest = 0;
let toldNoLogin = false;

function stop(): void {
  timer?.cancel();
  timer = null;
}

async function poll($: EngineInterface): Promise<void> {
  if (!isActive || (await read($, isHidden))) return;
  const seq = ++latest;
  const result = await check($);
  // A newer poll started while this one waited: its answer wins.
  if (seq !== latest || (await read($, isHidden))) return;

  if (result === 'no-login') {
    // Permanent until the person logs in: no row and no timer; each main turn checks again.
    stop();
    await update($, snapshot, () => null);
    if (!toldNoLogin) {
      toldNoLogin = true;
      $.ui.toast(NO_LOGIN);
    }
    return;
  }

  timer ??= $.clock.every(POLL_MS, () => void poll($));
  await update($, snapshot, () => result);
}

async function hide($: EngineInterface): Promise<void> {
  stop();
  await update($, isHidden, () => true);
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    stop();
    toldNoLogin = false;
    isActive = e.isInteractive && (e.surface === 'terminal' || e.surface === 'desktop');
    void poll($);
    return started;
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
    if (snap.error === null && snap.tasks.length === 0) return next(e);

    const { Box, Button, Link, Text } = $.ui.resolve(e);

    if (snap.error !== null) {
      return (
        <Box>
          <Text dimColor>☁ {snap.error} </Text>
          <Button key="retry" label="Retry" onPress={() => poll($)} />
        </Box>
      );
    }

    const shown = snap.tasks.slice(0, 4);
    const extra = snap.tasks.length - shown.length;

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>☁ {snap.tasks.length} cloud: </Text>
        {shown.map((t) => {
          const l = LABELS[t.status] ?? { icon: '○', color: 'gray', text: t.status };
          const state = t.pendingTool ? `${l.text}: approve ${t.pendingTool}` : l.text;
          return (
            <Text key={t.id}>
              <Text color={l.color}>{l.icon}</Text> <Link href={t.url}>{shorten(t.title)}</Link>{' '}
              <Text dimColor>({state} ↗) </Text>
            </Text>
          );
        })}
        {extra > 0 ? <Text dimColor>+{extra} more </Text> : null}
        <Button key="refresh" label="↻" onPress={() => poll($)} />
        <Button key="hide" label="Hide" onPress={() => hide($)} />
      </Box>
    );
  });
};
