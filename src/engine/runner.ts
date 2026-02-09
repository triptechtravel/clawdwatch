/**
 * Check runner — executes monitoring checks via fetch()
 * with assertion evaluation and retry support.
 *
 * v2: URL is pre-resolved by the orchestrator. Timeout, retry,
 * headers, and body all come from the CheckConfig (loaded from D1).
 */

import type { CheckConfig, CheckResult, Assertion } from '../types';

const MAX_BODY_SIZE = 64 * 1024; // 64KB max for body assertions

/**
 * Run a single check with retry support.
 * Retries only happen on failure — a passing check returns immediately.
 */
export async function runCheck(
  check: CheckConfig,
  resolvedUrl: string,
  userAgent: string,
): Promise<CheckResult> {
  let result = await executeCheck(check, resolvedUrl, userAgent);

  for (let attempt = 0; attempt < check.retry_count && !result.success; attempt++) {
    await sleep(check.retry_delay_ms);
    result = await executeCheck(check, resolvedUrl, userAgent);
  }

  return result;
}

async function executeCheck(
  check: CheckConfig,
  resolvedUrl: string,
  userAgent: string,
): Promise<CheckResult> {
  const method = check.method.toUpperCase();
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), check.timeout_ms);

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      ...check.headers,
    };

    const fetchOptions: RequestInit = {
      method,
      signal: controller.signal,
      redirect: 'follow',
      headers,
    };

    if (check.body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = check.body;
    }

    const response = await fetch(resolvedUrl, fetchOptions);
    clearTimeout(timer);
    const responseTimeMs = Date.now() - start;

    // Read body only if needed for assertions
    const needsBody = check.assertions.some((a) => a.type === 'body' || a.type === 'jsonPath');
    let body: string | null = null;
    if (needsBody) {
      body = await readBodyCapped(response);
    }

    const assertions = check.assertions.length > 0
      ? check.assertions
      : [{ type: 'statusCode' as const, operator: 'is' as const, value: 200 }];
    const failures = evaluateAssertions(assertions, response, responseTimeMs, body);

    return {
      id: check.id,
      success: failures.length === 0,
      statusCode: response.status,
      responseTimeMs,
      error: failures.length > 0 ? failures.join('; ') : null,
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
      error: isTimeout ? `Timeout after ${check.timeout_ms}ms` : message,
    };
  }
}

/**
 * Evaluate all assertions against a response. Returns an array of failure messages.
 */
export function evaluateAssertions(
  assertions: Assertion[],
  response: Response,
  responseTimeMs: number,
  body: string | null,
): string[] {
  const failures: string[] = [];

  for (const assertion of assertions) {
    switch (assertion.type) {
      case 'statusCode': {
        const actual = response.status;
        if (assertion.operator === 'is' && actual !== assertion.value) {
          failures.push(`Expected status ${assertion.value}, got ${actual}`);
        } else if (assertion.operator === 'isNot' && actual === assertion.value) {
          failures.push(`Expected status not ${assertion.value}`);
        }
        break;
      }

      case 'header': {
        const actual = response.headers.get(assertion.name);
        const failed = evaluateStringAssertion(assertion.operator, actual ?? '', assertion.value, actual === null);
        if (failed) {
          failures.push(`Header "${assertion.name}": ${failed}`);
        }
        break;
      }

      case 'body': {
        if (body === null) {
          failures.push('Body assertion requires response body but body was not read');
          break;
        }
        const failed = evaluateStringAssertion(assertion.operator, body, assertion.value, false);
        if (failed) {
          failures.push(`Body: ${failed}`);
        }
        break;
      }

      case 'responseTime': {
        if (assertion.operator === 'lessThan' && responseTimeMs >= assertion.value) {
          failures.push(`Response time ${responseTimeMs}ms >= ${assertion.value}ms`);
        }
        break;
      }

      case 'jsonPath': {
        if (body === null) {
          failures.push('jsonPath assertion requires response body but body was not read');
          break;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          failures.push(`jsonPath "${assertion.path}": body is not valid JSON`);
          break;
        }
        const extracted = resolveJsonPath(parsed, assertion.path);
        if (extracted === undefined) {
          failures.push(`jsonPath "${assertion.path}": path not found`);
          break;
        }
        const actual = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
        const failed = evaluateStringAssertion(assertion.operator, actual, assertion.value, false);
        if (failed) {
          failures.push(`jsonPath "${assertion.path}": ${failed}`);
        }
        break;
      }
    }
  }

  return failures;
}

function evaluateStringAssertion(
  operator: string,
  actual: string,
  expected: string,
  missing: boolean,
): string | null {
  switch (operator) {
    case 'is':
      if (actual !== expected) return `expected "${expected}", got "${actual}"`;
      break;
    case 'isNot':
      if (actual === expected) return `expected not "${expected}"`;
      break;
    case 'contains':
      if (missing || !actual.includes(expected)) return `expected to contain "${expected}"`;
      break;
    case 'notContains':
      if (actual.includes(expected)) return `expected not to contain "${expected}"`;
      break;
    case 'matches': {
      const regex = new RegExp(expected);
      if (!regex.test(actual)) return `expected to match /${expected}/`;
      break;
    }
  }
  return null;
}

/**
 * Resolve a simple JSON path ($.foo.bar, $.items[0].id) against an object.
 * Returns undefined for missing paths. No wildcards or recursive descent.
 */
function resolveJsonPath(obj: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined;
  const rest = path.slice(1); // strip leading $
  if (rest === '' || rest === '.') return obj;

  // Split into segments: .foo, [0], .bar
  const segments = rest.match(/\.([^.[]+)|\[(\d+)]/g);
  if (!segments) return undefined;

  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (seg.startsWith('[')) {
      const index = parseInt(seg.slice(1, -1), 10);
      if (!Array.isArray(current)) return undefined;
      if (index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      // .fieldName
      const key = seg.slice(1);
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  while (totalSize < MAX_BODY_SIZE) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalSize += value.length;
  }

  reader.releaseLock();
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
