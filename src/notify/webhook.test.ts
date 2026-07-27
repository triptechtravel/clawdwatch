import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  webhook,
  hmac,
  serviceToken,
  combineAuth,
  signPayload,
  verifySignature,
  timingSafeEqual,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from './webhook';
import type { AlertEvent, NotifierContext } from '../types';

const ctx: NotifierContext<unknown> = { env: {}, resolve: (t) => t };
const NOW = Date.parse('2026-07-27T00:00:00.000Z');

function opened(): AlertEvent {
  return {
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
    links: { ack: 'https://mon.test/api/incidents/inc-1/ack' },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('payload', () => {
  it('POSTs the raw AlertEvent including its links', async () => {
    await webhook({ url: 'https://agent.test/hooks' }).notify(opened(), ctx);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://agent.test/hooks');
    const body = JSON.parse(init.body);
    expect(body.kind).toBe('opened');
    // The links are what let an agent act with no pre-installed knowledge.
    expect(body.links.ack).toBe('https://mon.test/api/incidents/inc-1/ack');
  });

  it('resolves a secret reference in the URL', async () => {
    const resolving: NotifierContext<unknown> = {
      env: {},
      resolve: (t) => t.replace('${AGENT_INBOX_URL}', 'https://agent.test/real'),
    };
    await webhook({ url: '${AGENT_INBOX_URL}' }).notify(opened(), resolving);
    expect(fetchMock.mock.calls[0][0]).toBe('https://agent.test/real');
  });

  it('throws on a non-2xx so a broken inbox is visible', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(
      webhook({ url: 'https://agent.test/hooks' }).notify(opened(), ctx),
    ).rejects.toThrow('500');
  });

  it('sends no signature headers when unauthenticated', async () => {
    await webhook({ url: 'https://agent.test/hooks' }).notify(opened(), ctx);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();
    expect(headers[TIMESTAMP_HEADER]).toBeUndefined();
  });
});

describe('hmac auth', () => {
  it('signs the body and sends both headers', async () => {
    await webhook({
      url: 'https://agent.test/hooks',
      auth: hmac('shhh-very-secret'),
      now: () => NOW,
    }).notify(opened(), ctx);

    const { headers, body } = fetchMock.mock.calls[0][1];
    expect(headers[TIMESTAMP_HEADER]).toBe(String(NOW));
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const ok = await verifySignature({
      secret: 'shhh-very-secret',
      body,
      signature: headers[SIGNATURE_HEADER],
      timestamp: headers[TIMESTAMP_HEADER],
      now: NOW,
    });
    expect(ok).toBe(true);
  });

  it('resolves a secret reference for the signing key', async () => {
    const resolving: NotifierContext<unknown> = {
      env: {},
      resolve: (t) => t.replace('${HOOK_SECRET}', 'resolved-signing-key'),
    };
    await webhook({
      url: 'https://agent.test/hooks',
      auth: hmac('${HOOK_SECRET}'),
      now: () => NOW,
    }).notify(opened(), resolving);

    const { headers, body } = fetchMock.mock.calls[0][1];
    expect(
      await verifySignature({
        secret: 'resolved-signing-key',
        body,
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
        now: NOW,
      }),
    ).toBe(true);
  });

  it('signs timestamp and body together, so a replayed body fails', async () => {
    const sig = await signPayload('k', String(NOW), '{"a":1}');
    expect(
      await verifySignature({
        secret: 'k',
        body: '{"a":1}',
        signature: sig,
        timestamp: String(NOW + 1),
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('verifySignature', () => {
  const body = '{"kind":"opened"}';

  async function sign(now = NOW, secret = 'k') {
    return { sig: await signPayload(secret, String(now), body), ts: String(now) };
  }

  it('accepts a valid signature', async () => {
    const { sig, ts } = await sign();
    expect(
      await verifySignature({ secret: 'k', body, signature: sig, timestamp: ts, now: NOW }),
    ).toBe(true);
  });

  it('rejects the wrong secret', async () => {
    const { sig, ts } = await sign();
    expect(
      await verifySignature({ secret: 'other', body, signature: sig, timestamp: ts, now: NOW }),
    ).toBe(false);
  });

  it('rejects a tampered body', async () => {
    const { sig, ts } = await sign();
    expect(
      await verifySignature({
        secret: 'k',
        body: '{"kind":"recovered"}',
        signature: sig,
        timestamp: ts,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp (replay)', async () => {
    const { sig, ts } = await sign(NOW - 10 * 60_000);
    expect(
      await verifySignature({ secret: 'k', body, signature: sig, timestamp: ts, now: NOW }),
    ).toBe(false);
  });

  it('accepts within the tolerance window', async () => {
    const { sig, ts } = await sign(NOW - 60_000);
    expect(
      await verifySignature({ secret: 'k', body, signature: sig, timestamp: ts, now: NOW }),
    ).toBe(true);
  });

  it('rejects missing headers', async () => {
    expect(
      await verifySignature({ secret: 'k', body, signature: null, timestamp: null, now: NOW }),
    ).toBe(false);
  });

  it('rejects a non-numeric timestamp', async () => {
    const { sig } = await sign();
    expect(
      await verifySignature({ secret: 'k', body, signature: sig, timestamp: 'soon', now: NOW }),
    ).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares equal and unequal strings correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('serviceToken auth', () => {
  it('attaches the Access headers', async () => {
    await webhook({
      url: 'https://agent.test/hooks',
      auth: serviceToken('client-id.access', 'client-secret'),
    }).notify(opened(), ctx);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['CF-Access-Client-Id']).toBe('client-id.access');
    expect(headers['CF-Access-Client-Secret']).toBe('client-secret');
  });

  it('resolves secret references in the token pair', async () => {
    const resolving: NotifierContext<unknown> = {
      env: {},
      resolve: (t) =>
        t.replace('${CF_ACCESS_CLIENT_ID}', 'real-id').replace('${CF_ACCESS_CLIENT_SECRET}', 'real-secret'),
    };
    await webhook({
      url: 'https://agent.test/hooks',
      auth: serviceToken('${CF_ACCESS_CLIENT_ID}', '${CF_ACCESS_CLIENT_SECRET}'),
    }).notify(opened(), resolving);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['CF-Access-Client-Id']).toBe('real-id');
    expect(headers['CF-Access-Client-Secret']).toBe('real-secret');
  });
});

describe('combineAuth', () => {
  it('applies Access headers and HMAC together', async () => {
    await webhook({
      url: 'https://agent.test/hooks',
      auth: combineAuth(serviceToken('id', 'secret'), hmac('signing-key')),
      now: () => NOW,
    }).notify(opened(), ctx);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['CF-Access-Client-Id']).toBe('id');
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=/);
  });
});
