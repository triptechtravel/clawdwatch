import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCheck, type RunnerContext } from './runner';
import type { CheckConfig, HeaderRule, SecretMap } from '../types';

const SECRETS: SecretMap = {
  HEALTHCHECK_SECRET: 'hc-super-secret-value',
  WAF_BYPASS_SECRET: 'waf-bypass-token-123',
};

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

function ctx(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    resolvedUrl: 'https://api.example.com/health',
    headerRules: [],
    secrets: SECRETS,
    userAgent: 'clawdwatch/3.0',
    now: () => Date.now(),
    ...overrides,
  };
}

function respond(status: number, body = '', headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('basic execution', () => {
  it('passes with the default status-200 assertion', async () => {
    fetchMock.mockResolvedValue(respond(200));
    const result = await runCheck(check(), ctx());
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
  });

  it('fails when the default assertion is not met', async () => {
    fetchMock.mockResolvedValue(respond(502));
    const result = await runCheck(check(), ctx());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Expected status 200, got 502');
  });

  it('uses the configured method and sends a body', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await runCheck(check({ method: 'POST', body: '{"q":1}' }), ctx());
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"q":1}');
  });

  it('never sends a body on GET', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await runCheck(check({ body: '{"q":1}' }), ctx());
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('fetches the resolved URL, not the stored template', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await runCheck(
      check({ url: '{{WORKER_URL}}/health' }),
      ctx({ resolvedUrl: 'https://live.example.com/health' }),
    );
    expect(fetchMock.mock.calls[0][0]).toBe('https://live.example.com/health');
  });

  it('reports a network error as a failure', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const result = await runCheck(check(), ctx());
    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toBe('connection refused');
  });

  it('labels an abort as a timeout', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));
    const result = await runCheck(check({ timeoutMs: 1234 }), ctx());
    expect(result.error).toBe('Timeout after 1234ms');
  });

  it('only reads the body when an assertion needs it', async () => {
    const body = new Response('{"ok":true}');
    const spy = vi.spyOn(body, 'body', 'get');
    fetchMock.mockResolvedValue(body);
    await runCheck(check(), ctx());
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads the body for a jsonPath assertion', async () => {
    fetchMock.mockResolvedValue(respond(200, '{"status":"healthy"}'));
    const result = await runCheck(
      check({
        assertions: [{ type: 'jsonPath', path: '$.status', operator: 'is', value: 'healthy' }],
      }),
      ctx(),
    );
    expect(result.success).toBe(true);
  });
});

describe('secret handling', () => {
  it('resolves a secret reference into the outbound header', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await runCheck(check({ headers: { 'X-Healthcheck-Secret': '${HEALTHCHECK_SECRET}' } }), ctx());
    expect(fetchMock.mock.calls[0][1].headers['X-Healthcheck-Secret']).toBe(
      'hc-super-secret-value',
    );
  });

  it('applies a matching host rule', async () => {
    const rules: HeaderRule[] = [
      { host: /(^|\.)example\.com$/, headers: { 'x-waf-bypass': '${WAF_BYPASS_SECRET}' } },
    ];
    fetchMock.mockResolvedValue(respond(200));
    await runCheck(check(), ctx({ headerRules: rules }));
    expect(fetchMock.mock.calls[0][1].headers['x-waf-bypass']).toBe('waf-bypass-token-123');
  });

  it('does not leak a resolved secret into the result', async () => {
    fetchMock.mockResolvedValue(respond(500, 'hc-super-secret-value'));
    const result = await runCheck(
      check({ headers: { 'X-Key': '${HEALTHCHECK_SECRET}' } }),
      ctx(),
    );
    expect(JSON.stringify(result)).not.toContain('hc-super-secret-value');
  });

  it('turns an unresolved reference into a check failure, not a throw', async () => {
    fetchMock.mockResolvedValue(respond(200));
    const result = await runCheck(check({ headers: { 'X-Key': '${MISSING}' } }), ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain('MISSING');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the default user agent', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await runCheck(check(), ctx());
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toBe('clawdwatch/3.0');
  });
});

describe('retries', () => {
  it('does not retry a passing check', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await runCheck(check({ retryCount: 2 }), ctx());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries up to retryCount on failure', async () => {
    fetchMock.mockResolvedValue(respond(502));
    const result = await runCheck(check({ retryCount: 2 }), ctx());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
  });

  it('stops retrying as soon as one attempt passes', async () => {
    fetchMock.mockResolvedValueOnce(respond(502)).mockResolvedValue(respond(200));
    const result = await runCheck(check({ retryCount: 3 }), ctx());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it('retries a transient network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('reset')).mockResolvedValue(respond(200));
    const result = await runCheck(check({ retryCount: 1 }), ctx());
    expect(result.success).toBe(true);
  });
});

describe('timing', () => {
  it('measures response time from the injected clock', async () => {
    fetchMock.mockResolvedValue(respond(200));
    let t = 1000;
    const result = await runCheck(
      check(),
      ctx({
        now: () => {
          const v = t;
          t += 250;
          return v;
        },
      }),
    );
    expect(result.responseTimeMs).toBe(250);
  });

  it('never reports a negative duration', async () => {
    fetchMock.mockResolvedValue(respond(200));
    let first = true;
    const result = await runCheck(
      check(),
      ctx({
        now: () => {
          if (first) {
            first = false;
            return 5000;
          }
          return 1000;
        },
      }),
    );
    expect(result.responseTimeMs).toBe(0);
  });
});
