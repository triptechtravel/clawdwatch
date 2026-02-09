/**
 * State machine for alert transitions.
 * Determines when to fire alerts based on check results.
 */

import type {
  CheckResult,
  CheckState,
  AlertType,
} from '../types';

/**
 * Determine the state transition and whether to alert.
 *
 * State machine:
 *   unknown  → healthy   (first success)
 *   unknown  → degraded  (1 failure, threshold not met)
 *   healthy  → degraded  (1 failure, threshold not met)
 *   degraded → unhealthy (consecutive failures >= threshold) → FIRE ALERT
 *   unhealthy → healthy  (1 success) → FIRE RECOVERY ALERT
 *   unhealthy → unhealthy (still failing) → NO ALERT
 */
export function computeTransition(
  state: CheckState,
  result: CheckResult,
  threshold: number,
): { newState: CheckState; alertType: AlertType | null } {
  const now = new Date().toISOString();
  const updated: CheckState = {
    ...state,
    history: state.history ?? [],
    lastCheck: now,
    responseTimeMs: result.responseTimeMs,
  };

  if (result.success) {
    const wasUnhealthy = state.status === 'unhealthy';
    updated.status = 'healthy';
    updated.consecutiveFailures = 0;
    updated.lastSuccess = now;
    updated.lastError = null;

    return {
      newState: updated,
      alertType: wasUnhealthy ? 'recovery' : null,
    };
  }

  // Failure path
  updated.consecutiveFailures = state.consecutiveFailures + 1;
  updated.lastError = result.error;

  if (updated.consecutiveFailures >= threshold) {
    const wasAlreadyUnhealthy = state.status === 'unhealthy';
    updated.status = 'unhealthy';
    return {
      newState: updated,
      alertType: wasAlreadyUnhealthy ? null : 'failure',
    };
  }

  // Below threshold — degraded
  updated.status = 'degraded';
  return { newState: updated, alertType: null };
}
