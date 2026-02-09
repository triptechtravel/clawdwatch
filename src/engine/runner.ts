/**
 * Check runner — executes monitoring checks via fetch()
 */

import type { CheckConfig, CheckResult } from '../types';

/**
 * Resolve {{WORKER_URL}} placeholders in check URLs
 */
export function resolveCheckUrl(url: string, workerUrl: string | undefined): string {
  if (!workerUrl) {
    return url.replace('{{WORKER_URL}}', 'http://localhost:8787');
  }
  return url.replace('{{WORKER_URL}}', workerUrl.replace(/\/+$/, ''));
}

export async function runCheck(
  check: CheckConfig,
  workerUrl: string | undefined,
  timeoutMs: number,
  userAgent: string,
): Promise<CheckResult> {
  const url = resolveCheckUrl(check.url, workerUrl);
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': userAgent },
    });

    clearTimeout(timer);

    const responseTimeMs = Date.now() - start;
    const expectedStatus = check.expectedStatus ?? 200;
    const success = response.status === expectedStatus;

    return {
      id: check.id,
      success,
      statusCode: response.status,
      responseTimeMs,
      error: success ? null : `Expected status ${expectedStatus}, got ${response.status}`,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Unknown error';
    const isTimeout = message.includes('abort');

    return {
      id: check.id,
      success: false,
      statusCode: null,
      responseTimeMs,
      error: isTimeout ? `Timeout after ${timeoutMs}ms` : message,
    };
  }
}
