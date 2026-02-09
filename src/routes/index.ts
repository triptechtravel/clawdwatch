/**
 * Hono route factory for clawdwatch
 *
 * Creates a mountable sub-app with dashboard and admin API.
 */

import { Hono } from 'hono';
import type {
  CheckConfig,
  MonitoringCheckStatus,
  MonitoringStatusResponse,
} from '../types';
import { loadState } from '../engine/state';

import { dashboardHtml } from '../dashboard-html';

interface RouteConfig {
  checks: CheckConfig[];
  stateKey: string;
  getBucket: (c: any) => R2Bucket;
}

export function createRoutes(config: RouteConfig): Hono {
  const app = new Hono();

  // GET / — Serve embedded dashboard
  app.get('/', (c) => {
    return c.html(dashboardHtml);
  });

  // GET /api/status — Admin JSON endpoint
  app.get('/api/status', async (c) => {
    try {
      const bucket = config.getBucket(c);
      const state = await loadState(bucket, config.stateKey);

      const checks: MonitoringCheckStatus[] = config.checks.map((check) => {
        const checkState = state.checks[check.id];
        const history = checkState?.history ?? [];
        const successCount = history.filter((h) => h.status === 'healthy').length;
        const uptimePercent = history.length > 0
          ? Math.round((successCount / history.length) * 10000) / 100
          : null;
        return {
          id: check.id,
          name: check.name,
          type: check.type,
          url: check.url,
          tags: check.tags ?? [],
          status: checkState?.status ?? 'unknown',
          consecutiveFailures: checkState?.consecutiveFailures ?? 0,
          lastCheck: checkState?.lastCheck ?? null,
          lastSuccess: checkState?.lastSuccess ?? null,
          lastError: checkState?.lastError ?? null,
          responseTimeMs: checkState?.responseTimeMs ?? null,
          history,
          uptimePercent,
        };
      });

      const hasUnhealthy = checks.some((c) => c.status === 'unhealthy');
      const hasDegraded = checks.some((c) => c.status === 'degraded');
      const overall = hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';

      const response: MonitoringStatusResponse = {
        overall,
        checks,
        lastRun: state.lastRun,
      };

      return c.json(response);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Unknown error' },
        500,
      );
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
      const bucket = config.getBucket(c);
      const state = await loadState(bucket, config.stateKey);

      const checks = config.checks.map((check) => {
        const checkState = state.checks[check.id];
        return {
          id: check.id,
          name: check.name,
          status: checkState?.status ?? 'unknown',
          responseTimeMs: checkState?.responseTimeMs ?? null,
        };
      });

      const hasUnhealthy = checks.some((c) => c.status === 'unhealthy');
      const hasDegraded = checks.some((c) => c.status === 'degraded');
      const overall = hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';

      return c.json({ overall, checks, lastRun: state.lastRun });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Unknown error' },
        500,
      );
    }
  };
}
