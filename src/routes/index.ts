/**
 * The HTTP API.
 *
 * Reads are open by default (mount behind Access if you want them private);
 * every write requires a principal. Responses pass through `redactCheck`, so a
 * config export can be committed to a repo without leaking anything.
 */

import { Hono } from 'hono';
import type { CheckConfig, ClawdWatchOptions, SecretMap } from '../types';
import { DEFAULTS } from '../types';
import { redactCheck, LeakedSecretError } from '../engine/secrets';
import { runCheck } from '../engine/runner';
import { emptyState } from '../engine/transition';
import {
  activeMaintenance,
  annotateIncident,
  deleteCheck,
  getCheck,
  insertResultStatement,
  listChecks,
  listIncidents,
  latestDeliveries,
  listResults,
  loadStates,
  upsertCheck,
} from '../engine/store/d1';
import { authenticate, AuthError, type AuthConfig, type Principal } from '../auth';
import { buildAgentDoc } from './agent-md';
import { dashboardHtml } from '../dashboard-html';

export interface RouteConfig<TEnv> {
  options: ClawdWatchOptions<TEnv>;
  /** Static auth config, used when `resolveAuth` is absent. */
  auth: AuthConfig;
  /** Per-request auth config, so team domain and AUD can come from env. */
  resolveAuth?: (env: TEnv) => AuthConfig;
}

/** Normalise a partial check from an API body into a full CheckConfig. */
export function normaliseCheck(input: Record<string, unknown>, existing?: CheckConfig): CheckConfig {
  const pick = <T>(key: string, fallback: T): T =>
    input[key] !== undefined ? (input[key] as T) : fallback;

  const base: CheckConfig = existing ?? {
    id: '',
    name: '',
    url: '',
    method: 'GET',
    headers: {},
    body: null,
    assertions: [],
    retryCount: DEFAULTS.retryCount,
    retryDelayMs: DEFAULTS.retryDelayMs,
    timeoutMs: DEFAULTS.timeoutMs,
    failureThreshold: DEFAULTS.failureThreshold,
    reminderIntervalMs: DEFAULTS.reminderIntervalMs,
    intervalMins: DEFAULTS.intervalMins,
    tags: [],
    enabled: true,
  };

  return {
    id: pick('id', base.id),
    name: pick('name', base.name),
    url: pick('url', base.url),
    method: pick('method', base.method),
    headers: pick('headers', base.headers),
    body: pick('body', base.body),
    assertions: pick('assertions', base.assertions),
    retryCount: pick('retryCount', base.retryCount),
    retryDelayMs: pick('retryDelayMs', base.retryDelayMs),
    timeoutMs: pick('timeoutMs', base.timeoutMs),
    failureThreshold: pick('failureThreshold', base.failureThreshold),
    reminderIntervalMs: pick('reminderIntervalMs', base.reminderIntervalMs),
    intervalMins: pick('intervalMins', base.intervalMins),
    tags: pick('tags', base.tags),
    enabled: pick('enabled', base.enabled),
  };
}

function validate(check: CheckConfig): string | null {
  if (!check.id) return 'id is required';
  if (!/^[a-zA-Z0-9._-]+$/.test(check.id)) return 'id may contain only letters, digits, . _ -';
  if (!check.name) return 'name is required';
  if (!check.url) return 'url is required';
  if (check.timeoutMs <= 0) return 'timeoutMs must be positive';
  if (check.failureThreshold < 1) return 'failureThreshold must be at least 1';
  if (check.intervalMins < 1) return 'intervalMins must be at least 1';
  return null;
}

/**
 * Hono constrains Bindings to Record<string, unknown>, which a plain `interface
 * Env` does not satisfy. Keep the app loosely typed internally and narrow at
 * the one place env is read.
 */
type LooseBindings = Record<string, unknown>;

export function createRoutes<TEnv>(config: RouteConfig<TEnv>): Hono<{ Bindings: LooseBindings }> {
  const app = new Hono<{ Bindings: LooseBindings }>();
  const envOf = (c: { env: LooseBindings }): TEnv => c.env as TEnv;
  const { options } = config;
  const authFor = (env: TEnv): AuthConfig => config.resolveAuth?.(env) ?? config.auth;

  const db = (env: TEnv) => options.d1(env);
  const secretsFor = (env: TEnv): SecretMap => options.secrets?.(env) ?? {};

  /** Guard a write. Returns a Response on failure, or the principal. */
  async function guard(
    request: Request,
    env: TEnv,
    scope?: string,
  ): Promise<Principal | { error: string; status: 401 | 403 }> {
    try {
      return await authenticate(request, authFor(env), scope);
    } catch (err) {
      if (err instanceof AuthError) return { error: err.message, status: err.status };
      throw err;
    }
  }

  function isDenied(p: unknown): p is { error: string; status: 401 | 403 } {
    return typeof p === 'object' && p !== null && 'error' in p && 'status' in p;
  }

  // ── Status ────────────────────────────────────────────────────────────

  app.get('/api/status', async (c) => {
    const database = db(envOf(c));
    const [checks, states] = await Promise.all([listChecks(database), loadStates(database)]);

    const rows = checks.map((check) => {
      const state = states.get(check.id) ?? emptyState(check.id);
      return {
        id: check.id,
        name: check.name,
        url: check.url,
        tags: check.tags,
        enabled: check.enabled,
        status: state.status,
        consecutiveFailures: state.consecutiveFailures,
        lastCheckAt: state.lastCheckAt,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        lastResponseMs: state.lastResponseMs,
        downSince: state.downSince,
      };
    });

    const active = rows.filter((r) => r.enabled);
    const overall = active.some((r) => r.status === 'unhealthy')
      ? 'unhealthy'
      : active.some((r) => r.status === 'degraded')
        ? 'degraded'
        : 'healthy';

    return c.json({ overall, checks: rows, generatedAt: new Date().toISOString() });
  });

  app.get('/api/checks/:id/history', async (c) => {
    const results = await listResults(db(envOf(c)), c.req.param('id'), 288);
    return c.json({ results });
  });

  // ── Checks ────────────────────────────────────────────────────────────

  app.get('/api/checks', async (c) => {
    const secrets = secretsFor(envOf(c));
    const checks = await listChecks(db(envOf(c)));
    return c.json({ checks: checks.map((ch) => redactCheck(ch, secrets)) });
  });

  app.get('/api/checks/:id', async (c) => {
    const check = await getCheck(db(envOf(c)), c.req.param('id'));
    if (!check) return c.json({ error: 'Not found' }, 404);
    return c.json(redactCheck(check, secretsFor(envOf(c))));
  });

  app.post('/api/checks', async (c) => {
    const principal = await guard(c.req.raw, envOf(c));
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

    const check = normaliseCheck(body);
    const problem = validate(check);
    if (problem) return c.json({ error: problem }, 400);

    if (await getCheck(db(envOf(c)), check.id)) {
      return c.json({ error: `A check with id "${check.id}" already exists` }, 409);
    }

    try {
      await upsertCheck(db(envOf(c)), check, secretsFor(envOf(c)));
    } catch (err) {
      if (err instanceof LeakedSecretError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(redactCheck(check, secretsFor(envOf(c))), 201);
  });

  app.put('/api/checks/:id', async (c) => {
    const principal = await guard(c.req.raw, envOf(c));
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const existing = await getCheck(db(envOf(c)), c.req.param('id'));
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

    const check = normaliseCheck({ ...body, id: existing.id }, existing);
    const problem = validate(check);
    if (problem) return c.json({ error: problem }, 400);

    try {
      await upsertCheck(db(envOf(c)), check, secretsFor(envOf(c)));
    } catch (err) {
      if (err instanceof LeakedSecretError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(redactCheck(check, secretsFor(envOf(c))));
  });

  app.delete('/api/checks/:id', async (c) => {
    const principal = await guard(c.req.raw, envOf(c));
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const existing = await getCheck(db(envOf(c)), c.req.param('id'));
    if (!existing) return c.json({ error: 'Not found' }, 404);

    await deleteCheck(db(envOf(c)), existing.id);
    return c.json({ deleted: existing.id });
  });

  app.post('/api/checks/:id/toggle', async (c) => {
    const principal = await guard(c.req.raw, envOf(c));
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const existing = await getCheck(db(envOf(c)), c.req.param('id'));
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const updated = { ...existing, enabled: !existing.enabled };
    await upsertCheck(db(envOf(c)), updated, secretsFor(envOf(c)));
    return c.json({ id: updated.id, enabled: updated.enabled });
  });

  app.post('/api/checks/:id/run', async (c) => {
    const id = c.req.param('id');
    const principal = await guard(c.req.raw, envOf(c), `run:${id}`);
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const check = await getCheck(db(envOf(c)), id);
    if (!check) return c.json({ error: 'Not found' }, 404);

    const result = await runCheck(check, {
      resolvedUrl: options.resolveUrl?.(check.url, envOf(c)) ?? check.url,
      headerRules: options.headerRules ?? [],
      secrets: secretsFor(envOf(c)),
      userAgent: options.defaults?.userAgent ?? DEFAULTS.userAgent,
      now: () => Date.now(),
    });

    // An ad-hoc run is still a data point worth keeping.
    await db(envOf(c)).batch([insertResultStatement(db(envOf(c)), result)]);
    return c.json(result);
  });

  // ── Incidents ─────────────────────────────────────────────────────────

  app.get('/api/incidents', async (c) => {
    const url = new URL(c.req.url);
    const openParam = url.searchParams.get('status');
    const incidents = await listIncidents(db(envOf(c)), {
      checkId: url.searchParams.get('check_id') ?? undefined,
      open: openParam === 'open' ? true : openParam === 'resolved' ? false : undefined,
      limit: Number(url.searchParams.get('limit') ?? 50),
    });
    return c.json({ incidents });
  });

  app.post('/api/incidents/:id/annotate', async (c) => {
    const id = c.req.param('id');
    const principal = await guard(c.req.raw, envOf(c), `annotate:${id}`);
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const body = (await c.req.json().catch(() => null)) as { annotation?: string } | null;
    if (!body?.annotation) return c.json({ error: 'annotation is required' }, 400);

    await annotateIncident(db(envOf(c)), id, body.annotation);
    return c.json({ id, annotation: body.annotation });
  });

  app.post('/api/incidents/:id/ack', async (c) => {
    const id = c.req.param('id');
    const principal = await guard(c.req.raw, envOf(c), `ack:${id}`);
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const note = body.note ? `Acknowledged: ${body.note}` : 'Acknowledged';
    await annotateIncident(db(envOf(c)), id, note);
    return c.json({ id, acknowledged: true });
  });

  // ── Maintenance ───────────────────────────────────────────────────────

  app.get('/api/maintenance', async (c) => {
    const windows = await activeMaintenance(db(envOf(c)), new Date().toISOString());
    return c.json({ windows });
  });

  // ── Notifier health ───────────────────────────────────────────────────

  app.get('/api/deliveries', async (c) => {
    const deliveries = await latestDeliveries(db(envOf(c)));
    return c.json({ deliveries });
  });

  // ── Config round-trip ─────────────────────────────────────────────────

  app.get('/api/config', async (c) => {
    const secrets = secretsFor(envOf(c));
    const checks = await listChecks(db(envOf(c)));
    return c.json({
      version: 3,
      checks: checks.map((ch) => redactCheck(ch, secrets)),
    });
  });

  app.put('/api/config', async (c) => {
    const principal = await guard(c.req.raw, envOf(c));
    if (isDenied(principal)) return c.json({ error: principal.error }, principal.status);

    const body = (await c.req.json().catch(() => null)) as { checks?: unknown[] } | null;
    if (!body || !Array.isArray(body.checks)) {
      return c.json({ error: 'Body must be { checks: [...] }' }, 400);
    }

    const secrets = secretsFor(envOf(c));
    const imported: string[] = [];

    for (const raw of body.checks) {
      const check = normaliseCheck(raw as Record<string, unknown>);
      const problem = validate(check);
      if (problem) return c.json({ error: `${check.id || '(no id)'}: ${problem}` }, 400);
      try {
        await upsertCheck(db(envOf(c)), check, secrets);
      } catch (err) {
        if (err instanceof LeakedSecretError) {
          return c.json({ error: `${check.id}: ${err.message}` }, 400);
        }
        throw err;
      }
      imported.push(check.id);
    }

    return c.json({ imported });
  });

  // ── Capability document ───────────────────────────────────────────────

  app.get('/api/agent.md', (c) => {
    const base = options.baseUrl?.(envOf(c)) ?? new URL(c.req.url).origin;
    return c.text(buildAgentDoc(base), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  // ── Dashboard ─────────────────────────────────────────────────────────
  // Last, so it never shadows an /api route.

  app.get('/', (c) => c.html(dashboardHtml));
  app.get('/dashboard', (c) => c.html(dashboardHtml));

  return app;
}
