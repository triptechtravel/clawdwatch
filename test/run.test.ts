import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { migrate, reset, check, countRows, rewindLastCheck } from './helpers';
import { createMonitor } from '../src/index';
import { upsertCheck } from '../src/engine/store/d1';
import type { AlertEvent, Notifier } from '../src/types';

/**
 * The full cron path against a real D1: run → assert → transition → persist →
 * batch events → dispatch → record deliveries.
 *
 * This is what the unit suites cannot prove. Every previous generation of this
 * system had a break somewhere in this chain that no test covered.
 */

interface Env {
  DB: D1Database;
}

const SECRETS = { HEALTHCHECK_SECRET: 'hc-super-secret-value' };

/** Collects everything a notifier is handed, for assertions. */
function recorder(): Notifier<Env> & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    name: 'recorder',
    events,
    async notify(event) {
      events.push(event);
    },
  };
}

function monitorWith(notifiers: Notifier<Env>[]) {
  return createMonitor<Env>({
    d1: (e) => e.DB,
    secrets: () => SECRETS,
    baseUrl: () => 'https://mon.example.com',
    notifiers,
    defaults: { userAgent: 'clawdwatch-test' },
  });
}

/**
 * Outbound fetch is stubbed rather than network-mocked: the pool no longer
 * ships fetchMock, and stubbing lets each test assert exactly what the runner
 * sent (headers included), which is what the secret tests need.
 */
let fetchCalls: Array<[string, RequestInit]> = [];
let fetchStub: ReturnType<typeof vi.fn>;

beforeAll(migrate);

beforeEach(async () => {
  await reset();
  fetchCalls = [];
  fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push([String(url), init]);
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every subsequent outbound request answers with this status. */
function mockHealth(status: number) {
  fetchStub.mockImplementation(async (url: string, init: RequestInit) => {
    fetchCalls.push([String(url), init]);
    return new Response(status === 200 ? 'ok' : 'bad gateway', { status });
  });
}

describe('a healthy run', () => {
  it('records a result and state, and stays silent', async () => {
    await upsertCheck(env.DB, check({ id: 'c1' }), SECRETS);
    const notifier = recorder();
    mockHealth(200);

    const report = await monitorWith([notifier]).runChecks(env);

    expect(report.ran).toBe(1);
    expect(report.events).toEqual([]);
    expect(notifier.events).toEqual([]);

    expect(await countRows('check_results')).toBe(1);
    const state = await env.DB.prepare('SELECT * FROM check_state WHERE check_id = ?')
      .bind('c1')
      .first<{ status: string; consecutive_failures: number }>();
    expect(state?.status).toBe('healthy');
    expect(state?.consecutive_failures).toBe(0);
  });

  it('skips a disabled check entirely', async () => {
    await upsertCheck(env.DB, check({ id: 'off', enabled: false }), SECRETS);
    const report = await monitorWith([]).runChecks(env);
    expect(report.ran).toBe(0);
    expect(await countRows('check_results')).toBe(0);
  });
});

describe('opening an incident', () => {
  it('degrades silently, then opens on the threshold with an incident row', async () => {
    await upsertCheck(env.DB, check({ id: 'c1', failureThreshold: 2 }), SECRETS);
    const notifier = recorder();
    const monitor = monitorWith([notifier]);

    mockHealth(502);
    const first = await monitor.runChecks(env);
    expect(first.events).toEqual([]);

    await rewindLastCheck('c1', 10);
    mockHealth(502);
    const second = await monitor.runChecks(env);

    const opened = second.events.find((e) => e.kind === 'opened');
    expect(opened).toBeDefined();
    expect(opened?.kind === 'opened' && opened.failure.assertions[0]).toContain('502');

    // The incident is persisted and open.
    const incidents = await env.DB.prepare(
      'SELECT * FROM incidents WHERE resolved_at IS NULL',
    ).all<{ check_id: string; trigger_error: string }>();
    expect(incidents.results).toHaveLength(1);
    expect(incidents.results[0].check_id).toBe('c1');

    // And a summary accompanies it, so a multi-check outage is one message.
    expect(second.events.some((e) => e.kind === 'summary')).toBe(true);
  });

  it('carries working capability links an agent can act on', async () => {
    await upsertCheck(env.DB, check({ id: 'c1', failureThreshold: 1 }), SECRETS);
    const notifier = recorder();
    mockHealth(502);

    await monitorWith([notifier]).runChecks(env);

    const opened = notifier.events.find((e) => e.kind === 'opened');
    expect(opened?.kind === 'opened' && opened.links.ack).toMatch(
      /^https:\/\/mon\.example\.com\/api\/incidents\/.+\/ack$/,
    );
    expect(opened?.kind === 'opened' && opened.links.capabilities).toBe(
      'https://mon.example.com/api/agent.md',
    );
  });
});

describe('recovering', () => {
  it('resolves the incident and reports downtime', async () => {
    await upsertCheck(env.DB, check({ id: 'c1', failureThreshold: 1 }), SECRETS);
    const notifier = recorder();
    const monitor = monitorWith([notifier]);

    mockHealth(502);
    await monitor.runChecks(env);

    await rewindLastCheck('c1', 10);
    mockHealth(200);
    const recovery = await monitor.runChecks(env);

    const recovered = recovery.events.find((e) => e.kind === 'recovered');
    expect(recovered).toBeDefined();

    const open = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL',
    ).first<{ n: number }>();
    expect(open?.n).toBe(0);

    const summary = recovery.events.find((e) => e.kind === 'summary');
    expect(summary?.kind === 'summary' && summary.allClear).toBe(true);
  });
});

describe('secrets', () => {
  it('sends the resolved header but never stores or emits the value', async () => {
    await upsertCheck(
      env.DB,
      check({ id: 'c1', headers: { 'X-Healthcheck-Secret': '${HEALTHCHECK_SECRET}' } }),
      SECRETS,
    );

    mockHealth(200);
    const notifier = recorder();
    const report = await monitorWith([notifier]).runChecks(env);
    expect(report.ran).toBe(1);

    // The stored row keeps the reference, not the value.
    const row = await env.DB.prepare('SELECT headers FROM checks WHERE id = ?')
      .bind('c1')
      .first<{ headers: string }>();
    expect(row?.headers).toContain('${HEALTHCHECK_SECRET}');
    expect(row?.headers).not.toContain('hc-super-secret-value');

    // Nothing in the report carries the value either.
    expect(JSON.stringify(report)).not.toContain('hc-super-secret-value');

    // But the outbound request did carry the resolved value.
    const [, init] = fetchCalls[0];
    expect((init.headers as Record<string, string>)['X-Healthcheck-Secret']).toBe(
      'hc-super-secret-value',
    );
  });

  it('turns an unresolvable reference into a check failure, not a crash', async () => {
    await upsertCheck(env.DB, check({ id: 'c1', headers: { k: '${MISSING}' } }), SECRETS);

    const report = await monitorWith([]).runChecks(env);

    expect(report.ran).toBe(1);
    const result = await env.DB.prepare('SELECT error FROM check_results LIMIT 1').first<{
      error: string;
    }>();
    expect(result?.error).toContain('MISSING');
  });
});

describe('notifier delivery is recorded', () => {
  it('persists a successful delivery', async () => {
    await upsertCheck(env.DB, check({ id: 'c1', failureThreshold: 1 }), SECRETS);
    mockHealth(502);

    await monitorWith([recorder()]).runChecks(env);

    const rows = await env.DB.prepare('SELECT * FROM notifier_deliveries').all<{
      notifier: string;
      ok: number;
    }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(rows.results.every((r) => r.ok === 1)).toBe(true);
  });

  it('records a failure without stopping the run or the other notifiers', async () => {
    await upsertCheck(env.DB, check({ id: 'c1', failureThreshold: 1 }), SECRETS);
    mockHealth(502);

    const good = recorder();
    const bad: Notifier<Env> = {
      name: 'bad',
      async notify() {
        throw new Error('inbox unreachable');
      },
    };

    const report = await monitorWith([bad, good]).runChecks(env);

    // The run completed and the healthy notifier still received its events.
    expect(report.ran).toBe(1);
    expect(good.events.length).toBeGreaterThan(0);

    const failed = await env.DB.prepare(
      "SELECT * FROM notifier_deliveries WHERE notifier = 'bad'",
    ).all<{ ok: number; error: string; attempts: number }>();
    expect(failed.results[0].ok).toBe(0);
    expect(failed.results[0].error).toContain('inbox unreachable');
    expect(failed.results[0].attempts).toBeGreaterThan(1);
  });
});

describe('scheduling', () => {
  it('does not re-run a check inside its interval', async () => {
    await upsertCheck(env.DB, check({ id: 'c1', intervalMins: 60 }), SECRETS);
    const monitor = monitorWith([]);

    mockHealth(200);
    expect((await monitor.runChecks(env)).ran).toBe(1);

    const callsAfterFirst = fetchCalls.length;
    const second = await monitor.runChecks(env);
    expect(second.ran).toBe(0);
    expect(second.skipped).toBe(1);
    // Nothing was fetched the second time round.
    expect(fetchCalls.length).toBe(callsAfterFirst);
  });
});
