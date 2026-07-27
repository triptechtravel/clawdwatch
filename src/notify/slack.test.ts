import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { slack, buildPayload, formatDuration } from './slack';
import type { AlertEvent, CheckSummary, NotifierContext } from '../types';

const ctx: NotifierContext<unknown> = { env: {}, resolve: (t) => t };
const AT = '2026-07-27T00:00:00.000Z';

function summary(name = 'Marketing Site'): CheckSummary {
  return { id: 'home', name, url: 'https://example.com/en', tags: ['core'], status: 'unhealthy' };
}

function opened(): AlertEvent {
  return {
    kind: 'opened',
    at: AT,
    check: summary(),
    failure: {
      statusCode: 502,
      responseTimeMs: 310,
      assertions: ['Expected status 200, got 502'],
      consecutiveFailures: 3,
    },
    incidentId: 'inc-1',
    links: {},
  };
}

describe('formatDuration', () => {
  it.each([
    [12_000, '12s'],
    [45 * 60_000, '45m'],
    [2 * 3600_000, '2h'],
    [(2 * 60 + 10) * 60_000, '2h 10m'],
    [24 * 3600_000, '1d'],
    [(24 + 3) * 3600_000, '1d 3h'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('clamps a negative duration to zero', () => {
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('buildPayload', () => {
  it('builds an incident message for opened', () => {
    const payload = buildPayload(opened())!;
    expect(payload.attachments[0].color).toBe('#E01E5A');
    const text = JSON.stringify(payload);
    expect(text).toContain('Incident');
    expect(text).toContain('Marketing Site');
    expect(text).toContain('Expected status 200, got 502');
    expect(text).toContain('3 consecutive failures');
  });

  it('shows "unreachable" when there is no status code', () => {
    const event = opened();
    if (event.kind === 'opened') event.failure.statusCode = null;
    expect(JSON.stringify(buildPayload(event))).toContain('unreachable');
  });

  it('builds a recovery message with downtime', () => {
    const event: AlertEvent = {
      kind: 'recovered',
      at: AT,
      check: { ...summary(), status: 'healthy' },
      downtimeMs: 90 * 60_000,
      incidentId: 'inc-1',
      links: {},
    };
    const payload = buildPayload(event)!;
    expect(payload.attachments[0].color).toBe('#2EB67D');
    expect(JSON.stringify(payload)).toContain('1h 30m');
  });

  it('builds a reminder message', () => {
    const event: AlertEvent = {
      kind: 'reminder',
      at: AT,
      check: summary(),
      failure: {
        statusCode: 502,
        responseTimeMs: 5,
        assertions: ['boom'],
        consecutiveFailures: 12,
      },
      downSinceMs: 3 * 3600_000,
      incidentId: 'inc-1',
      links: {},
    };
    const payload = buildPayload(event)!;
    expect(payload.attachments[0].color).toBe('#ECB22E');
    expect(JSON.stringify(payload)).toContain('Still down');
    expect(JSON.stringify(payload)).toContain('3h');
  });

  it('builds all-clear from a summary', () => {
    const event: AlertEvent = {
      kind: 'summary',
      at: AT,
      opened: [],
      recovered: [{ ...summary(), status: 'healthy' }],
      stillDown: [],
      allClear: true,
      totalChecks: 10,
      links: {},
    };
    expect(JSON.stringify(buildPayload(event))).toContain('All Clear');
    expect(JSON.stringify(buildPayload(event))).toContain('All 10 monitored endpoints');
  });

  it('sends nothing for a summary that is not all-clear', () => {
    const event: AlertEvent = {
      kind: 'summary',
      at: AT,
      opened: [summary()],
      recovered: [],
      stillDown: [],
      allClear: false,
      totalChecks: 10,
      links: {},
    };
    // The per-check `opened` message already carried the detail — a second
    // message repeating it would be noise.
    expect(buildPayload(event)).toBeNull();
  });

  it('uses singular wording for one endpoint', () => {
    expect(JSON.stringify(buildPayload(opened()))).toContain('1 endpoint down');
  });
});

describe('slack notifier', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the payload as JSON', async () => {
    await slack({ webhook: 'https://hooks.slack.test/abc' }).notify(opened(), ctx);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.test/abc');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body).attachments).toBeDefined();
  });

  it('resolves a secret reference in the webhook URL', async () => {
    const resolving: NotifierContext<unknown> = {
      env: {},
      resolve: (t) => t.replace('${SLACK_WEBHOOK_URL}', 'https://hooks.slack.test/real'),
    };
    await slack({ webhook: '${SLACK_WEBHOOK_URL}' }).notify(opened(), resolving);
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.slack.test/real');
  });

  it('throws on a non-2xx response so a dead webhook is visible', async () => {
    fetchMock.mockResolvedValue(new Response('no such hook', { status: 404 }));
    await expect(
      slack({ webhook: 'https://hooks.slack.test/gone' }).notify(opened(), ctx),
    ).rejects.toThrow('404');
  });

  it('sends nothing when the event maps to no message', async () => {
    const event: AlertEvent = {
      kind: 'summary',
      at: AT,
      opened: [summary()],
      recovered: [],
      stillDown: [],
      allClear: false,
      totalChecks: 3,
      links: {},
    };
    await slack({ webhook: 'https://hooks.slack.test/abc' }).notify(event, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can be named and filtered for multi-channel routing', () => {
    const n = slack({ webhook: 'x', name: 'slack:status-page', on: ['summary'] });
    expect(n.name).toBe('slack:status-page');
    expect(n.on).toEqual(['summary']);
  });
});
