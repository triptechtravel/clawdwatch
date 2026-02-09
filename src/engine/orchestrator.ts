/**
 * Monitoring orchestrator
 *
 * Runs all configured checks, updates state, and fires alert callbacks.
 */

import type {
  CheckConfig,
  AlertPayload,
} from '../types';
import { loadState, saveState, createEmptyCheckState } from './state';
import { runCheck } from './runner';
import { computeTransition } from './alerts';

export interface OrchestratorConfig {
  checks: CheckConfig[];
  defaultFailureThreshold: number;
  defaultTimeoutMs: number;
  historySize: number;
  stateKey: string;
  userAgent: string;
}

export async function runMonitoringChecks<TEnv>(
  config: OrchestratorConfig,
  bucket: R2Bucket,
  workerUrl: string | undefined,
  onAlert: ((alert: AlertPayload, env: TEnv) => Promise<void>) | undefined,
  env: TEnv,
): Promise<void> {
  console.log(`[clawdwatch] Running ${config.checks.length} check(s)...`);

  const state = await loadState(bucket, config.stateKey);

  for (const check of config.checks) {
    const timeoutMs = check.timeoutMs ?? config.defaultTimeoutMs;
    const threshold = check.failureThreshold ?? config.defaultFailureThreshold;

    const checkState = state.checks[check.id] ?? createEmptyCheckState(check.id);
    // eslint-disable-next-line no-await-in-loop -- sequential check execution required
    const result = await runCheck(check, workerUrl, timeoutMs, config.userAgent);

    console.log(
      `[clawdwatch] ${check.name}: ${result.success ? 'OK' : 'FAIL'} (${result.responseTimeMs}ms)${result.error ? ` — ${result.error}` : ''}`,
    );

    const { newState, alertType } = computeTransition(checkState, result, threshold);

    // Record history entry
    newState.history.push({
      timestamp: new Date().toISOString(),
      status: newState.status,
      responseTimeMs: result.responseTimeMs,
      error: result.error,
    });
    if (newState.history.length > config.historySize) {
      newState.history = newState.history.slice(-config.historySize);
    }

    state.checks[check.id] = newState;

    if (alertType && onAlert) {
      console.log(`[clawdwatch] Firing ${alertType} alert for ${check.name}`);
      try {
        const payload: AlertPayload = {
          type: alertType,
          check,
          checkState: newState,
          result,
          timestamp: new Date().toISOString(),
        };
        // eslint-disable-next-line no-await-in-loop -- sequential alert dispatch
        await onAlert(payload, env);
      } catch (err) {
        console.error(`[clawdwatch] Alert callback failed for ${check.name}:`, err);
      }
    }
  }

  state.lastRun = new Date().toISOString();
  await saveState(bucket, config.stateKey, state);

  console.log('[clawdwatch] Checks complete, state saved');
}
