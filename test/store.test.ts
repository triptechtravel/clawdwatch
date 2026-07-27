import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { migrate, reset, check, countRows } from './helpers';
import {
  activeMaintenance,
  annotateIncident,
  deleteCheck,
  getCheck,
  getState,
  insertDeliveryStatement,
  insertResultStatement,
  latestDeliveries,
  listChecks,
  listIncidents,
  listResults,
  loadStates,
  openIncidentStatement,
  pruneDeliveries,
  pruneResults,
  resolveIncidentStatement,
  saveStateStatement,
  upsertCheck,
  windowFor,
} from '../src/engine/store/d1';
import { emptyState } from '../src/engine/transition';
import { LeakedSecretError } from '../src/engine/secrets';

const SECRETS = { HEALTHCHECK_SECRET: 'hc-super-secret-value' };

beforeAll(migrate);
beforeEach(reset);

describe('schema', () => {
  it('creates every table the code queries', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);

    for (const table of [
      'checks',
      'check_state',
      'check_results',
      'incidents',
      'maintenance_windows',
      'notifier_deliveries',
    ]) {
      expect(names).toContain(table);
    }
  });
});

describe('checks', () => {
  it('round-trips every field through real SQL', async () => {
    const original = check({
      id: 'round-trip',
      method: 'POST',
      headers: { 'X-Key': '${HEALTHCHECK_SECRET}', Accept: 'application/json' },
      body: '{"query":"{__typename}"}',
      assertions: [
        { type: 'statusCode', operator: 'is', value: 200 },
        { type: 'jsonPath', path: '$.data.ok', operator: 'is', value: 'true' },
      ],
      retryCount: 2,
      retryDelayMs: 1500,
      timeoutMs: 7500,
      failureThreshold: 4,
      reminderIntervalMs: 3_600_000,
      intervalMins: 15,
      tags: ['production', 'api'],
      enabled: false,
    });

    await upsertCheck(env.DB, original, SECRETS);
    const loaded = await getCheck(env.DB, 'round-trip');

    // JSON columns and the integer/boolean mapping are the parts most likely
    // to rot silently; compare the whole object rather than sampling.
    expect(loaded).toEqual(original);
  });

  it('updates in place on conflict rather than duplicating', async () => {
    await upsertCheck(env.DB, check({ id: 'x', name: 'Before' }), SECRETS);
    await upsertCheck(env.DB, check({ id: 'x', name: 'After', timeoutMs: 999 }), SECRETS);

    expect(await countRows('checks')).toBe(1);
    const loaded = await getCheck(env.DB, 'x');
    expect(loaded?.name).toBe('After');
    expect(loaded?.timeoutMs).toBe(999);
  });

  it('filters to enabled checks when asked', async () => {
    await upsertCheck(env.DB, check({ id: 'on', enabled: true }), SECRETS);
    await upsertCheck(env.DB, check({ id: 'off', enabled: false }), SECRETS);

    expect((await listChecks(env.DB)).length).toBe(2);
    const enabled = await listChecks(env.DB, true);
    expect(enabled.map((c) => c.id)).toEqual(['on']);
  });

  it('refuses to store a literal secret value', async () => {
    await expect(
      upsertCheck(env.DB, check({ headers: { k: 'hc-super-secret-value' } }), SECRETS),
    ).rejects.toThrow(LeakedSecretError);
    expect(await countRows('checks')).toBe(0);
  });

  it('deletes state and history alongside the check', async () => {
    await upsertCheck(env.DB, check({ id: 'doomed' }), SECRETS);
    await env.DB.batch([
      saveStateStatement(env.DB, { ...emptyState('doomed'), status: 'healthy' }),
      insertResultStatement(env.DB, {
        checkId: 'doomed',
        success: true,
        statusCode: 200,
        responseTimeMs: 10,
        error: null,
        ranAt: new Date().toISOString(),
      }),
    ]);

    await deleteCheck(env.DB, 'doomed');

    expect(await countRows('checks')).toBe(0);
    expect(await countRows('check_state')).toBe(0);
    expect(await countRows('check_results')).toBe(0);
  });

  it('returns null for an unknown check', async () => {
    expect(await getCheck(env.DB, 'nope')).toBeNull();
  });
});

describe('state', () => {
  it('upserts rather than accumulating rows', async () => {
    const state = { ...emptyState('c1'), status: 'degraded' as const, consecutiveFailures: 1 };
    await env.DB.batch([saveStateStatement(env.DB, state)]);
    await env.DB.batch([
      saveStateStatement(env.DB, { ...state, status: 'unhealthy', consecutiveFailures: 3 }),
    ]);

    expect(await countRows('check_state')).toBe(1);
    const loaded = await getState(env.DB, 'c1');
    expect(loaded.status).toBe('unhealthy');
    expect(loaded.consecutiveFailures).toBe(3);
  });

  it('preserves the reminder bookkeeping across a save', async () => {
    const at = new Date().toISOString();
    await env.DB.batch([
      saveStateStatement(env.DB, {
        ...emptyState('c1'),
        status: 'unhealthy',
        downSince: at,
        lastAlertAt: at,
        incidentId: 'inc-1',
      }),
    ]);

    const loaded = await getState(env.DB, 'c1');
    expect(loaded.downSince).toBe(at);
    expect(loaded.lastAlertAt).toBe(at);
    expect(loaded.incidentId).toBe('inc-1');
  });

  it('returns an empty state for a check that has never run', async () => {
    expect(await getState(env.DB, 'never')).toEqual(emptyState('never'));
  });

  it('loads all states into a map', async () => {
    await env.DB.batch([
      saveStateStatement(env.DB, { ...emptyState('a'), status: 'healthy' }),
      saveStateStatement(env.DB, { ...emptyState('b'), status: 'unhealthy' }),
    ]);
    const states = await loadStates(env.DB);
    expect(states.get('a')?.status).toBe('healthy');
    expect(states.get('b')?.status).toBe('unhealthy');
  });
});

describe('results', () => {
  async function seed(checkId: string, count: number, offsetMs = 0) {
    const statements = Array.from({ length: count }, (_, i) =>
      insertResultStatement(env.DB, {
        checkId,
        success: i % 5 !== 0,
        statusCode: i % 5 === 0 ? 503 : 200,
        responseTimeMs: 100 + i,
        error: i % 5 === 0 ? 'Expected status 200, got 503' : null,
        ranAt: new Date(Date.now() - offsetMs - (count - i) * 60_000).toISOString(),
      }),
    );
    await env.DB.batch(statements);
  }

  it('returns history oldest-first for the tick strip', async () => {
    await seed('c1', 10);
    const results = await listResults(env.DB, 'c1');
    expect(results).toHaveLength(10);

    const times = results.map((r) => Date.parse(r.ranAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('honours the limit while still returning the most recent window', async () => {
    await seed('c1', 50);
    const results = await listResults(env.DB, 'c1', 10);
    expect(results).toHaveLength(10);
    // Newest row must be present even though we asked for a small window.
    const newest = Math.max(...results.map((r) => Date.parse(r.ranAt)));
    const all = await listResults(env.DB, 'c1', 100);
    expect(newest).toBe(Math.max(...all.map((r) => Date.parse(r.ranAt))));
  });

  it('keeps checks separate', async () => {
    await seed('a', 3);
    await seed('b', 5);
    expect(await listResults(env.DB, 'a')).toHaveLength(3);
    expect(await listResults(env.DB, 'b')).toHaveLength(5);
  });

  it('prunes past the retention window and keeps what is inside it', async () => {
    await seed('c1', 3);
    await seed('c1', 3, 72 * 3_600_000);
    expect(await countRows('check_results')).toBe(6);

    await pruneResults(env.DB, 48);
    expect(await countRows('check_results')).toBe(3);
  });
});

describe('incidents', () => {
  const startedAt = new Date(Date.now() - 600_000).toISOString();

  it('opens, resolves, and records duration', async () => {
    await env.DB.batch([
      openIncidentStatement(env.DB, {
        id: 'inc-1',
        checkId: 'c1',
        startedAt,
        triggerError: 'Expected status 200, got 502',
      }),
    ]);

    let open = await listIncidents(env.DB, { open: true });
    expect(open).toHaveLength(1);
    expect(open[0].triggerError).toContain('502');

    await env.DB.batch([
      resolveIncidentStatement(env.DB, 'inc-1', new Date().toISOString(), 600_000),
    ]);

    open = await listIncidents(env.DB, { open: true });
    expect(open).toHaveLength(0);

    const resolved = await listIncidents(env.DB, { open: false });
    expect(resolved[0].durationMs).toBe(600_000);
  });

  it('does not reopen or overwrite an already-resolved incident', async () => {
    await env.DB.batch([
      openIncidentStatement(env.DB, { id: 'inc-1', checkId: 'c1', startedAt, triggerError: null }),
    ]);
    await env.DB.batch([resolveIncidentStatement(env.DB, 'inc-1', startedAt, 111)]);
    await env.DB.batch([resolveIncidentStatement(env.DB, 'inc-1', startedAt, 999)]);

    const [incident] = await listIncidents(env.DB, {});
    expect(incident.durationMs).toBe(111);
  });

  it('ignores a duplicate open for the same id', async () => {
    const statement = openIncidentStatement(env.DB, {
      id: 'inc-1',
      checkId: 'c1',
      startedAt,
      triggerError: null,
    });
    await env.DB.batch([statement]);
    await env.DB.batch([
      openIncidentStatement(env.DB, {
        id: 'inc-1',
        checkId: 'c1',
        startedAt,
        triggerError: 'different',
      }),
    ]);
    expect(await countRows('incidents')).toBe(1);
  });

  it('stores an agent annotation', async () => {
    await env.DB.batch([
      openIncidentStatement(env.DB, { id: 'inc-1', checkId: 'c1', startedAt, triggerError: null }),
    ]);
    await annotateIncident(env.DB, 'inc-1', 'Deploy 4f21c9 correlates with the failure window.');

    const [incident] = await listIncidents(env.DB, {});
    expect(incident.annotation).toContain('4f21c9');
  });

  it('filters by check', async () => {
    await env.DB.batch([
      openIncidentStatement(env.DB, { id: 'a1', checkId: 'a', startedAt, triggerError: null }),
      openIncidentStatement(env.DB, { id: 'b1', checkId: 'b', startedAt, triggerError: null }),
    ]);
    const forA = await listIncidents(env.DB, { checkId: 'a' });
    expect(forA.map((i) => i.id)).toEqual(['a1']);
  });
});

describe('maintenance windows', () => {
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset).toISOString();

  it('returns only windows in effect right now', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO maintenance_windows (id, check_id, tag, starts_at, ends_at, reason, suppress_alerts, skip_checks)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('now', null, null, iso(-3600_000), iso(3600_000), 'deploy', 1, 0),
      env.DB.prepare(
        `INSERT INTO maintenance_windows (id, check_id, tag, starts_at, ends_at, reason, suppress_alerts, skip_checks)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('past', null, null, iso(-7200_000), iso(-3600_000), 'old', 1, 0),
    ]);

    const active = await activeMaintenance(env.DB, new Date(now).toISOString());
    expect(active.map((w) => w.id)).toEqual(['now']);
    expect(active[0].suppressAlerts).toBe(true);
    expect(active[0].skipChecks).toBe(false);
  });

  it('matches a window by check id, by tag, or globally', async () => {
    const base = {
      startsAt: iso(-1000),
      endsAt: iso(1000),
      reason: null,
      suppressAlerts: true,
      skipChecks: false,
    };
    const byId = { id: 'w1', checkId: 'c1', tag: null, ...base };
    const byTag = { id: 'w2', checkId: null, tag: 'api', ...base };
    const global = { id: 'w3', checkId: null, tag: null, ...base };

    expect(windowFor([byId], check({ id: 'c1' }))?.id).toBe('w1');
    expect(windowFor([byTag], check({ id: 'other', tags: ['api'] }))?.id).toBe('w2');
    expect(windowFor([global], check({ id: 'anything' }))?.id).toBe('w3');
    expect(windowFor([byId], check({ id: 'other' }))).toBeNull();
    expect(windowFor([byTag], check({ id: 'other', tags: ['web'] }))).toBeNull();
  });
});

describe('notifier deliveries', () => {
  async function record(notifier: string, ok: boolean, at: string, attempts = 1) {
    await env.DB.batch([
      insertDeliveryStatement(env.DB, {
        notifier,
        eventKind: 'opened',
        ok,
        error: ok ? null : 'Webhook returned 502',
        attempts,
        deliveredAt: at,
      }),
    ]);
  }

  it('returns only the most recent delivery per notifier', async () => {
    const older = new Date(Date.now() - 3600_000).toISOString();
    const newer = new Date().toISOString();

    await record('slack', false, older);
    await record('slack', true, newer);
    await record('webhook', false, newer, 2);

    // Exercises the GROUP BY / MAX(id) join, which a fake cannot verify.
    const latest = await latestDeliveries(env.DB);
    expect(latest).toHaveLength(2);

    const slack = latest.find((d) => d.notifier === 'slack')!;
    expect(slack.ok).toBe(true);
    expect(slack.deliveredAt).toBe(newer);

    const webhook = latest.find((d) => d.notifier === 'webhook')!;
    expect(webhook.ok).toBe(false);
    expect(webhook.attempts).toBe(2);
    expect(webhook.error).toContain('502');
  });

  it('is empty before anything is delivered', async () => {
    expect(await latestDeliveries(env.DB)).toEqual([]);
  });

  it('prunes old delivery rows', async () => {
    await record('slack', true, new Date(Date.now() - 72 * 3600_000).toISOString());
    await record('slack', true, new Date().toISOString());
    expect(await countRows('notifier_deliveries')).toBe(2);

    await pruneDeliveries(env.DB, 48);
    expect(await countRows('notifier_deliveries')).toBe(1);
  });
});
