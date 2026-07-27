/**
 * Assertion evaluation.
 *
 * Carried over from v2 largely intact — this is the well-tested core. The
 * change is that failure messages are truncated on the way out, because they
 * are the only part of a response that is ever persisted.
 */

import type { Assertion } from '../types';
import { truncateError } from './secrets';

/** Response bodies are read up to this size for body/jsonPath assertions. */
export const MAX_BODY_SIZE = 512 * 1024;

/** Applied when a check declares no assertions of its own. */
export const DEFAULT_ASSERTION: Assertion = { type: 'statusCode', operator: 'is', value: 200 };

/**
 * Evaluate assertions against a response. Returns failure messages; an empty
 * array means the check passed.
 */
export function evaluateAssertions(
  assertions: Assertion[],
  response: { status: number; headers: Headers },
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
        const failed = evaluateStringAssertion(
          assertion.operator,
          actual ?? '',
          assertion.value,
          actual === null,
        );
        if (failed) failures.push(`Header "${assertion.name}": ${failed}`);
        break;
      }

      case 'body': {
        if (body === null) {
          failures.push('Body assertion requires the response body, which was not read');
          break;
        }
        const failed = evaluateStringAssertion(assertion.operator, body, assertion.value, false);
        if (failed) failures.push(`Body: ${failed}`);
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
          failures.push('jsonPath assertion requires the response body, which was not read');
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

        if (assertion.operator === 'lessThan' || assertion.operator === 'greaterThan') {
          const numActual = Number(actual);
          const numExpected = Number(assertion.value);
          if (Number.isNaN(numActual) || Number.isNaN(numExpected)) {
            failures.push(`jsonPath "${assertion.path}": cannot compare non-numeric values`);
          } else if (assertion.operator === 'lessThan' && numActual >= numExpected) {
            failures.push(`jsonPath "${assertion.path}": ${numActual} >= ${numExpected}`);
          } else if (assertion.operator === 'greaterThan' && numActual <= numExpected) {
            failures.push(`jsonPath "${assertion.path}": ${numActual} <= ${numExpected}`);
          }
        } else {
          const failed = evaluateStringAssertion(assertion.operator, actual, assertion.value, false);
          if (failed) failures.push(`jsonPath "${assertion.path}": ${failed}`);
        }
        break;
      }
    }
  }

  return failures.map(truncateError);
}

export function evaluateStringAssertion(
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
      let regex: RegExp;
      try {
        regex = new RegExp(expected);
      } catch {
        return `invalid regex /${expected}/`;
      }
      if (!regex.test(actual)) return `expected to match /${expected}/`;
      break;
    }
  }
  return null;
}

/**
 * Resolve a simple JSON path (`$.foo.bar`, `$.items[0].id`). Returns undefined
 * for a missing path. No wildcards, no recursive descent — deliberately small.
 */
export function resolveJsonPath(obj: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined;
  const rest = path.slice(1);
  if (rest === '' || rest === '.') return obj;

  const segments = rest.match(/\.([^.[]+)|\[(\d+)]/g);
  if (!segments) return undefined;

  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (seg.startsWith('[')) {
      const index = Number.parseInt(seg.slice(1, -1), 10);
      if (!Array.isArray(current)) return undefined;
      if (index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      const key = seg.slice(1);
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

/**
 * Read a response body up to MAX_BODY_SIZE.
 *
 * The cap is byte-exact, not chunk-granular: a single oversized chunk is
 * sliced rather than accepted whole, so a huge response can't blow the
 * isolate's memory just because it arrived in one piece.
 */
export async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < MAX_BODY_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_BODY_SIZE - total;
      if (value.length > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = MAX_BODY_SIZE;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}
