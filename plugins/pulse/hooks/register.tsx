import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { CloudSnapshot, CloudTask } from '../types';

const snapshot = atom({ plugin: 'pulse', key: 'snapshot' } as const, null);
const isHidden = atom({ plugin: 'pulse', key: 'isHidden' } as const, false);

const POLL_MS = 60_000;
const API = 'https://api.anthropic.com/v1/code/sessions?limit=100';
// Only sessions doing something right now, or waiting on you; idle ones are just unarchived history.
const OPEN = new Set(['running', 'starting', 'pending', 'requires_action', 'waiting']);
const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]+$/;

const LABELS: Record<string, { icon: string; color: string; text: string }> = {
  running: { icon: '●', color: 'green', text: 'running' },
  starting: { icon: '●', color: 'green', text: 'starting' },
  pending: { icon: '◌', color: 'gray', text: 'queued' },
  requires_action: { icon: '◆', color: 'yellow', text: 'needs you' },
  waiting: { icon: '◆', color: 'yellow', text: 'needs you' },
  idle: { icon: '○', color: 'gray', text: 'idle' },
  paused: { icon: '○', color: 'gray', text: 'paused' },
  failed: { icon: '✕', color: 'red', text: 'failed' },
  error: { icon: '✕', color: 'red', text: 'failed' },
};

function label(status: string) {
  return LABELS[status] ?? { icon: '○', color: 'gray', text: status };
}

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

async function poll($: EngineInterface): Promise<void> {
  const now = await $.clock.now();
  const done = async (tasks: CloudTask[], error: string | null): Promise<void> => {
    const next: CloudSnapshot = { tasks, error, checkedAt: now };
    await update($, snapshot, () => next);
  };

  const auth = await $.session.authorize();
  if (auth === null || auth.kind !== 'bearer') {
    return done([], 'cloud tasks need a claude.ai login');
  }

  const headers = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

  try {
    const res = await $.http.fetch(API, { headers, auth: auth.handle });
    if (!res.ok) {
      let detail = '';
      try {
        detail = JSON.parse(res.text)?.error?.message ?? '';
      } catch {
        detail = res.text.slice(0, 120);
      }
      return done([], `cloud tasks: HTTP ${res.status}${detail ? ` – ${detail}` : ''}`);
    }

    const body = JSON.parse(res.text);
    const rows: any[] = Array.isArray(body?.data) ? body.data : [];
    const tasks = rows
      // "bridge" rows are local sessions shared over Remote Control, not cloud tasks.
      .filter((r) => r?.environment_kind !== 'bridge' && SESSION_ID.test(String(r?.id ?? '')))
      .map((r): CloudTask => ({
        id: String(r.id),
        title: String(r?.title ?? '').trim(),
        // `status` is only "active" or "archived"; the run state lives in `worker_status`.
        status: r?.status === 'archived' ? 'archived' : String(r?.worker_status ?? 'idle'),
        url: `https://claude.ai/code/${webId(String(r.id))}`,
        pendingTool:
          typeof r?.external_metadata?.pending_action?.tool_name === 'string'
            ? r.external_metadata.pending_action.tool_name
            : null,
      }))
      .filter((t) => !isPlaceholder(t.title) && OPEN.has(t.status));

    return done(tasks, null);
  } catch (err) {
    return done([], `cloud tasks: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    void poll($);
    $.clock.every(POLL_MS, () => void poll($));
    return started;
  });

  // Refresh when a turn ends, so new tasks you just launched show up quickly.
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
          const l = label(t.status);
          const title = t.title.length > 28 ? `${t.title.slice(0, 27)}…` : t.title;
          const state = t.pendingTool ? `${l.text}: approve ${t.pendingTool}` : l.text;
          return (
            <Text key={t.id}>
              <Text color={l.color}>{l.icon}</Text>{' '}
              {typeof t.url === 'string' ? <Link href={t.url}>{title}</Link> : title}{' '}
              <Text dimColor>({state} ↗) </Text>
            </Text>
          );
        })}
        {extra > 0 ? <Text dimColor>+{extra} more </Text> : null}
        <Button key="refresh" label="↻" onPress={() => poll($)} />
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    );
  });
};
