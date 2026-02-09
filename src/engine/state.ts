/**
 * R2 state persistence for monitoring (v2 — simplified, no history)
 *
 * State only holds current status per check for the alert state machine.
 * History is stored in Analytics Engine.
 */

import type { MonitoringState, CheckState } from '../types';

export function createEmptyState(): MonitoringState {
  return { checks: {}, lastRun: null };
}

export function createEmptyCheckState(): CheckState {
  return {
    status: 'unknown',
    consecutiveFailures: 0,
    lastCheck: null,
    lastSuccess: null,
    lastError: null,
    responseTimeMs: null,
  };
}

export async function loadState(bucket: R2Bucket, stateKey: string): Promise<MonitoringState> {
  try {
    const obj = await bucket.get(stateKey);
    if (!obj) {
      return createEmptyState();
    }
    const text = await obj.text();
    const raw = JSON.parse(text) as Record<string, unknown>;

    // Migrate v1 state: strip history arrays if present
    const state: MonitoringState = {
      checks: {},
      lastRun: (raw.lastRun as string) ?? null,
    };

    const checks = raw.checks as Record<string, Record<string, unknown>> | undefined;
    if (checks) {
      for (const [id, cs] of Object.entries(checks)) {
        state.checks[id] = {
          status: (cs.status as CheckState['status']) ?? 'unknown',
          consecutiveFailures: (cs.consecutiveFailures as number) ?? 0,
          lastCheck: (cs.lastCheck as string) ?? null,
          lastSuccess: (cs.lastSuccess as string) ?? null,
          lastError: (cs.lastError as string) ?? null,
          responseTimeMs: (cs.responseTimeMs as number) ?? null,
        };
      }
    }

    return state;
  } catch (err) {
    console.error('[clawdwatch] Failed to load state from R2:', err);
    return createEmptyState();
  }
}

export async function saveState(
  bucket: R2Bucket,
  stateKey: string,
  state: MonitoringState,
): Promise<void> {
  await bucket.put(stateKey, JSON.stringify(state, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}
