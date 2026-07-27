/**
 * The alert state machine.
 *
 *   unknown   → healthy     first success                    — silent
 *   healthy   → degraded    failure, threshold not yet met   — silent
 *   degraded  → unhealthy   consecutive failures >= threshold — OPENED
 *   unhealthy → unhealthy   still failing, reminder due       — REMINDER
 *   unhealthy → healthy     first success again               — RECOVERED
 *   degraded  → healthy     recovered before opening          — silent
 *
 * v2 could not express the reminder edge at all: `unhealthy → unhealthy`
 * returned null forever, so a multi-day outage alerted exactly once.
 *
 * Pure and clock-injected — `now` is a parameter, never `Date.now()`.
 */

import type { CheckConfig, CheckResult, CheckState } from '../types';

export type Transition =
  | { kind: 'none' }
  | { kind: 'opened' }
  | { kind: 'recovered'; downtimeMs: number }
  | { kind: 'reminder'; downSinceMs: number };

export function emptyState(checkId: string): CheckState {
  return {
    checkId,
    status: 'unknown',
    consecutiveFailures: 0,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastResponseMs: null,
    downSince: null,
    lastAlertAt: null,
    incidentId: null,
  };
}

/**
 * Advance one check's state by one result.
 *
 * `nextIncidentId` is supplied by the caller and consumed only when the
 * transition is `opened`, which keeps this function pure while still letting
 * the orchestrator own id generation.
 */
export function computeTransition(
  state: CheckState,
  result: CheckResult,
  check: CheckConfig,
  now: number,
  nextIncidentId: string,
): { state: CheckState; transition: Transition } {
  const at = new Date(now).toISOString();
  const next: CheckState = {
    ...state,
    lastCheckAt: at,
    lastResponseMs: result.responseTimeMs,
  };

  if (result.success) {
    const wasUnhealthy = state.status === 'unhealthy';
    const downSince = state.downSince ? Date.parse(state.downSince) : null;

    next.status = 'healthy';
    next.consecutiveFailures = 0;
    next.lastSuccessAt = at;
    next.lastError = null;
    next.downSince = null;
    next.lastAlertAt = null;
    next.incidentId = null;

    if (wasUnhealthy) {
      return {
        state: next,
        transition: {
          kind: 'recovered',
          downtimeMs: downSince === null ? 0 : Math.max(0, now - downSince),
        },
      };
    }
    return { state: next, transition: { kind: 'none' } };
  }

  next.consecutiveFailures = state.consecutiveFailures + 1;
  next.lastError = result.error;

  // Still climbing toward the threshold — degraded, and silent.
  if (next.consecutiveFailures < check.failureThreshold) {
    next.status = 'degraded';
    return { state: next, transition: { kind: 'none' } };
  }

  next.status = 'unhealthy';

  // Crossing the threshold for the first time opens an incident.
  if (state.status !== 'unhealthy') {
    next.downSince = at;
    next.lastAlertAt = at;
    next.incidentId = nextIncidentId;
    return { state: next, transition: { kind: 'opened' } };
  }

  // Already unhealthy: remind only when the cadence has elapsed.
  const interval = check.reminderIntervalMs;
  const lastAlert = state.lastAlertAt ? Date.parse(state.lastAlertAt) : null;
  const downSince = state.downSince ? Date.parse(state.downSince) : now;

  if (interval !== null && lastAlert !== null && now - lastAlert >= interval) {
    next.lastAlertAt = at;
    return {
      state: next,
      transition: { kind: 'reminder', downSinceMs: Math.max(0, now - downSince) },
    };
  }

  return { state: next, transition: { kind: 'none' } };
}
