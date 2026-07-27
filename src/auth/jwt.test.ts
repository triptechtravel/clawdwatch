import { describe, it, expect, beforeAll } from 'vitest';
import { verifyAccessJwt, AccessVerificationError, certsUrl } from './jwt';

/**
 * These tests use a real RSA keypair and real signatures — the point is to
 * exercise WebCrypto verification, not a mock of it.
 */

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-api-app';
const NOW = Date.parse('2026-07-27T00:00:00.000Z');

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey;
let otherKeyPair: CryptoKeyPair;

function b64url(bytes: Uint8Array | string): string {
  const binary =
    typeof bytes === 'string'
      ? bytes
      : [...bytes].map((b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeJwt(
  payload: Record<string, unknown>,
  opts: { alg?: string; kid?: string; signWith?: CryptoKeyPair } = {},
): Promise<string> {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'key-1', typ: 'JWT' };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signed = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    (opts.signWith ?? keyPair).privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${b64url(new Uint8Array(signature))}`;
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000) - 10,
    sub: 'sub-123',
    email: 'isaac@example.com',
    ...overrides,
  };
}

async function getJwks() {
  return [{ kid: 'key-1', kty: 'RSA', n: jwk.n!, e: jwk.e!, alg: 'RS256' }];
}

function verify(token: string, overrides = {}) {
  return verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, now: NOW, getJwks, ...overrides });
}

beforeAll(async () => {
  const params = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  };
  keyPair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
  otherKeyPair = (await crypto.subtle.generateKey(params, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
});

describe('certsUrl', () => {
  it('builds the JWKS endpoint', () => {
    expect(certsUrl(TEAM)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  it('tolerates a scheme or trailing slash', () => {
    expect(certsUrl(`https://${TEAM}/`)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });
});

describe('identity JWTs (people)', () => {
  it('accepts a valid token and returns the email', async () => {
    const identity = await verify(await makeJwt(basePayload()));
    expect(identity.email).toBe('isaac@example.com');
    expect(identity.isServiceToken).toBe(false);
  });

  it('accepts a string aud as well as an array', async () => {
    const identity = await verify(await makeJwt(basePayload({ aud: AUD })));
    expect(identity.email).toBe('isaac@example.com');
  });
});

describe('service-token JWTs (machines)', () => {
  it('accepts a token whose identity is common_name with no email', async () => {
    // The claim shape that a naive "read the email claim" implementation
    // rejects outright — which would break every agent call.
    const identity = await verify(
      await makeJwt(basePayload({ email: undefined, common_name: 'agent-token.access' })),
    );
    expect(identity.commonName).toBe('agent-token.access');
    expect(identity.email).toBeUndefined();
    expect(identity.isServiceToken).toBe(true);
  });

  it('rejects a token asserting no identity at all', async () => {
    await expect(
      verify(await makeJwt(basePayload({ email: undefined }))),
    ).rejects.toThrow(AccessVerificationError);
  });
});

describe('rejections', () => {
  it('rejects a token for a different Access application', async () => {
    await expect(verify(await makeJwt(basePayload({ aud: ['some-other-app'] })))).rejects.toThrow(
      /Audience/,
    );
  });

  it('rejects an expired token', async () => {
    await expect(
      verify(await makeJwt(basePayload({ exp: Math.floor(NOW / 1000) - 1 }))),
    ).rejects.toThrow(/expired/);
  });

  it('rejects a not-yet-valid token', async () => {
    await expect(
      verify(await makeJwt(basePayload({ nbf: Math.floor(NOW / 1000) + 60 }))),
    ).rejects.toThrow(/not yet valid/);
  });

  it('rejects a token signed by a different key', async () => {
    const token = await makeJwt(basePayload(), { signWith: otherKeyPair });
    await expect(verify(token)).rejects.toThrow(/Signature/);
  });

  it('rejects alg:none', async () => {
    const header = b64url(JSON.stringify({ alg: 'none', kid: 'key-1' }));
    const payload = b64url(JSON.stringify(basePayload()));
    await expect(verify(`${header}.${payload}.`)).rejects.toThrow(/algorithm/);
  });

  it('rejects a token from another issuer', async () => {
    await expect(
      verify(await makeJwt(basePayload({ iss: 'https://evil.cloudflareaccess.com' }))),
    ).rejects.toThrow(/Issuer/);
  });

  it('rejects a malformed token', async () => {
    await expect(verify('not.a.jwt')).rejects.toThrow(/Malformed/);
    await expect(verify('onlyonepart')).rejects.toThrow(/Malformed/);
  });

  it('rejects when no signing key matches the kid', async () => {
    const token = await makeJwt(basePayload(), { kid: 'unknown-kid' });
    await expect(verify(token)).rejects.toThrow(/signing key/);
  });

  it('rejects a tampered payload', async () => {
    const token = await makeJwt(basePayload());
    const [h, , s] = token.split('.');
    const tampered = b64url(JSON.stringify(basePayload({ email: 'attacker@evil.test' })));
    await expect(verify(`${h}.${tampered}.${s}`)).rejects.toThrow(/Signature/);
  });
});
