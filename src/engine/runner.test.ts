import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCheck, evaluateAssertions } from './runner';
import type { CheckConfig, Assertion } from '../types';

const mockFetch = vi.fn();

function mockResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
} = {}) {
  const { status = 200, headers = {}, body = '' } = opts;
  return {
    status,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

/** Full CheckConfig with sensible defaults for tests */
function makeCheck(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    id: 'test-check',
    name: 'Test Check',
    type: 'api',
    url: 'https://example.com',
    method: 'GET',
    headers: {},
    body: null,
    assertions: [{ type: 'statusCode', operator: 'is', value: 200 }],
    retry_count: 0,
    retry_delay_ms: 300,
    timeout_ms: 5000,
    failure_threshold: 2,
    tags: [],
    group_id: null,
    regions: ['default'],
    enabled: true,
    ...overrides,
  };
}

describe('runner', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    mockFetch.mockClear();
  });

  const baseCheck = makeCheck();

  it('returns success with default assertion (status 200)', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 200 }));

    const result = await runCheck(baseCheck, 'https://example.com', 'clawdwatch/2.0');

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
  });

  it('returns failure when default assertion fails', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 503 }));

    const result = await runCheck(baseCheck, 'https://example.com', 'clawdwatch/2.0');

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.error).toBe('Expected status 200, got 503');
  });

  it('uses configured method', async () => {
    mockFetch.mockResolvedValue(mockResponse());
    const check = makeCheck({ method: 'POST' });

    await runCheck(check, 'https://example.com', 'clawdwatch/2.0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('defaults method to GET', async () => {
    mockFetch.mockResolvedValue(mockResponse());

    await runCheck(baseCheck, 'https://example.com', 'clawdwatch/2.0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses custom assertions instead of default', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 201 }));
    const check = makeCheck({
      assertions: [{ type: 'statusCode', operator: 'is', value: 201 }],
    });

    const result = await runCheck(check, 'https://example.com', 'clawdwatch/2.0');
    expect(result.success).toBe(true);
  });

  it('reports multiple assertion failures', async () => {
    mockFetch.mockResolvedValue(mockResponse({
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    const check = makeCheck({
      assertions: [
        { type: 'statusCode', operator: 'is', value: 200 },
        { type: 'header', name: 'content-type', operator: 'is', value: 'text/html' },
      ],
    });

    const result = await runCheck(check, 'https://example.com', 'clawdwatch/2.0');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Expected status 200, got 503');
    expect(result.error).toContain('Header "content-type"');
  });

  it('handles fetch errors', async () => {
    mockFetch.mockRejectedValue(new Error('DNS resolution failed'));

    const result = await runCheck(baseCheck, 'https://example.com', 'clawdwatch/2.0');

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toBe('DNS resolution failed');
  });

  it('handles abort/timeout errors', async () => {
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));

    const result = await runCheck(baseCheck, 'https://example.com', 'clawdwatch/2.0');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Timeout after 5000ms');
  });

  it('passes user-agent and custom headers', async () => {
    mockFetch.mockResolvedValue(mockResponse());
    const check = makeCheck({
      headers: { 'Accept': 'application/json' },
    });

    await runCheck(check, 'https://example.com', 'my-app/1.0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'my-app/1.0', 'Accept': 'application/json' },
      }),
    );
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends body for POST requests', async () => {
    mockFetch.mockResolvedValue(mockResponse());
    const check = makeCheck({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test": true}',
    });

    await runCheck(check, 'https://example.com', 'clawdwatch/2.0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        method: 'POST',
        body: '{"test": true}',
      }),
    );
  });

  it('does not send body for GET requests', async () => {
    mockFetch.mockResolvedValue(mockResponse());
    const check = makeCheck({ body: 'should-be-ignored' });

    await runCheck(check, 'https://example.com', 'clawdwatch/2.0');

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.body).toBeUndefined();
  });

  describe('retry', () => {
    it('retries on failure up to configured count', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ status: 503 }))
        .mockResolvedValueOnce(mockResponse({ status: 503 }))
        .mockResolvedValueOnce(mockResponse({ status: 200 }));

      const check = makeCheck({ retry_count: 2, retry_delay_ms: 0 });
      const result = await runCheck(check, 'https://example.com', 'clawdwatch/2.0');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('does not retry on success', async () => {
      mockFetch.mockResolvedValue(mockResponse({ status: 200 }));

      const check = makeCheck({ retry_count: 3, retry_delay_ms: 0 });
      const result = await runCheck(check, 'https://example.com', 'clawdwatch/2.0');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns last failure when all retries exhausted', async () => {
      mockFetch.mockResolvedValue(mockResponse({ status: 503 }));

      const check = makeCheck({ retry_count: 1, retry_delay_ms: 0 });
      const result = await runCheck(check, 'https://example.com', 'clawdwatch/2.0');

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2); // initial + 1 retry
    });

    it('does not retry by default', async () => {
      mockFetch.mockResolvedValue(mockResponse({ status: 503 }));

      const result = await runCheck(baseCheck, 'https://example.com', 'clawdwatch/2.0');

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('evaluateAssertions', () => {
  function fakeResponse(opts: {
    status?: number;
    headers?: Record<string, string>;
  } = {}) {
    return {
      status: opts.status ?? 200,
      headers: new Headers(opts.headers ?? {}),
    } as unknown as Response;
  }

  describe('statusCode', () => {
    it('passes when status matches', () => {
      const assertions: Assertion[] = [{ type: 'statusCode', operator: 'is', value: 200 }];
      expect(evaluateAssertions(assertions, fakeResponse({ status: 200 }), 100, null)).toEqual([]);
    });

    it('fails when status does not match', () => {
      const assertions: Assertion[] = [{ type: 'statusCode', operator: 'is', value: 200 }];
      const failures = evaluateAssertions(assertions, fakeResponse({ status: 503 }), 100, null);
      expect(failures).toEqual(['Expected status 200, got 503']);
    });

    it('supports isNot operator', () => {
      const assertions: Assertion[] = [{ type: 'statusCode', operator: 'isNot', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse({ status: 200 }), 100, null)).toEqual([]);
      expect(evaluateAssertions(assertions, fakeResponse({ status: 500 }), 100, null)).toHaveLength(1);
    });
  });

  describe('header', () => {
    const response = fakeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' } });

    it('passes with is operator', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'is', value: 'text/html; charset=utf-8' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });

    it('fails with is operator on mismatch', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'is', value: 'application/json' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toHaveLength(1);
    });

    it('passes with contains operator', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'contains', value: 'text/html' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });

    it('fails when header is missing', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'x-custom', operator: 'contains', value: 'foo' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toHaveLength(1);
    });

    it('supports matches operator (regex)', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'matches', value: 'text/html.*utf-8' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });

    it('supports notContains operator', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'notContains', value: 'json' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });
  });

  describe('body', () => {
    it('passes with contains operator', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'contains', value: 'hello' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, 'hello world')).toEqual([]);
    });

    it('fails when body does not contain value', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'contains', value: 'missing' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, 'hello world')).toHaveLength(1);
    });

    it('supports notContains operator', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'notContains', value: 'error' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, 'all good')).toEqual([]);
    });

    it('supports matches operator (regex)', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'matches', value: '<title>.*</title>' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, '<title>Hello</title>')).toEqual([]);
    });

    it('fails when body is null', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'contains', value: 'hello' }];
      const failures = evaluateAssertions(assertions, fakeResponse(), 100, null);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('body was not read');
    });
  });

  describe('responseTime', () => {
    it('passes when under threshold', () => {
      const assertions: Assertion[] = [{ type: 'responseTime', operator: 'lessThan', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, null)).toEqual([]);
    });

    it('fails when over threshold', () => {
      const assertions: Assertion[] = [{ type: 'responseTime', operator: 'lessThan', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse(), 600, null)).toHaveLength(1);
    });

    it('fails when exactly at threshold', () => {
      const assertions: Assertion[] = [{ type: 'responseTime', operator: 'lessThan', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse(), 500, null)).toHaveLength(1);
    });
  });

  describe('multiple assertions', () => {
    it('all pass', () => {
      const assertions: Assertion[] = [
        { type: 'statusCode', operator: 'is', value: 200 },
        { type: 'header', name: 'content-type', operator: 'contains', value: 'html' },
        { type: 'responseTime', operator: 'lessThan', value: 1000 },
      ];
      const response = fakeResponse({ status: 200, headers: { 'content-type': 'text/html' } });
      expect(evaluateAssertions(assertions, response, 50, null)).toEqual([]);
    });

    it('collects all failures', () => {
      const assertions: Assertion[] = [
        { type: 'statusCode', operator: 'is', value: 200 },
        { type: 'responseTime', operator: 'lessThan', value: 100 },
      ];
      const response = fakeResponse({ status: 503 });
      const failures = evaluateAssertions(assertions, response, 500, null);
      expect(failures).toHaveLength(2);
    });
  });
});
