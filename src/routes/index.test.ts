import { describe, it, expect } from 'vitest';
import { createRoutes, normaliseCheck } from './index';
import { ROUTES, buildAgentDoc } from './agent-md';
import { mintCapability } from '../auth';
import type { CheckConfig, ClawdWatchOptions } from '../types';

/**
 * An in-memory stand-in for D1: enough SQL awareness to exercise the routes.
 * Real SQL is covered by the miniflare integration suite.
 */
function fakeDb(seed: CheckConfig[] = []) {
  const checks = new Map<string, CheckConfig>(seed.map((c) => [c.id, c]));
  const annotations = new Map<string, string>();

  const stmt = (sql: string, binds: unknown[] = []): D1PreparedStatement =>
    ({
      bind: (...b: unknown[]) => stmt(sql, b),
      async first() {
        if (sql.includes('FROM checks WHERE id')) {
          const found = checks.get(String(binds[0]));
          return found ? toRow(found) : null;
        }
        return null;
      },
      async all() {
        if (sql.includes('FROM checks')) {
          return { results: [...checks.values()].map(toRow) };
        }
        return { results: [] };
      },
      async run() {
        if (sql.startsWith('INSERT INTO checks')) {
          const c = fromBinds(binds);
          checks.set(c.id, c);
        }
        if (sql.startsWith('UPDATE incidents SET annotation')) {
          annotations.set(String(binds[1]), String(binds[0]));
        }
        return { success: true };
      },
    }) as unknown as D1PreparedStatement;

  return {
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async () => [],
    } as unknown as D1Database,
    checks,
    annotations,
  };
}

function toRow(c: CheckConfig) {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    method: c.method,
    headers: JSON.stringify(c.headers),
    body: c.body,
    assertions: JSON.stringify(c.assertions),
    retry_count: c.retryCount,
    retry_delay_ms: c.retryDelayMs,
    timeout_ms: c.timeoutMs,
    failure_threshold: c.failureThreshold,
    reminder_interval_ms: c.reminderIntervalMs,
    interval_mins: c.intervalMins,
    tags: JSON.stringify(c.tags),
    enabled: c.enabled ? 1 : 0,
  };
}

function fromBinds(b: unknown[]): CheckConfig {
  return {
    id: String(b[0]),
    name: String(b[1]),
    url: String(b[2]),
    method: String(b[3]),
    headers: JSON.parse(String(b[4])),
    body: b[5] as string | null,
    assertions: JSON.parse(String(b[6])),
    retryCount: Number(b[7]),
    retryDelayMs: Number(b[8]),
    timeoutMs: Number(b[9]),
    failureThreshold: Number(b[10]),
    reminderIntervalMs: b[11] as number | null,
    intervalMins: Number(b[12]),
    tags: JSON.parse(String(b[13])),
    enabled: b[14] === 1,
  };
}

function check(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    id: 'c1',
    name: 'Check',
    url: 'https://api.example.com/health',
    method: 'GET',
    headers: {},
    body: null,
    assertions: [],
    retryCount: 1,
    retryDelayMs: 0,
    timeoutMs: 5000,
    failureThreshold: 3,
    reminderIntervalMs: null,
    intervalMins: 5,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

const SECRETS = { HEALTHCHECK_SECRET: 'hc-super-secret-value' };

interface Env {
  DB: D1Database;
}

function app(
  dbHandle: D1Database,
  authOverrides: Parameters<typeof createRoutes>[0]['auth'] = {},
) {
  const options: ClawdWatchOptions<Env> = {
    d1: (env) => env.DB,
    secrets: () => SECRETS,
    baseUrl: () => 'https://mon.example.com',
  };
  return createRoutes<Env>({ options, auth: authOverrides });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://mon.example.com${path}`, init);
}

describe('normaliseCheck', () => {
  it('fills defaults for a new check', () => {
    const c = normaliseCheck({ id: 'x', name: 'X', url: 'https://x.test' });
    expect(c.method).toBe('GET');
    expect(c.failureThreshold).toBe(3);
    expect(c.enabled).toBe(true);
  });

  it('merges a partial update onto the existing check', () => {
    const existing = check({ timeoutMs: 9999, name: 'Original' });
    const c = normaliseCheck({ timeoutMs: 1000 }, existing);
    expect(c.timeoutMs).toBe(1000);
    expect(c.name).toBe('Original');
  });
});

describe('reads', () => {
  it('reports overall status', async () => {
    const { db } = fakeDb([check(), check({ id: 'c2', name: 'Two' })]);
    const res = await app(db).fetch(req('/api/status'), { DB: db });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.checks).toHaveLength(2);
    expect(body.overall).toBe('healthy');
  });

  it('redacts secrets when listing checks', async () => {
    const { db } = fakeDb([check({ headers: { 'X-Key': 'hc-super-secret-value' } })]);
    const res = await app(db).fetch(req('/api/checks'), { DB: db });
    const text = await res.text();
    expect(text).not.toContain('hc-super-secret-value');
    expect(text).toContain('${HEALTHCHECK_SECRET}');
  });

  it('404s an unknown check', async () => {
    const { db } = fakeDb();
    const res = await app(db).fetch(req('/api/checks/nope'), { DB: db });
    expect(res.status).toBe(404);
  });

  it('exports config with references intact', async () => {
    const { db } = fakeDb([check({ headers: { 'X-Key': '${HEALTHCHECK_SECRET}' } })]);
    const res = await app(db).fetch(req('/api/config'), { DB: db });
    const body = await res.json();
    expect(body.version).toBe(3);
    expect(body.checks[0].headers['X-Key']).toBe('${HEALTHCHECK_SECRET}');
  });
});

describe('authz matrix', () => {
  const write = { method: 'POST', body: JSON.stringify(check({ id: 'new' })) };

  it('rejects a write with no credentials', async () => {
    const { db } = fakeDb();
    const res = await app(db, { teamDomain: 't', aud: 'a' }).fetch(req('/api/checks', write), {
      DB: db,
    });
    expect(res.status).toBe(401);
  });

  it('rejects a write when Access is not configured', async () => {
    const { db } = fakeDb();
    const res = await app(db, {}).fetch(req('/api/checks', write), { DB: db });
    expect(res.status).toBe(403);
  });

  it('allows a write in dev mode', async () => {
    const { db, checks } = fakeDb();
    const res = await app(db, { devMode: true }).fetch(req('/api/checks', write), { DB: db });
    expect(res.status).toBe(201);
    expect(checks.has('new')).toBe(true);
  });

  it('leaves reads open', async () => {
    const { db } = fakeDb([check()]);
    const res = await app(db, { teamDomain: 't', aud: 'a' }).fetch(req('/api/status'), { DB: db });
    expect(res.status).toBe(200);
  });

  it('accepts a valid capability link for its own scope', async () => {
    const { db, annotations } = fakeDb();
    const cap = await mintCapability('cap-secret', 'annotate:inc-1', Date.now() + 60_000);
    const res = await app(db, { capabilitySecret: 'cap-secret' }).fetch(
      req(`/api/incidents/inc-1/annotate?cap=${cap}`, {
        method: 'POST',
        body: JSON.stringify({ annotation: 'deploy correlation' }),
      }),
      { DB: db },
    );
    expect(res.status).toBe(200);
    expect(annotations.get('inc-1')).toBe('deploy correlation');
  });

  it('refuses a capability link minted for a different incident', async () => {
    const { db } = fakeDb();
    const cap = await mintCapability('cap-secret', 'annotate:inc-OTHER', Date.now() + 60_000);
    const res = await app(db, { capabilitySecret: 'cap-secret' }).fetch(
      req(`/api/incidents/inc-1/annotate?cap=${cap}`, {
        method: 'POST',
        body: JSON.stringify({ annotation: 'nope' }),
      }),
      { DB: db },
    );
    expect(res.status).toBe(403);
  });

  it('refuses an expired capability link', async () => {
    const { db } = fakeDb();
    const cap = await mintCapability('cap-secret', 'ack:inc-1', Date.now() - 1000);
    const res = await app(db, { capabilitySecret: 'cap-secret' }).fetch(
      req(`/api/incidents/inc-1/ack?cap=${cap}`, { method: 'POST', body: '{}' }),
      { DB: db },
    );
    expect(res.status).toBe(403);
  });

  it('refuses a capability link with a tampered signature', async () => {
    const { db } = fakeDb();
    const cap = await mintCapability('cap-secret', 'ack:inc-1', Date.now() + 60_000);
    const tampered = cap.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a'));
    const res = await app(db, { capabilitySecret: 'cap-secret' }).fetch(
      req(`/api/incidents/inc-1/ack?cap=${tampered}`, { method: 'POST', body: '{}' }),
      { DB: db },
    );
    expect(res.status).toBe(403);
  });
});

describe('write validation', () => {
  const dev = { devMode: true };

  it('rejects a check carrying a literal secret', async () => {
    const { db } = fakeDb();
    const res = await app(db, dev).fetch(
      req('/api/checks', {
        method: 'POST',
        body: JSON.stringify(check({ id: 'leaky', headers: { k: 'hc-super-secret-value' } })),
      }),
      { DB: db },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('${HEALTHCHECK_SECRET}');
  });

  it('accepts a check using a reference', async () => {
    const { db } = fakeDb();
    const res = await app(db, dev).fetch(
      req('/api/checks', {
        method: 'POST',
        body: JSON.stringify(check({ id: 'ok', headers: { k: '${HEALTHCHECK_SECRET}' } })),
      }),
      { DB: db },
    );
    expect(res.status).toBe(201);
  });

  it('rejects a missing id', async () => {
    const { db } = fakeDb();
    const res = await app(db, dev).fetch(
      req('/api/checks', { method: 'POST', body: JSON.stringify({ name: 'x', url: 'https://x' }) }),
      { DB: db },
    );
    expect(res.status).toBe(400);
  });

  it('rejects an id with unsafe characters', async () => {
    const { db } = fakeDb();
    const res = await app(db, dev).fetch(
      req('/api/checks', { method: 'POST', body: JSON.stringify(check({ id: 'bad id/../x' })) }),
      { DB: db },
    );
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate id with 409', async () => {
    const { db } = fakeDb([check({ id: 'dupe' })]);
    const res = await app(db, dev).fetch(
      req('/api/checks', { method: 'POST', body: JSON.stringify(check({ id: 'dupe' })) }),
      { DB: db },
    );
    expect(res.status).toBe(409);
  });

  it('rejects invalid JSON', async () => {
    const { db } = fakeDb();
    const res = await app(db, dev).fetch(req('/api/checks', { method: 'POST', body: 'not json' }), {
      DB: db,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a config import containing a literal secret', async () => {
    const { db } = fakeDb();
    const res = await app(db, dev).fetch(
      req('/api/config', {
        method: 'PUT',
        body: JSON.stringify({
          checks: [check({ id: 'leaky', headers: { k: 'hc-super-secret-value' } })],
        }),
      }),
      { DB: db },
    );
    expect(res.status).toBe(400);
  });
});

describe('agent.md', () => {
  it('is served as markdown with the deployment base URL', async () => {
    const { db } = fakeDb();
    const res = await app(db).fetch(req('/api/agent.md'), { DB: db });
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    const text = await res.text();
    expect(text).toContain('https://mon.example.com/api/status');
  });

  it('documents every route the app actually mounts', async () => {
    // The drift guard. A new endpoint without a ROUTES entry fails here rather
    // than silently going undocumented, which is how the previous skill file
    // ended up describing a system that no longer existed.
    const mounted = app(fakeDb().db).routes
      .filter((r) => r.path.startsWith('/api/'))
      .map((r) => `${r.method} ${r.path}`);

    const documented = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    const undocumented = [...new Set(mounted)].filter((m) => !documented.has(m));
    expect(undocumented).toEqual([]);
  });

  it('documents no route that does not exist', () => {
    const mounted = new Set(
      app(fakeDb().db)
        .routes.filter((r) => r.path.startsWith('/api/'))
        .map((r) => `${r.method} ${r.path}`),
    );
    const phantom = ROUTES.map((r) => `${r.method} ${r.path}`).filter((d) => !mounted.has(d));
    expect(phantom).toEqual([]);
  });

  it('tells agents to use alert links before standing credentials', () => {
    const doc = buildAgentDoc('https://mon.example.com');
    expect(doc).toContain('links');
    expect(doc).toContain('CF-Access-Client-Id');
    expect(doc).toContain('${MY_API_KEY}');
  });
});
