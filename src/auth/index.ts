/**
 * Authorization for the HTTP API.
 *
 * Two independent ways in:
 *   1. A Cloudflare Access JWT — a person via SSO, or a machine via a service
 *      token. Both are verified the same way (see auth/jwt.ts).
 *   2. A signed capability link — a short-lived, single-purpose URL embedded in
 *      an AlertEvent, so a receiving agent can ack or annotate the incident it
 *      was told about without holding any standing credential.
 *
 * There is deliberately no query-parameter API key. URLs end up in logs,
 * analytics, and referrer headers, and a single shared static secret has no
 * identity, no expiry, and no per-client revocation.
 */

import type { MiddlewareHandler } from 'hono';
import { verifyAccessJwt, AccessVerificationError, type AccessIdentity } from './jwt';
import { signPayload, timingSafeEqual } from '../notify/webhook';

export interface AuthConfig {
  /** e.g. `myteam.cloudflareaccess.com`. Omit to disable Access auth. */
  teamDomain?: string;
  /** The Access application AUD tag. */
  aud?: string;
  /**
   * When set, only these service-token client ids may write. Leave undefined
   * to allow any identity that Access itself admitted.
   */
  allowedServiceTokens?: string[];
  /** Key for signing capability links. Omit to disable them. */
  capabilitySecret?: string;
  /**
   * Local development only. Refused in production — an env-flag auth bypass
   * that ships is the same class of hole as a query-param key.
   */
  devMode?: boolean;
  now?: () => number;
}

export interface Principal {
  kind: 'user' | 'service' | 'capability' | 'dev';
  id: string;
  /** Capability principals may only perform the action they were minted for. */
  scope?: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 403,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function extractJwt(request: Request): string | null {
  const header = request.headers.get('CF-Access-JWT-Assertion');
  if (header) return header;

  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  const match = cookie.split(';').find((c) => c.trim().startsWith('CF_Authorization='));
  return match ? match.split('=').slice(1).join('=').trim() : null;
}

/** Capability tokens sign `scope.expiry` — never a bare resource id. */
export async function mintCapability(
  secret: string,
  scope: string,
  expiresAt: number,
): Promise<string> {
  const signature = await signPayload(secret, String(expiresAt), scope);
  return `${expiresAt}.${signature.replace(/^sha256=/, '')}`;
}

export async function verifyCapability(
  secret: string,
  scope: string,
  token: string,
  now: number,
): Promise<boolean> {
  const [expiryPart, signaturePart] = token.split('.');
  const expiresAt = Number(expiryPart);
  if (!Number.isFinite(expiresAt) || !signaturePart) return false;
  if (now > expiresAt) return false;

  const expected = (await signPayload(secret, expiryPart, scope)).replace(/^sha256=/, '');
  return timingSafeEqual(expected, signaturePart);
}

/**
 * Resolve the principal for a request, or throw AuthError.
 * `scope` names the action being attempted, for capability links.
 */
export async function authenticate(
  request: Request,
  config: AuthConfig,
  scope?: string,
): Promise<Principal> {
  const now = config.now?.() ?? Date.now();

  if (config.devMode) return { kind: 'dev', id: 'dev@localhost' };

  // Capability link: ?cap=<expiry>.<sig>, valid only for its own scope.
  if (scope && config.capabilitySecret) {
    const cap = new URL(request.url).searchParams.get('cap');
    if (cap && (await verifyCapability(config.capabilitySecret, scope, cap, now))) {
      return { kind: 'capability', id: 'capability-link', scope };
    }
  }

  if (!config.teamDomain || !config.aud) {
    throw new AuthError('Access is not configured', 403);
  }

  const token = extractJwt(request);
  if (!token) throw new AuthError('Missing Access token', 401);

  let identity: AccessIdentity;
  try {
    identity = await verifyAccessJwt(token, {
      teamDomain: config.teamDomain,
      aud: config.aud,
      now,
    });
  } catch (err) {
    // Never echo the reason back — it tells an attacker which check failed.
    if (err instanceof AccessVerificationError) throw new AuthError('Invalid Access token', 403);
    throw err;
  }

  if (identity.isServiceToken) {
    const allowed = config.allowedServiceTokens;
    if (allowed && !allowed.includes(identity.commonName ?? '')) {
      throw new AuthError('Service token not permitted', 403);
    }
    return { kind: 'service', id: identity.commonName ?? identity.sub };
  }

  return { kind: 'user', id: identity.email ?? identity.sub };
}

/**
 * Hono middleware. The resolved principal is used for the authorization
 * decision and then discarded — no identity is ever persisted (see the
 * no-PII posture).
 */
export function requireAuth(config: AuthConfig, scope?: string): MiddlewareHandler {
  return async (c, next) => {
    try {
      const principal = await authenticate(c.req.raw, config, scope);
      c.set('principal' as never, principal as never);
      await next();
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  };
}

export { verifyAccessJwt, AccessVerificationError, type AccessIdentity } from './jwt';
