/**
 * Executes a single check: build the request (resolving secrets), fetch,
 * evaluate assertions, retry on failure.
 *
 * Secret values exist only inside this module's call stack — they enter via
 * `buildRequestHeaders` and leave via `fetch`. Nothing they touch is returned:
 * a CheckResult carries only status, timing, and assertion messages.
 */

import type { CheckConfig, CheckResult, HeaderRule, SecretMap } from '../types';
import { needsBody } from '../types';
import { buildRequestHeaders, truncateError, UnresolvedSecretError } from './secrets';
import { DEFAULT_ASSERTION, evaluateAssertions, readBodyCapped } from './assertions';

export interface RunnerContext {
  resolvedUrl: string;
  headerRules: HeaderRule[];
  secrets: SecretMap;
  userAgent: string;
  now: () => number;
}

/** Run a check, retrying on failure up to `retryCount` times. */
export async function runCheck(check: CheckConfig, ctx: RunnerContext): Promise<CheckResult> {
  let result = await executeOnce(check, ctx);

  for (let attempt = 0; attempt < check.retryCount && !result.success; attempt++) {
    if (check.retryDelayMs > 0) await sleep(check.retryDelayMs);
    result = await executeOnce(check, ctx);
  }

  return result;
}

async function executeOnce(check: CheckConfig, ctx: RunnerContext): Promise<CheckResult> {
  const method = check.method.toUpperCase();
  const started = ctx.now();

  const finish = (
    partial: Pick<CheckResult, 'success' | 'statusCode' | 'error'>,
  ): CheckResult => ({
    checkId: check.id,
    responseTimeMs: Math.max(0, ctx.now() - started),
    ranAt: new Date(started).toISOString(),
    ...partial,
  });

  let headers: Record<string, string>;
  try {
    headers = buildRequestHeaders(
      check,
      ctx.resolvedUrl,
      ctx.headerRules,
      ctx.secrets,
      ctx.userAgent,
    );
  } catch (err) {
    // A misconfigured secret is a check failure, not a crash — one bad check
    // must not take down the whole run.
    const message =
      err instanceof UnresolvedSecretError ? err.message : `Header resolution failed: ${err}`;
    return finish({ success: false, statusCode: null, error: truncateError(message) });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs);

  try {
    const init: RequestInit = {
      method,
      headers,
      redirect: 'follow',
      signal: controller.signal,
    };
    if (check.body && method !== 'GET' && method !== 'HEAD') init.body = check.body;

    const response = await fetch(ctx.resolvedUrl, init);
    const responseTimeMs = Math.max(0, ctx.now() - started);

    const assertions = check.assertions.length > 0 ? check.assertions : [DEFAULT_ASSERTION];
    const body = needsBody(assertions) ? await readBodyCapped(response) : null;

    const failures = evaluateAssertions(assertions, response, responseTimeMs, body);

    return {
      checkId: check.id,
      success: failures.length === 0,
      statusCode: response.status,
      responseTimeMs,
      error: failures.length > 0 ? truncateError(failures.join('; ')) : null,
      ranAt: new Date(started).toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const aborted = controller.signal.aborted || /abort/i.test(message);
    return finish({
      success: false,
      statusCode: null,
      error: aborted ? `Timeout after ${check.timeoutMs}ms` : truncateError(message),
    });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
