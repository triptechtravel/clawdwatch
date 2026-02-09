/**
 * clawdwatch — Synthetic monitoring for Cloudflare Workers
 *
 * @example
 * ```ts
 * import { createMonitor } from 'clawdwatch';
 *
 * const monitor = createMonitor<Env>({
 *   checks: [
 *     { id: 'website', name: 'Website', type: 'api', url: 'https://example.com' },
 *   ],
 *   getR2Bucket: (env) => env.MY_BUCKET,
 *   onAlert: async (alert) => {
 *     // tell your system about it — openclaw, webhook, whatever
 *   },
 * });
 *
 * app.route('/monitoring', monitor.app);
 * app.get('/status', monitor.statusHandler);
 *
 * await monitor.runChecks(env);
 * ```
 */

import { Hono } from 'hono';
import type { ClawdWatchOptions } from './types';
import { createRoutes, createStatusHandler } from './routes/index';
import { runMonitoringChecks, type OrchestratorConfig } from './engine/orchestrator';

const DEFAULTS = {
  failureThreshold: 2,
  timeoutMs: 10_000,
  historySize: 288,
  stateKey: 'clawdwatch/state.json',
  userAgent: 'clawdwatch/1.0',
};

export interface ClawdWatch<TEnv> {
  /** Mountable Hono sub-app with dashboard (GET /) and admin API (GET /api/status) */
  app: Hono;
  /** Run all configured checks. Call from your scheduled() handler. */
  runChecks: (env: TEnv) => Promise<void>;
  /** Public status JSON handler. Mount on a public route (no auth). */
  statusHandler: (c: any) => Promise<Response>;
}

export function createMonitor<TEnv>(options: ClawdWatchOptions<TEnv>): ClawdWatch<TEnv> {
  const defaults = { ...DEFAULTS, ...options.defaults };

  const orchConfig: OrchestratorConfig = {
    checks: options.checks,
    defaultFailureThreshold: defaults.failureThreshold,
    defaultTimeoutMs: defaults.timeoutMs,
    historySize: defaults.historySize,
    stateKey: defaults.stateKey,
    userAgent: defaults.userAgent,
  };

  const routeConfig = {
    checks: options.checks,
    stateKey: defaults.stateKey,
    getBucket: (c: any) => options.getR2Bucket(c.env as TEnv),
  };

  const app = createRoutes(routeConfig);
  const statusHandler = createStatusHandler(routeConfig);

  const runChecks = async (env: TEnv): Promise<void> => {
    const bucket = options.getR2Bucket(env);
    if (!bucket) {
      console.warn('[clawdwatch] R2 bucket not available, skipping checks');
      return;
    }
    const workerUrl = options.getWorkerUrl?.(env);
    await runMonitoringChecks(orchConfig, bucket, workerUrl, options.onAlert, env);
  };

  return { app, runChecks, statusHandler };
}

export type {
  CheckConfig,
  CheckType,
  CheckStatus,
  AlertPayload,
  AlertType,
  CheckResult,
  CheckState,
  HistoryEntry,
  MonitoringState,
  MonitoringCheckStatus,
  MonitoringStatusResponse,
  ClawdWatchOptions,
} from './types';
