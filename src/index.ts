/**
 * clawdwatch — Synthetic monitoring for Cloudflare Workers (v2)
 *
 * v2 uses D1 for check configs, Analytics Engine for history,
 * and simplified R2 state (no history arrays).
 *
 * @example
 * ```ts
 * import { createMonitor } from 'clawdwatch';
 *
 * const monitor = createMonitor<Env>({
 *   storage: {
 *     getD1: (env) => env.MONITORING_DB,
 *     getR2: (env) => env.MY_BUCKET,
 *     getAnalyticsEngine: (env) => env.MONITORING_AE,
 *   },
 *   resolveUrl: (url, env) =>
 *     url.replace('{{WORKER_URL}}', env.WORKER_URL ?? ''),
 *   onAlert: async (alert, env) => { ... },
 * });
 *
 * app.route('/monitoring', monitor.app);
 * app.get('/status', monitor.statusHandler);
 *
 * await monitor.runChecks(env);
 * ```
 */

import type { Hono } from 'hono';
import type { ClawdWatchOptions } from './types';
import { createRoutes, createStatusHandler } from './routes/index';
import { runMonitoringChecks } from './engine/orchestrator';

const DEFAULTS = {
  failureThreshold: 2,
  timeoutMs: 10_000,
  stateKey: 'clawdwatch/state.json',
  userAgent: 'clawdwatch/2.0',
};

export interface ClawdWatch<TEnv> {
  /** Mountable Hono sub-app with admin API (CRUD, status, config) */
  app: Hono;
  /** Run all enabled checks. Call from your scheduled() handler. */
  runChecks: (env: TEnv) => Promise<void>;
  /** Public status JSON handler. Mount on a public route (no auth). */
  statusHandler: (c: any) => Promise<Response>;
}

export function createMonitor<TEnv>(options: ClawdWatchOptions<TEnv>): ClawdWatch<TEnv> {
  const defaults = { ...DEFAULTS, ...options.defaults };

  const routeConfig = {
    stateKey: defaults.stateKey,
    userAgent: defaults.userAgent,
    getD1: (c: any) => options.storage.getD1(c.env as TEnv),
    getBucket: (c: any) => options.storage.getR2(c.env as TEnv),
    resolveUrl: options.resolveUrl
      ? (url: string, env: any) => options.resolveUrl!(url, env as TEnv)
      : undefined,
  };

  const app = createRoutes(routeConfig);
  const statusHandler = createStatusHandler(routeConfig);

  const runChecks = async (env: TEnv): Promise<void> => {
    await runMonitoringChecks(options, defaults, env);
  };

  return { app, runChecks, statusHandler };
}

export type {
  CheckConfig,
  CheckType,
  CheckStatus,
  Assertion,
  StatusCodeAssertion,
  HeaderAssertion,
  BodyAssertion,
  ResponseTimeAssertion,
  AlertPayload,
  AlertType,
  CheckResult,
  CheckState,
  HistoryEntry,
  MonitoringState,
  MonitoringCheckStatus,
  MonitoringStatusResponse,
  ClawdWatchOptions,
  Incident,
  AlertRule,
  MaintenanceWindow,
} from './types';
