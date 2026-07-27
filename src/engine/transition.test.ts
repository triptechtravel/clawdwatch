import { describe, it, expect } from 'vitest';
import { computeTransition, emptyState } from './transition';
import type { CheckConfig, CheckResult, CheckState } from '../types';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-27T00:00:00.000Z');

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
    reminderIntervalMs: HOUR,
    intervalMins: 5,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

function ok(at: number): CheckResult {
  return {
    checkId: 'c1',
    success: true,
    statusCode: 200,
    responseTimeMs: 120,
    error: null,
    ranAt: new Date(at).toISOString(),
  };
}

function fail(at: number, error = 'Expected status 200, got 502'): CheckResult {
  return {
    checkId: 'c1',
    success: false,
    statusCode: 502,
    responseTimeMs: 300,
    error,
    ranAt: new Date(at).toISOString(),
  };
}

/** Drive a sequence of results, returning the states and transitions. */
function run(results: Array<[CheckResult, number]>, cfg = check()) {
  let state: CheckState = emptyState('c1');
  const transitions = [];
  for (const [result, now] of results) {
    const step = computeTransition(state, result, cfg, now, `inc-${now}`);
    state = step.state;
    transitions.push(step.transition);
  }
  return { state, transitions };
}

describe('happy path', () => {
  it('first success moves unknown → healthy silently', () => {
    const { state, transitions } = run([[ok(T0), T0]]);
    expect(state.status).toBe('healthy');
    expect(transitions[0]).toEqual({ kind: 'none' });
  });

  it('stays healthy and silent while passing', () => {
    const { state, transitions } = run([
      [ok(T0), T0],
      [ok(T0 + 60_000), T0 + 60_000],
    ]);
    expect(state.status).toBe('healthy');
    expect(transitions.every((t) => t.kind === 'none')).toBe(true);
  });
});

describe('opening an incident', () => {
  it('degrades silently below the threshold', () => {
    const { state, transitions } = run([
      [ok(T0), T0],
      [fail(T0 + 1000), T0 + 1000],
      [fail(T0 + 2000), T0 + 2000],
    ]);
    expect(state.status).toBe('degraded');
    expect(state.consecutiveFailures).toBe(2);
    expect(transitions.map((t) => t.kind)).toEqual(['none', 'none', 'none']);
  });

  it('opens exactly at the threshold', () => {
    const { state, transitions } = run([
      [fail(T0), T0],
      [fail(T0 + 1000), T0 + 1000],
      [fail(T0 + 2000), T0 + 2000],
    ]);
    expect(state.status).toBe('unhealthy');
    expect(transitions[2]).toEqual({ kind: 'opened' });
    expect(state.incidentId).toBe(`inc-${T0 + 2000}`);
    expect(state.downSince).toBe(new Date(T0 + 2000).toISOString());
  });

  it('opens on the first failure when the threshold is 1', () => {
    const { transitions } = run([[fail(T0), T0]], check({ failureThreshold: 1 }));
    expect(transitions[0]).toEqual({ kind: 'opened' });
  });

  it('opens only once while failing continuously', () => {
    const { transitions } = run(
      [
        [fail(T0), T0],
        [fail(T0 + 1000), T0 + 1000],
        [fail(T0 + 2000), T0 + 2000],
        [fail(T0 + 3000), T0 + 3000],
        [fail(T0 + 4000), T0 + 4000],
      ],
      check({ reminderIntervalMs: null }),
    );
    expect(transitions.filter((t) => t.kind === 'opened')).toHaveLength(1);
  });

  it('carries the failure message into state', () => {
    const { state } = run([[fail(T0, 'Timeout after 10000ms'), T0]], check({ failureThreshold: 1 }));
    expect(state.lastError).toBe('Timeout after 10000ms');
  });
});

describe('reminders', () => {
  const cfg = check({ failureThreshold: 1, reminderIntervalMs: HOUR });

  it('stays silent before the interval elapses', () => {
    const { transitions } = run(
      [
        [fail(T0), T0],
        [fail(T0 + 30 * 60_000), T0 + 30 * 60_000],
      ],
      cfg,
    );
    expect(transitions.map((t) => t.kind)).toEqual(['opened', 'none']);
  });

  it('fires once the interval has elapsed', () => {
    const { transitions } = run(
      [
        [fail(T0), T0],
        [fail(T0 + HOUR), T0 + HOUR],
      ],
      cfg,
    );
    expect(transitions[1]).toEqual({ kind: 'reminder', downSinceMs: HOUR });
  });

  it('re-arms so a long outage reminds repeatedly', () => {
    const { transitions } = run(
      [
        [fail(T0), T0],
        [fail(T0 + HOUR), T0 + HOUR],
        [fail(T0 + HOUR + 60_000), T0 + HOUR + 60_000],
        [fail(T0 + 2 * HOUR), T0 + 2 * HOUR],
      ],
      cfg,
    );
    expect(transitions.map((t) => t.kind)).toEqual(['opened', 'reminder', 'none', 'reminder']);
  });

  it('never reminds when reminders are disabled', () => {
    const { transitions } = run(
      [
        [fail(T0), T0],
        [fail(T0 + 10 * HOUR), T0 + 10 * HOUR],
      ],
      check({ failureThreshold: 1, reminderIntervalMs: null }),
    );
    expect(transitions.map((t) => t.kind)).toEqual(['opened', 'none']);
  });

  it('reports downtime from the original failure, not the last reminder', () => {
    const { transitions } = run(
      [
        [fail(T0), T0],
        [fail(T0 + HOUR), T0 + HOUR],
        [fail(T0 + 2 * HOUR), T0 + 2 * HOUR],
      ],
      cfg,
    );
    expect(transitions[2]).toEqual({ kind: 'reminder', downSinceMs: 2 * HOUR });
  });
});

describe('recovery', () => {
  it('recovers from unhealthy with the downtime measured', () => {
    const { state, transitions } = run(
      [
        [fail(T0), T0],
        [ok(T0 + 90 * 60_000), T0 + 90 * 60_000],
      ],
      check({ failureThreshold: 1 }),
    );
    expect(transitions[1]).toEqual({ kind: 'recovered', downtimeMs: 90 * 60_000 });
    expect(state.status).toBe('healthy');
  });

  it('clears incident bookkeeping on recovery', () => {
    const { state } = run(
      [
        [fail(T0), T0],
        [ok(T0 + 1000), T0 + 1000],
      ],
      check({ failureThreshold: 1 }),
    );
    expect(state.downSince).toBeNull();
    expect(state.lastAlertAt).toBeNull();
    expect(state.incidentId).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it('is silent when recovering from degraded (never opened)', () => {
    const { transitions } = run([
      [fail(T0), T0],
      [fail(T0 + 1000), T0 + 1000],
      [ok(T0 + 2000), T0 + 2000],
    ]);
    expect(transitions.map((t) => t.kind)).toEqual(['none', 'none', 'none']);
  });

  it('can open again after recovering (flap)', () => {
    const cfg = check({ failureThreshold: 1 });
    const { transitions } = run(
      [
        [fail(T0), T0],
        [ok(T0 + 1000), T0 + 1000],
        [fail(T0 + 2000), T0 + 2000],
      ],
      cfg,
    );
    expect(transitions.map((t) => t.kind)).toEqual(['opened', 'recovered', 'opened']);
  });
});

describe('robustness', () => {
  it('does not report negative downtime if the clock goes backwards', () => {
    const state: CheckState = {
      ...emptyState('c1'),
      status: 'unhealthy',
      consecutiveFailures: 3,
      downSince: new Date(T0 + HOUR).toISOString(),
      lastAlertAt: new Date(T0 + HOUR).toISOString(),
      incidentId: 'inc-1',
    };
    const step = computeTransition(state, ok(T0), check(), T0, 'inc-2');
    expect(step.transition).toEqual({ kind: 'recovered', downtimeMs: 0 });
  });

  it('recovers cleanly even if downSince was never recorded', () => {
    const state: CheckState = {
      ...emptyState('c1'),
      status: 'unhealthy',
      consecutiveFailures: 3,
      incidentId: 'inc-1',
    };
    const step = computeTransition(state, ok(T0), check(), T0, 'inc-2');
    expect(step.transition).toEqual({ kind: 'recovered', downtimeMs: 0 });
  });

  it('does not mutate the state it was given', () => {
    const before = emptyState('c1');
    const snapshot = JSON.stringify(before);
    computeTransition(before, fail(T0), check(), T0, 'inc-1');
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
