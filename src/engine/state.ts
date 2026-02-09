/**
 * R2 state persistence for monitoring
 */

import type { MonitoringState, CheckState } from '../types';

export function createEmptyState(): MonitoringState {
  return { checks: {}, lastRun: null };
}

export function createEmptyCheckState(id: string): CheckState {
  return {
    id,
    status: 'unknown',
    consecutiveFailures: 0,
    lastCheck: null,
    lastSuccess: null,
    lastError: null,
    responseTimeMs: null,
    history: [],
  };
}

export async function loadState(bucket: R2Bucket, stateKey: string): Promise<MonitoringState> {
  try {
    const obj = await bucket.get(stateKey);
    if (!obj) {
      return createEmptyState();
    }
    const text = await obj.text();
    return JSON.parse(text) as MonitoringState;
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
