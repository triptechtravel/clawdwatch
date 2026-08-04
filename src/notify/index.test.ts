import { describe, it, expect, vi } from 'vitest';
import { dispatch } from './index';
import type { AlertEvent, Notifier, NotifierContext } from '../types';
import { ALERT_SCHEMA_VERSION } from '../types';

const ctx: NotifierContext<unknown> = { env: {}, resolve: (t) => t };

function opened(id = 'c1'): AlertEvent {
  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    kind: 'opened',
    at: '2026-07-27T00:00:00.000Z',
    check: { id, name: id, url: 'https://x.test', tags: [], status: 'unhealthy' },
    failure: { statusCode: 502, responseTimeMs: 12, assertions: ['boom'], consecutiveFailures: 3 },
    incidentId: 'inc-1',
    links: {},
  };
}

function recovered(id = 'c1'): AlertEvent {
  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    kind: 'recovered',
    at: '2026-07-27T00:05:00.000Z',
    check: { id, name: id, url: 'https://x.test', tags: [], status: 'healthy' },
    downtimeMs: 300_000,
    incidentId: 'inc-1',
    links: {},
  };
}

function spyNotifier(name: string, on?: AlertEvent['kind'][]): Notifier<unknown> & {
  seen: AlertEvent[];
} {
  const seen: AlertEvent[] = [];
  return {
    name,
    on,
    seen,
    async notify(event) {
      seen.push(event);
    },
  };
}

describe('dispatch', () => {
  it('delivers each event to each notifier', async () => {
    const a = spyNotifier('a');
    const b = spyNotifier('b');
    await dispatch([opened(), recovered()], [a, b], ctx);
    expect(a.seen.map((e) => e.kind)).toEqual(['opened', 'recovered']);
    expect(b.seen.map((e) => e.kind)).toEqual(['opened', 'recovered']);
  });

  it('respects the kind filter', async () => {
    const only = spyNotifier('only-recovered', ['recovered']);
    await dispatch([opened(), recovered()], [only], ctx);
    expect(only.seen.map((e) => e.kind)).toEqual(['recovered']);
  });

  it('preserves event order per notifier so summary never precedes opened', async () => {
    const seen: string[] = [];
    const slow: Notifier<unknown> = {
      name: 'slow',
      async notify(event) {
        await new Promise((r) => setTimeout(r, event.kind === 'opened' ? 20 : 0));
        seen.push(event.kind);
      },
    };
    await dispatch([opened(), recovered()], [slow], ctx);
    expect(seen).toEqual(['opened', 'recovered']);
  });

  it('does nothing when there are no events or no notifiers', async () => {
    expect(await dispatch([], [spyNotifier('a')], ctx)).toEqual([]);
    expect(await dispatch([opened()], [], ctx)).toEqual([]);
  });

  it('reports a successful delivery', async () => {
    const reports = await dispatch([opened()], [spyNotifier('a')], ctx);
    expect(reports).toEqual([{ notifier: 'a', kind: 'opened', ok: true, attempts: 1 }]);
  });
});

describe('isolation', () => {
  it('one throwing notifier does not stop the others', async () => {
    const good = spyNotifier('good');
    const bad: Notifier<unknown> = {
      name: 'bad',
      async notify() {
        throw new Error('inbox unreachable');
      },
    };
    const reports = await dispatch([opened()], [bad, good], ctx, { retries: 0 });

    expect(good.seen).toHaveLength(1);
    expect(reports.find((r) => r.notifier === 'bad')).toMatchObject({
      ok: false,
      error: 'inbox unreachable',
    });
  });

  it('never rejects, whatever a notifier does', async () => {
    const nasty: Notifier<unknown> = {
      name: 'nasty',
      async notify() {
        throw 'a string, not an Error';
      },
    };
    await expect(dispatch([opened()], [nasty], ctx, { retries: 0 })).resolves.toBeDefined();
  });

  it('keeps delivering later events after an earlier one fails', async () => {
    let calls = 0;
    const flaky: Notifier<unknown> = {
      name: 'flaky',
      async notify() {
        calls++;
        if (calls === 1) throw new Error('first fails');
      },
    };
    const reports = await dispatch([opened(), recovered()], [flaky], ctx, { retries: 0 });
    expect(reports.map((r) => r.ok)).toEqual([false, true]);
  });
});

describe('retries', () => {
  it('retries once by default and succeeds', async () => {
    let calls = 0;
    const flaky: Notifier<unknown> = {
      name: 'flaky',
      async notify() {
        calls++;
        if (calls === 1) throw new Error('transient');
      },
    };
    const reports = await dispatch([opened()], [flaky], ctx, { retryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(reports[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  it('gives up after the configured retries', async () => {
    const always: Notifier<unknown> = {
      name: 'always',
      async notify() {
        throw new Error('down');
      },
    };
    const reports = await dispatch([opened()], [always], ctx, { retries: 2, retryDelayMs: 0 });
    expect(reports[0]).toMatchObject({ ok: false, attempts: 3 });
  });

  it('surfaces failures through onReport for the notifier status panel', async () => {
    const onReport = vi.fn();
    const bad: Notifier<unknown> = {
      name: 'bad',
      async notify() {
        throw new Error('nope');
      },
    };
    await dispatch([opened()], [bad], ctx, { retries: 0, onReport });
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({ notifier: 'bad', ok: false, error: 'nope' }),
    );
  });
});

describe('context', () => {
  it('passes env and a resolver through to the notifier', async () => {
    let got: { url?: string; env?: unknown } = {};
    const n: Notifier<{ tag: string }> = {
      name: 'n',
      async notify(_event, c) {
        got = { url: c.resolve('https://hooks.test/${TOKEN}'), env: c.env };
      },
    };
    await dispatch([opened()], [n], {
      env: { tag: 'prod' },
      resolve: (t) => t.replace('${TOKEN}', 'abc123'),
    });
    expect(got.url).toBe('https://hooks.test/abc123');
    expect(got.env).toEqual({ tag: 'prod' });
  });
});
