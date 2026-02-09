/**
 * Monitoring orchestrator (v2)
 *
 * - Loads checks from D1 (not static config)
 * - Writes results to Analytics Engine
 * - Creates/resolves incidents in D1
 * - Checks maintenance windows before alerting
 * - Simplified R2 state (no history)
 */

import type {
  CheckConfig,
  CheckState,
  AlertPayload,
  ClawdWatchOptions,
} from '../types';
import { loadState, saveState, createEmptyCheckState } from './state';
import { loadChecks } from './db';
import { isInMaintenance, createIncident, resolveIncidents, loadAlertRules, ensureResultsTable, insertCheckResult, pruneHistory } from './db';
import { runCheck } from './runner';
import { computeTransition } from './alerts';

interface OrchestratorDefaults {
  failureThreshold: number;
  timeoutMs: number;
  stateKey: string;
  userAgent: string;
}

export async function runMonitoringChecks<TEnv>(
  options: ClawdWatchOptions<TEnv>,
  defaults: OrchestratorDefaults,
  env: TEnv,
): Promise<void> {
  const db = options.storage.getD1(env);
  const bucket = options.storage.getR2(env);
  const ae = options.storage.getAnalyticsEngine?.(env);

  if (!bucket) {
    console.warn('[clawdwatch] R2 bucket not available, skipping checks');
    return;
  }

  // Load enabled checks from D1
  const checks = await loadChecks(db);
  console.log(`[clawdwatch] Running ${checks.length} check(s)...`);

  const state = await loadState(bucket, defaults.stateKey);

  await ensureResultsTable(db);

  for (const check of checks) {
    // Check maintenance window
    // eslint-disable-next-line no-await-in-loop
    const maintenance = await isInMaintenance(db, check.id, check.group_id);
    if (maintenance?.skip_checks) {
      console.log(`[clawdwatch] ${check.name}: skipped (maintenance window)`);
      continue;
    }

    const checkState = state.checks[check.id] ?? createEmptyCheckState();
    const resolvedUrl = options.resolveUrl?.(check.url, env) ?? check.url;

    // Execute check
    // eslint-disable-next-line no-await-in-loop
    const result = await runCheck(check, resolvedUrl, defaults.userAgent);

    console.log(
      `[clawdwatch] ${check.name}: ${result.success ? 'OK' : 'FAIL'} (${result.responseTimeMs}ms)${result.error ? ` — ${result.error}` : ''}`,
    );

    // Write to Analytics Engine
    if (ae) {
      ae.writeDataPoint({
        indexes: [check.id],
        blobs: [
          check.name,
          result.success ? 'healthy' : 'unhealthy',
          result.error ?? '',
          'default',
          check.type,
        ],
        doubles: [
          result.responseTimeMs,
          result.statusCode ?? 0,
        ],
      });
    }

    // Write to D1 check_results (hot 24h window)
    // eslint-disable-next-line no-await-in-loop
    await insertCheckResult(
      db, check.id, result.success ? 'healthy' : 'unhealthy',
      result.responseTimeMs, result.error,
    ).catch((err) => {
      console.error(`[clawdwatch] Failed to insert check result for ${check.name}:`, err);
    });

    // Compute state transition
    const { newState, alertType } = computeTransition(checkState, result, check.failure_threshold);
    state.checks[check.id] = newState;

    // Track incidents in D1
    if (alertType === 'failure') {
      // eslint-disable-next-line no-await-in-loop
      await createIncident(db, check.id, 'unhealthy', result.error).catch((err) => {
        console.error(`[clawdwatch] Failed to create incident for ${check.name}:`, err);
      });
    } else if (alertType === 'recovery') {
      // eslint-disable-next-line no-await-in-loop
      await resolveIncidents(db, check.id).catch((err) => {
        console.error(`[clawdwatch] Failed to resolve incidents for ${check.name}:`, err);
      });
    }

    // Fire alerts (unless in maintenance with suppress_alerts)
    if (alertType && options.onAlert && !maintenance?.suppress_alerts) {
      console.log(`[clawdwatch] Firing ${alertType} alert for ${check.name}`);
      try {
        const payload: AlertPayload = {
          type: alertType,
          check,
          checkState: newState,
          result,
          timestamp: new Date().toISOString(),
        };
        // eslint-disable-next-line no-await-in-loop
        await options.onAlert(payload, env);
      } catch (err) {
        console.error(`[clawdwatch] Alert callback failed for ${check.name}:`, err);
      }
    }
  }

  state.lastRun = new Date().toISOString();
  await saveState(bucket, defaults.stateKey, state);

  await pruneHistory(db).catch((err) => {
    console.error('[clawdwatch] Failed to prune check results:', err);
  });

  console.log('[clawdwatch] Checks complete, state saved');
}
