/**
 * Cloudflare Access JWT verification.
 *
 * Implemented on WebCrypto rather than a JWT library so the package stays
 * dependency-free (hono is the only peer).
 *
 * The critical detail: a **service token** JWT has no `email` claim — the
 * identity lives in `common_name`, which is the token's client id. Code that
 * only looks for `email` silently rejects every machine caller, which is
 * exactly how the previous implementation was half-finished.
 *
 * Verification never trusts the fact that a request arrived: anyone who learns
 * the Worker's direct route bypasses the Access edge, so the JWT is always
 * checked against the team's JWKS, the expected `aud`, and the clock.
 */

export interface AccessIdentity {
  /** Human identity, present on user JWTs. */
  email?: string;
  /** Machine identity (service-token client id), present on service JWTs. */
  commonName?: string;
  sub: string;
  /** True when this is a service token rather than a person. */
  isServiceToken: boolean;
}

export class AccessVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessVerificationError';
  }
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface JwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  sub?: string;
  email?: string;
  common_name?: string;
  [key: string]: unknown;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
}

// JWKS rarely rotates; a short cache keeps a burst of API calls to one fetch.
const JWKS_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

export function certsUrl(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${host}/cdn-cgi/access/certs`;
}

export async function fetchJwks(teamDomain: string, now = Date.now()): Promise<Jwk[]> {
  const url = certsUrl(teamDomain);
  const cached = jwksCache.get(url);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const response = await fetch(url);
  if (!response.ok) {
    throw new AccessVerificationError(`Could not fetch Access certs (${response.status})`);
  }
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(url, { keys, fetchedAt: now });
  return keys;
}

/** Test hook — clears the module-level JWKS cache. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

async function verifySignature(jwk: Jwk, signed: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(signed),
  );
}

export interface VerifyOptions {
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  now?: number;
  /** Injected for tests. */
  getJwks?: (teamDomain: string) => Promise<Jwk[]>;
}

/**
 * Verify an Access JWT and return the identity it asserts.
 * Throws AccessVerificationError on any failure — callers should treat every
 * throw as a 403 and never leak the reason to the client.
 */
export async function verifyAccessJwt(
  token: string,
  options: VerifyOptions,
): Promise<AccessIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessVerificationError('Malformed token');

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = decodeJson<JwtHeader>(headerB64);
    payload = decodeJson<JwtPayload>(payloadB64);
  } catch {
    throw new AccessVerificationError('Malformed token');
  }

  if (header.alg !== 'RS256') {
    // Refusing anything but RS256 closes the `alg: none` family of attacks.
    throw new AccessVerificationError(`Unsupported algorithm: ${header.alg}`);
  }

  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);

  if (typeof payload.exp === 'number' && nowSeconds >= payload.exp) {
    throw new AccessVerificationError('Token expired');
  }
  if (typeof payload.nbf === 'number' && nowSeconds < payload.nbf) {
    throw new AccessVerificationError('Token not yet valid');
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(options.aud)) {
    // A token minted for another Access application must not work here — this
    // is what keeps a leaked agent token scoped to the API app.
    throw new AccessVerificationError('Audience mismatch');
  }

  const expectedIssuer = certsUrl(options.teamDomain).replace('/cdn-cgi/access/certs', '');
  if (payload.iss && payload.iss.replace(/\/+$/, '') !== expectedIssuer) {
    throw new AccessVerificationError('Issuer mismatch');
  }

  const keys = await (options.getJwks ?? fetchJwks)(options.teamDomain);
  const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
  if (candidates.length === 0) throw new AccessVerificationError('No matching signing key');

  const signature = base64UrlDecode(signatureB64);
  const signed = `${headerB64}.${payloadB64}`;

  let valid = false;
  for (const jwk of candidates) {
    if (await verifySignature(jwk, signed, signature)) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new AccessVerificationError('Signature verification failed');

  const commonName = typeof payload.common_name === 'string' ? payload.common_name : undefined;
  const email = typeof payload.email === 'string' ? payload.email : undefined;

  if (!email && !commonName) {
    throw new AccessVerificationError('Token asserts no identity');
  }

  return {
    email,
    commonName,
    sub: typeof payload.sub === 'string' ? payload.sub : (commonName ?? email ?? ''),
    isServiceToken: !email && !!commonName,
  };
}
