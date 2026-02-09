/**
 * Hono route factory for clawdwatch v2
 *
 * Creates a mountable sub-app with:
 * - Status API (R2 state + D1 checks)
 * - Check CRUD
 * - Incidents, alert rules, maintenance windows
 * - Config export/import
 */

import { Hono } from 'hono';
import type {
  CheckConfig,
  MonitoringCheckStatus,
  MonitoringStatusResponse,
} from '../types';
import { loadState } from '../engine/state';
import {
  loadAllChecks,
  loadCheck,
  createCheck,
  updateCheck,
  deleteCheck,
  toggleCheck,
  listIncidents,
  loadAllAlertRules,
  createAlertRule,
  deleteAlertRule,
  listMaintenanceWindows,
  createMaintenanceWindow,
  deleteMaintenanceWindow,
} from '../engine/db';
import { runCheck } from '../engine/runner';

interface RouteConfig {
  stateKey: string;
  userAgent: string;
  getD1: (c: any) => D1Database;
  getBucket: (c: any) => R2Bucket;
  resolveUrl?: (url: string, env: any) => string;
}

export function createRoutes(config: RouteConfig): Hono {
  const app = new Hono();

  // ── Status ──

  app.get('/api/status', async (c) => {
    try {
      const db = config.getD1(c);
      const bucket = config.getBucket(c);
      const state = await loadState(bucket, config.stateKey);
      const checks = await loadAllChecks(db);

      const checkStatuses: MonitoringCheckStatus[] = checks.map((check) => {
        const checkState = state.checks[check.id];
        return {
          id: check.id,
          name: check.name,
          type: check.type,
          url: check.url,
          tags: check.tags,
          status: checkState?.status ?? 'unknown',
          consecutiveFailures: checkState?.consecutiveFailures ?? 0,
          lastCheck: checkState?.lastCheck ?? null,
          lastSuccess: checkState?.lastSuccess ?? null,
          lastError: checkState?.lastError ?? null,
          responseTimeMs: checkState?.responseTimeMs ?? null,
          history: [],
          uptimePercent: null,
          enabled: check.enabled,
        };
      });

      const hasUnhealthy = checkStatuses.some((cs) => cs.status === 'unhealthy');
      const hasDegraded = checkStatuses.some((cs) => cs.status === 'degraded');
      const overall = hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';

      const response: MonitoringStatusResponse = {
        overall,
        checks: checkStatuses,
        lastRun: state.lastRun,
      };

      return c.json(response);
    } catch (err) {
      console.error('[clawdwatch] Status API error:', err);
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  // ── Check CRUD ──

  app.get('/api/checks', async (c) => {
    try {
      const db = config.getD1(c);
      const checks = await loadAllChecks(db);
      return c.json({ checks });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.get('/api/checks/:id', async (c) => {
    try {
      const db = config.getD1(c);
      const check = await loadCheck(db, c.req.param('id'));
      if (!check) return c.json({ error: 'Check not found' }, 404);
      return c.json(check);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.post('/api/checks', async (c) => {
    try {
      const db = config.getD1(c);
      const body = await c.req.json<Partial<CheckConfig> & { id: string; name: string; url: string }>();
      if (!body.id || !body.name || !body.url) {
        return c.json({ error: 'id, name, and url are required' }, 400);
      }
      await createCheck(db, body);
      return c.json({ ok: true, id: body.id }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.put('/api/checks/:id', async (c) => {
    try {
      const db = config.getD1(c);
      const body = await c.req.json<Partial<CheckConfig>>();
      const updated = await updateCheck(db, c.req.param('id'), body);
      if (!updated) return c.json({ error: 'Check not found or no changes' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.delete('/api/checks/:id', async (c) => {
    try {
      const db = config.getD1(c);
      const deleted = await deleteCheck(db, c.req.param('id'));
      if (!deleted) return c.json({ error: 'Check not found' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.post('/api/checks/:id/toggle', async (c) => {
    try {
      const db = config.getD1(c);
      const toggled = await toggleCheck(db, c.req.param('id'));
      if (!toggled) return c.json({ error: 'Check not found' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.post('/api/checks/:id/run', async (c) => {
    try {
      const db = config.getD1(c);
      const check = await loadCheck(db, c.req.param('id'));
      if (!check) return c.json({ error: 'Check not found' }, 404);

      const resolvedUrl = config.resolveUrl
        ? config.resolveUrl(check.url, (c as any).env)
        : check.url;

      const result = await runCheck(check, resolvedUrl, config.userAgent);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  // ── Incidents ──

  app.get('/api/incidents', async (c) => {
    try {
      const db = config.getD1(c);
      const checkId = c.req.query('check_id');
      const status = c.req.query('status') as 'open' | 'resolved' | undefined;
      const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;

      const incidents = await listIncidents(db, { checkId, status, limit });
      return c.json({ incidents });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  // ── Alert Rules ──

  app.get('/api/alert-rules', async (c) => {
    try {
      const db = config.getD1(c);
      const rules = await loadAllAlertRules(db);
      return c.json({ alertRules: rules });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.post('/api/alert-rules', async (c) => {
    try {
      const db = config.getD1(c);
      const body = await c.req.json<{
        channel: string;
        check_id?: string | null;
        group_id?: string | null;
        config?: Record<string, unknown>;
        on_failure?: boolean;
        on_recovery?: boolean;
        enabled?: boolean;
      }>();
      if (!body.channel) {
        return c.json({ error: 'channel is required' }, 400);
      }
      const id = await createAlertRule(db, body);
      return c.json({ ok: true, id }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.delete('/api/alert-rules/:id', async (c) => {
    try {
      const db = config.getD1(c);
      const id = Number(c.req.param('id'));
      const deleted = await deleteAlertRule(db, id);
      if (!deleted) return c.json({ error: 'Alert rule not found' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  // ── Maintenance Windows ──

  app.get('/api/maintenance', async (c) => {
    try {
      const db = config.getD1(c);
      const windows = await listMaintenanceWindows(db);
      return c.json({ maintenanceWindows: windows });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.post('/api/maintenance', async (c) => {
    try {
      const db = config.getD1(c);
      const body = await c.req.json<{
        starts_at: string;
        ends_at: string;
        check_id?: string | null;
        group_id?: string | null;
        reason?: string | null;
        suppress_alerts?: boolean;
        skip_checks?: boolean;
      }>();
      if (!body.starts_at || !body.ends_at) {
        return c.json({ error: 'starts_at and ends_at are required' }, 400);
      }
      const id = await createMaintenanceWindow(db, body);
      return c.json({ ok: true, id }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.delete('/api/maintenance/:id', async (c) => {
    try {
      const db = config.getD1(c);
      const id = Number(c.req.param('id'));
      const deleted = await deleteMaintenanceWindow(db, id);
      if (!deleted) return c.json({ error: 'Maintenance window not found' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  // ── Config Export/Import ──

  app.get('/api/config', async (c) => {
    try {
      const db = config.getD1(c);
      const checks = await loadAllChecks(db);
      const alertRules = await loadAllAlertRules(db);
      return c.json({ checks, alertRules });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  app.put('/api/config', async (c) => {
    try {
      const db = config.getD1(c);
      const body = await c.req.json<{
        checks?: Array<Partial<CheckConfig> & { id: string; name: string; url: string }>;
      }>();

      if (!body.checks) {
        return c.json({ error: 'checks array required' }, 400);
      }

      // Get existing checks for diff
      const existing = await loadAllChecks(db);
      const existingIds = new Set(existing.map((ch) => ch.id));
      const incomingIds = new Set(body.checks.map((ch) => ch.id));

      // Delete checks not in import
      for (const ex of existing) {
        if (!incomingIds.has(ex.id)) {
          // eslint-disable-next-line no-await-in-loop
          await deleteCheck(db, ex.id);
        }
      }

      // Create or update checks
      for (const ch of body.checks) {
        if (existingIds.has(ch.id)) {
          // eslint-disable-next-line no-await-in-loop
          await updateCheck(db, ch.id, ch);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await createCheck(db, ch);
        }
      }

      return c.json({ ok: true, synced: body.checks.length });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  return app;
}

/**
 * Create a public status JSON handler (mount without auth)
 */
export function createStatusHandler(config: RouteConfig) {
  return async (c: any) => {
    try {
      const db = config.getD1(c);
      const bucket = config.getBucket(c);
      const state = await loadState(bucket, config.stateKey);
      const checks = await loadAllChecks(db);

      const checkStatuses = checks
        .filter((ch) => ch.enabled)
        .map((check) => {
          const checkState = state.checks[check.id];
          return {
            id: check.id,
            name: check.name,
            status: checkState?.status ?? 'unknown',
            responseTimeMs: checkState?.responseTimeMs ?? null,
          };
        });

      const hasUnhealthy = checkStatuses.some((cs) => cs.status === 'unhealthy');
      const hasDegraded = checkStatuses.some((cs) => cs.status === 'degraded');
      const overall = hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';

      return c.json({ overall, checks: checkStatuses, lastRun: state.lastRun });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Unknown error' },
        500,
      );
    }
  };
}
