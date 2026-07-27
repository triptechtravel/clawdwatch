import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMonitor } from './index';
import type { Notifier } from './types';

/**
 * A D1 stub good enough to exercise createMonitor's wiring. Real SQL behaviour
 * is covered by the miniflare integration suite; this asserts the notifier
 * defaulting, which is a pure configuration decision.
 */
function fakeD1(): D1Database {
  const empty = { results: [] };
  const stmt: Record<string, unknown> = {};
  stmt.bind = () => stmt;
  stmt.all = async () => empty;
  stmt.first = async () => null;
  stmt.run = async () => ({ success: true });
  return {
    prepare: () => stmt,
    batch: async () => [],
  } as unknown as D1Database;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMonitor notifier defaulting', () => {
  it('runs with no notifiers configured and no Slack secret', async () => {
    const monitor = createMonitor<{ DB: D1Database }>({ d1: (env) => env.DB });
    const report = await monitor.runChecks({ DB: fakeD1() });
    expect(report.deliveries).toEqual([]);
    expect(report.ran).toBe(0);
  });

  it('defaults to Slack when SLACK_WEBHOOK_URL is present', async () => {
    const monitor = createMonitor<{ DB: D1Database }>({
      d1: (env) => env.DB,
      secrets: () => ({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/abc' }),
    });
    // No checks exist, so no events fire — but the notifier must be wired,
    // which is what the healthcheck-parity promise rests on.
    const report = await monitor.runChecks({ DB: fakeD1() });
    expect(report.deliveries).toEqual([]);
  });

  it('explicit notifiers win over the Slack default', async () => {
    const seen: string[] = [];
    const custom: Notifier<{ DB: D1Database }> = {
      name: 'custom',
      async notify(event) {
        seen.push(event.kind);
      },
    };
    const monitor = createMonitor<{ DB: D1Database }>({
      d1: (env) => env.DB,
      secrets: () => ({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/abc' }),
      notifiers: [custom],
    });
    await monitor.runChecks({ DB: fakeD1() });
    // Slack must not have been contacted — the explicit list replaced it.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
