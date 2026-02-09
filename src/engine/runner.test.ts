import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCheck, resolveCheckUrl } from './runner';
import type { CheckConfig } from '../types';

const mockFetch = vi.fn();

describe('runner', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseCheck: CheckConfig = {
    id: 'test-check',
    name: 'Test Check',
    type: 'api',
    url: 'https://example.com',
    expectedStatus: 200,
  };

  it('returns success when status matches expected', async () => {
    mockFetch.mockResolvedValue({ status: 200 });

    const result = await runCheck(baseCheck, undefined, 5000, 'clawdwatch/1.0');

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns failure when status does not match', async () => {
    mockFetch.mockResolvedValue({ status: 503 });

    const result = await runCheck(baseCheck, undefined, 5000, 'clawdwatch/1.0');

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.error).toBe('Expected status 200, got 503');
  });

  it('defaults expectedStatus to 200', async () => {
    const check: CheckConfig = { ...baseCheck, expectedStatus: undefined };
    mockFetch.mockResolvedValue({ status: 200 });

    const result = await runCheck(check, undefined, 5000, 'clawdwatch/1.0');
    expect(result.success).toBe(true);
  });

  it('handles fetch errors', async () => {
    mockFetch.mockRejectedValue(new Error('DNS resolution failed'));

    const result = await runCheck(baseCheck, undefined, 5000, 'clawdwatch/1.0');

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toBe('DNS resolution failed');
  });

  it('handles abort/timeout errors', async () => {
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));

    const result = await runCheck(baseCheck, undefined, 5000, 'clawdwatch/1.0');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Timeout after 5000ms');
  });

  it('resolves {{WORKER_URL}} placeholder', async () => {
    const check: CheckConfig = {
      ...baseCheck,
      url: '{{WORKER_URL}}/sandbox-health',
    };
    mockFetch.mockResolvedValue({ status: 200 });

    await runCheck(check, 'https://worker.example.com', 5000, 'clawdwatch/1.0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://worker.example.com/sandbox-health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('passes abort signal and user-agent header', async () => {
    mockFetch.mockResolvedValue({ status: 200 });

    await runCheck(baseCheck, undefined, 5000, 'my-app/1.0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'my-app/1.0' },
      }),
    );
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('resolveCheckUrl', () => {
  it('replaces {{WORKER_URL}} with provided URL', () => {
    expect(resolveCheckUrl('{{WORKER_URL}}/health', 'https://example.com')).toBe(
      'https://example.com/health',
    );
  });

  it('strips trailing slashes from worker URL', () => {
    expect(resolveCheckUrl('{{WORKER_URL}}/health', 'https://example.com/')).toBe(
      'https://example.com/health',
    );
  });

  it('falls back to localhost when no worker URL provided', () => {
    expect(resolveCheckUrl('{{WORKER_URL}}/health', undefined)).toBe(
      'http://localhost:8787/health',
    );
  });

  it('returns URL unchanged when no placeholder', () => {
    expect(resolveCheckUrl('https://example.com', undefined)).toBe('https://example.com');
  });
});
