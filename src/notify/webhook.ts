/**
 * Generic signed webhook — and, therefore, the entire agent integration.
 *
 * An agent inbox is just a URL, so there is no separate `agent()` notifier:
 * point this at your assistant and pick an auth mode. The payload is the raw
 * `AlertEvent`, including its `links`, so a receiving agent can act on the
 * alert with no pre-installed knowledge of this API.
 */

import type { AlertEvent, Notifier, NotifierContext } from '../types';

export const SIGNATURE_HEADER = 'x-clawdwatch-signature';
export const TIMESTAMP_HEADER = 'x-clawdwatch-timestamp';

/** Reject signatures older than this when verifying. */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export interface WebhookAuth {
  /** Extra headers to attach. Values may contain `${SECRET}` references. */
  headers?: Record<string, string>;
  /** HMAC key; when set, the body is signed. May be a `${SECRET}` reference. */
  hmacSecret?: string;
}

/**
 * Sign the payload so any receiver can verify authenticity and reject replays.
 * The signature covers `timestamp.body`, not just the body.
 */
export function hmac(secret: string): WebhookAuth {
  return { hmacSecret: secret };
}

/**
 * Cloudflare Access service token — for an inbox behind Zero Trust. The pair
 * is minted in Zero Trust → Access → Service Tokens and attached to a policy
 * with action "Service Auth".
 */
export function serviceToken(clientId: string, clientSecret: string): WebhookAuth {
  return {
    headers: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
  };
}

/** Combine auth modes — e.g. an Access-protected inbox that also verifies HMAC. */
export function combineAuth(...auths: WebhookAuth[]): WebhookAuth {
  return {
    headers: Object.assign({}, ...auths.map((a) => a.headers ?? {})),
    hmacSecret: auths.find((a) => a.hmacSecret)?.hmacSecret,
  };
}

export interface WebhookOptions {
  /** Destination URL. May be a `${SECRET_NAME}` reference. */
  url: string;
  auth?: WebhookAuth;
  on?: AlertEvent['kind'][];
  name?: string;
  /** Extra static headers (non-secret). */
  headers?: Record<string, string>;
  now?: () => number;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256=<hex>` over `${timestamp}.${body}`. */
export async function signPayload(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `sha256=${toHex(signature)}`;
}

/**
 * Verify an incoming clawdwatch webhook. Exported so receivers (an agent
 * inbox, a test, another Worker) can use the same implementation rather than
 * re-deriving it and getting it subtly wrong.
 */
export async function verifySignature(opts: {
  secret: string;
  body: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
  toleranceMs?: number;
}): Promise<boolean> {
  const { secret, body, signature, timestamp } = opts;
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const now = opts.now ?? Date.now();
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  if (Math.abs(now - ts) > tolerance) return false;

  const expected = await signPayload(secret, timestamp, body);
  return timingSafeEqual(expected, signature);
}

/** Constant-time compare — avoids leaking the signature via response timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function webhook<TEnv = unknown>(options: WebhookOptions): Notifier<TEnv> {
  const now = options.now ?? (() => Date.now());

  return {
    name: options.name ?? 'webhook',
    on: options.on,
    async notify(event: AlertEvent, ctx: NotifierContext<TEnv>) {
      const url = ctx.resolve(options.url);
      const body = JSON.stringify(event);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...options.headers,
      };

      for (const [k, v] of Object.entries(options.auth?.headers ?? {})) {
        headers[k] = ctx.resolve(v);
      }

      if (options.auth?.hmacSecret) {
        const timestamp = String(now());
        headers[TIMESTAMP_HEADER] = timestamp;
        headers[SIGNATURE_HEADER] = await signPayload(
          ctx.resolve(options.auth.hmacSecret),
          timestamp,
          body,
        );
      }

      const response = await fetch(url, { method: 'POST', headers, body });
      if (!response.ok) {
        throw new Error(`Webhook ${url} returned ${response.status}`);
      }
    },
  };
}
