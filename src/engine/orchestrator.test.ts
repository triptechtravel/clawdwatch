import { describe, it, expect } from 'vitest';
import { isDue, pooled } from './orchestrator';
import { emptyState } from './transition';
import type { CheckConfig, CheckState } from '../types';

function check(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    id: 'c1',
    name: 'Check',
    url: 'https://api.example.com/health',
    method: 'GET',
    headers: {},
    body: null,
    assertions: [],
    retryCount: 0,
    retryDelayMs: 0,
    timeoutMs: 5000,
    failureThreshold: 3,
    reminderIntervalMs: null,
    intervalMins: 5,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

const T0 = Date.parse('2026-07-27T00:00:00.000Z');

describe('isDue', () => {
  it('runs a check that has never run', () => {
    expect(isDue(check(), emptyState('c1'), T0)).toBe(true);
  });

  it('skips a check inside its interval', () => {
    const state: CheckState = { ...emptyState('c1'), lastCheckAt: new Date(T0).toISOString() };
    expect(isDue(check({ intervalMins: 5 }), state, T0 + 60_000)).toBe(false);
  });

  it('runs once the interval has elapsed', () => {
    const state: CheckState = { ...emptyState('c1'), lastCheckAt: new Date(T0).toISOString() };
    expect(isDue(check({ intervalMins: 5 }), state, T0 + 5 * 60_000)).toBe(true);
  });

  it('tolerates a cron firing early (half-interval grace)', () => {
    const state: CheckState = { ...emptyState('c1'), lastCheckAt: new Date(T0).toISOString() };
    // 4m50s after a 5m check: a strict comparison would skip this tick entirely,
    // turning a 5-minute check into a 10-minute one.
    expect(isDue(check({ intervalMins: 5 }), state, T0 + 290_000)).toBe(true);
  });

  it('runs a check whose stored timestamp is unparseable', () => {
    const state: CheckState = { ...emptyState('c1'), lastCheckAt: 'not-a-date' };
    expect(isDue(check(), state, T0)).toBe(true);
  });

  it('honours a long interval', () => {
    const state: CheckState = { ...emptyState('c1'), lastCheckAt: new Date(T0).toISOString() };
    const hourly = check({ intervalMins: 60 });
    expect(isDue(hourly, state, T0 + 20 * 60_000)).toBe(false);
    expect(isDue(hourly, state, T0 + 40 * 60_000)).toBe(true);
  });
});

describe('pooled', () => {
  it('returns results in input order', async () => {
    const out = await pooled([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await pooled(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('actually runs concurrently', async () => {
    let peak = 0;
    let inFlight = 0;
    await pooled(Array.from({ length: 6 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeGreaterThan(1);
  });

  it('handles an empty list', async () => {
    expect(await pooled([], 4, async (n) => n)).toEqual([]);
  });

  it('handles a limit larger than the input', async () => {
    expect(await pooled([1, 2], 10, async (n) => n)).toEqual([1, 2]);
  });

  it('processes every item when the limit is 1', async () => {
    const seen: number[] = [];
    await pooled([1, 2, 3], 1, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});
