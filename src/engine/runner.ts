/**
 * Executes a single check: build the request (resolving secrets), fetch,
 * evaluate assertions, retry on failure.
 *
 * Secret values exist only inside this module's call stack — they enter via
 * `buildRequestHeaders` and leave via `fetch`. Nothing they touch is returned:
 * a CheckResult carries status, timing, and assertion messages, plus — only
 * for a failing check that set `captureBodyOnFailure` — a body excerpt that
 * has been through `buildBodySnippet` and so contains references, not values.
 */

import type { CheckConfig, CheckResult, HeaderRule, SecretMap } from '../types';
import { needsBody } from '../types';
import {
  buildBodySnippet,
  buildRequestHeaders,
  truncateError,
  UnresolvedSecretError,
} from './secrets';
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
    // These paths never obtained a response, so there is no body to excerpt.
    bodySnippet: null,
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
      bodySnippet:
        failures.length > 0 ? await captureSnippet(check, response, body, ctx.secrets) : null,
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

/** Content types whose bodies are worth showing a human. */
const TEXTUAL = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|problem\+json)|[^;]*\+json)/i;

/**
 * A short, scrubbed excerpt of a FAILING response, for checks that opted in.
 *
 * Reads the body only if an assertion did not already consume it — the stream
 * is single-use, so re-reading would throw. Everything here is best-effort:
 * a diagnostic nicety must never turn a clean check failure into a crash, so
 * any error yields null.
 */
async function captureSnippet(
  check: CheckConfig,
  response: Response,
  alreadyRead: string | null,
  secrets: SecretMap,
): Promise<string | null> {
  if (!check.captureBodyOnFailure) return null;

  const contentType = response.headers.get('content-type') ?? '';
  // An absent content-type is treated as textual: many error paths omit it.
  if (contentType !== '' && !TEXTUAL.test(contentType)) return null;

  try {
    const raw = alreadyRead ?? (await readBodyCapped(response));
    return buildBodySnippet(raw, secrets);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
