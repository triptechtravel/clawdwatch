import { describe, it, expect, vi } from 'vitest';
import { rpc } from './rpc';
import { ALERT_SCHEMA_VERSION } from '../types';
import type { AlertEvent, NotifierContext } from '../types';

function opened(): AlertEvent {
  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    kind: 'opened',
    at: '2026-07-27T00:00:00.000Z',
    check: { id: 'c1', name: 'API', url: 'https://api.test', tags: [], status: 'unhealthy' },
    failure: {
      statusCode: 502,
      responseTimeMs: 12,
      assertions: ['Expected status 200, got 502'],
      consecutiveFailures: 3,
    },
    incidentId: 'inc-1',
    links: {},
  };
}

function ctxWith(env: unknown): NotifierContext<unknown> {
  return { env, resolve: (t) => t };
}

describe('rpc notifier', () => {
  it('calls the bound entrypoint with the event', async () => {
    const alert = vi.fn().mockResolvedValue(undefined);
    const env = { THINKBOT: { alert } };

    await rpc<typeof env>({ binding: (e) => e.THINKBOT }).notify(opened(), ctxWith(env));

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toMatchObject({ kind: 'opened', incidentId: 'inc-1' });
  });

  it('passes the schema version across the binding', async () => {
    // RPC skips JSON, but the receiver still needs to know what shape it has:
    // the two Workers deploy independently.
    const alert = vi.fn().mockResolvedValue(undefined);
    const env = { THINKBOT: { alert } };

    await rpc<typeof env>({ binding: (e) => e.THINKBOT }).notify(opened(), ctxWith(env));

    expect(alert.mock.calls[0][0].schemaVersion).toBe(ALERT_SCHEMA_VERSION);
  });

  it('throws when the binding is missing, so the delivery records as failed', async () => {
    // Silently succeeding here would make an unconfigured binding look like a
    // delivered alert — the exact failure the Slack notifier guards against.
    const env = {} as { THINKBOT?: { alert(e: AlertEvent): Promise<void> } };

    await expect(
      rpc<typeof env>({ binding: (e) => e.THINKBOT }).notify(opened(), ctxWith(env)),
    ).rejects.toThrow(/binding/i);
  });

  it('propagates an error thrown by the receiver', async () => {
    const env = { THINKBOT: { alert: vi.fn().mockRejectedValue(new Error('inbox exploded')) } };

    await expect(
      rpc<typeof env>({ binding: (e) => e.THINKBOT }).notify(opened(), ctxWith(env)),
    ).rejects.toThrow('inbox exploded');
  });

  it('uses a custom method name when the entrypoint names it differently', async () => {
    const handleAlert = vi.fn().mockResolvedValue(undefined);
    const env = { THINKBOT: { handleAlert } };

    await rpc<typeof env>({ binding: (e) => e.THINKBOT, method: 'handleAlert' }).notify(
      opened(),
      ctxWith(env),
    );

    expect(handleAlert).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the entrypoint lacks the expected method', async () => {
    const env = { THINKBOT: {} as { alert?: (e: AlertEvent) => Promise<void> } };

    await expect(
      rpc<typeof env>({ binding: (e) => e.THINKBOT }).notify(opened(), ctxWith(env)),
    ).rejects.toThrow(/alert/);
  });

  it('carries its name and event filter through to the dispatcher', () => {
    const n = rpc<{ X?: never }>({ binding: () => undefined, name: 'agent', on: ['opened'] });
    expect(n.name).toBe('agent');
    expect(n.on).toEqual(['opened']);
  });

  it('defaults its name to rpc', () => {
    expect(rpc<{ X?: never }>({ binding: () => undefined }).name).toBe('rpc');
  });
});
