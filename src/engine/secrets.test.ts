import { describe, it, expect } from 'vitest';
import {
  referencedSecrets,
  resolveTemplate,
  resolveRecord,
  buildRequestHeaders,
  findLeakedSecrets,
  assertNoLeakedSecrets,
  scrub,
  truncateError,
  buildBodySnippet,
  MAX_BODY_SNIPPET_LENGTH,
  redactCheck,
  toCheckSummary,
  UnresolvedSecretError,
  LeakedSecretError,
  MAX_ERROR_LENGTH,
} from './secrets';
import type { CheckConfig, HeaderRule, SecretMap } from '../types';

const SECRETS: SecretMap = {
  HEALTHCHECK_SECRET: 'hc-super-secret-value',
  WAF_BYPASS_SECRET: 'waf-bypass-token-123',
  SHORT: 'abc',
};

function check(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    id: 'c1',
    name: 'Check',
    url: 'https://api.example.com/health',
    method: 'GET',
    headers: {},
    body: null,
    assertions: [],
    retryCount: 1,
    retryDelayMs: 10,
    timeoutMs: 5000,
    failureThreshold: 3,
    reminderIntervalMs: null,
    intervalMins: 5,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

describe('referencedSecrets', () => {
  it('finds every reference', () => {
    expect(referencedSecrets('${A} and ${B} and ${A}')).toEqual(['A', 'B', 'A']);
  });

  it('ignores non-reference syntax', () => {
    expect(referencedSecrets('$NOT {NOT} ${lower_ok}')).toEqual(['lower_ok']);
  });

  it('rejects names starting with a digit', () => {
    expect(referencedSecrets('${1BAD}')).toEqual([]);
  });
});

describe('resolveTemplate', () => {
  it('substitutes values', () => {
    expect(resolveTemplate('Bearer ${HEALTHCHECK_SECRET}', SECRETS)).toBe(
      'Bearer hc-super-secret-value',
    );
  });

  it('leaves plain strings untouched', () => {
    expect(resolveTemplate('application/json', SECRETS)).toBe('application/json');
  });

  it('throws on a missing reference rather than sending an empty header', () => {
    expect(() => resolveTemplate('${NOPE}', SECRETS)).toThrow(UnresolvedSecretError);
  });

  it('treats an empty-string secret as missing', () => {
    expect(() => resolveTemplate('${EMPTY}', { EMPTY: '' })).toThrow(UnresolvedSecretError);
  });

  it('reports each missing name once', () => {
    try {
      resolveTemplate('${A}${A}${B}', {});
      expect.unreachable();
    } catch (err) {
      expect((err as UnresolvedSecretError).names).toEqual(['A', 'B']);
    }
  });
});

describe('resolveRecord', () => {
  it('resolves values but never keys', () => {
    const out = resolveRecord({ 'X-Key': '${HEALTHCHECK_SECRET}' }, SECRETS);
    expect(out).toEqual({ 'X-Key': 'hc-super-secret-value' });
  });
});

describe('buildRequestHeaders', () => {
  const rules: HeaderRule[] = [
    {
      host: /(^|\.)example\.com$/,
      headers: { 'x-waf-bypass': '${WAF_BYPASS_SECRET}' },
    },
  ];

  it('applies matching host rules and resolves them', () => {
    const headers = buildRequestHeaders(
      check({ headers: { 'X-Healthcheck-Secret': '${HEALTHCHECK_SECRET}' } }),
      'https://api.example.com/health',
      rules,
      SECRETS,
      'clawdwatch/3.0',
    );
    expect(headers).toEqual({
      'User-Agent': 'clawdwatch/3.0',
      'X-Healthcheck-Secret': 'hc-super-secret-value',
      'x-waf-bypass': 'waf-bypass-token-123',
    });
  });

  it('skips rules whose host does not match', () => {
    const headers = buildRequestHeaders(
      check(),
      'https://other.test/health',
      rules,
      SECRETS,
      'ua',
    );
    expect(headers).toEqual({ 'User-Agent': 'ua' });
  });

  it('matches the apex domain as well as subdomains', () => {
    const headers = buildRequestHeaders(check(), 'https://example.com/', rules, SECRETS, 'ua');
    expect(headers['x-waf-bypass']).toBe('waf-bypass-token-123');
  });

  it('does not match a lookalike suffix domain', () => {
    const headers = buildRequestHeaders(
      check(),
      'https://notexample.com/',
      rules,
      SECRETS,
      'ua',
    );
    expect(headers['x-waf-bypass']).toBeUndefined();
  });

  it('is not affected by a global regex carrying lastIndex between calls', () => {
    const globalRule: HeaderRule[] = [{ host: /example\.com/g, headers: { 'x-a': '1' } }];
    for (let i = 0; i < 3; i++) {
      const headers = buildRequestHeaders(check(), 'https://example.com/', globalRule, {}, 'ua');
      expect(headers['x-a']).toBe('1');
    }
  });

  it('lets the check override the default user agent', () => {
    const headers = buildRequestHeaders(
      check({ headers: { 'User-Agent': 'ExampleApp/1.0' } }),
      'https://other.test/',
      [],
      {},
      'clawdwatch/3.0',
    );
    expect(headers['User-Agent']).toBe('ExampleApp/1.0');
  });

  it('survives a malformed URL without throwing', () => {
    expect(() => buildRequestHeaders(check(), 'not a url', rules, SECRETS, 'ua')).not.toThrow();
  });
});

describe('findLeakedSecrets', () => {
  it('detects a literal value', () => {
    expect(findLeakedSecrets('Bearer hc-super-secret-value', SECRETS)).toEqual([
      'HEALTHCHECK_SECRET',
    ]);
  });

  it('ignores references', () => {
    expect(findLeakedSecrets('Bearer ${HEALTHCHECK_SECRET}', SECRETS)).toEqual([]);
  });

  it('ignores secrets too short to be distinctive', () => {
    expect(findLeakedSecrets('abc appears in many strings', SECRETS)).toEqual([]);
  });
});

describe('assertNoLeakedSecrets', () => {
  it('accepts references', () => {
    expect(() =>
      assertNoLeakedSecrets(
        check({ headers: { 'X-Key': '${HEALTHCHECK_SECRET}' } }),
        SECRETS,
      ),
    ).not.toThrow();
  });

  it('rejects a literal in a header', () => {
    expect(() =>
      assertNoLeakedSecrets(check({ headers: { 'X-Key': 'hc-super-secret-value' } }), SECRETS),
    ).toThrow(LeakedSecretError);
  });

  it('rejects a literal in the body', () => {
    expect(() =>
      assertNoLeakedSecrets(check({ body: '{"t":"waf-bypass-token-123"}' }), SECRETS),
    ).toThrow(LeakedSecretError);
  });

  it('rejects a literal in the URL query string', () => {
    expect(() =>
      assertNoLeakedSecrets(
        check({ url: 'https://api.example.com/h?secret=hc-super-secret-value' }),
        SECRETS,
      ),
    ).toThrow(LeakedSecretError);
  });

  it('names the reference to use in the error message', () => {
    try {
      assertNoLeakedSecrets(check({ headers: { k: 'hc-super-secret-value' } }), SECRETS);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('${HEALTHCHECK_SECRET}');
    }
  });
});

describe('truncateError', () => {
  it('leaves short messages alone', () => {
    expect(truncateError('Expected status 200, got 502')).toBe('Expected status 200, got 502');
  });

  it('caps long messages', () => {
    const out = truncateError('x'.repeat(1000));
    expect(out.length).toBe(MAX_ERROR_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('redactCheck / toCheckSummary', () => {
  it('turns literal values back into references', () => {
    const redacted = redactCheck(
      check({ headers: { 'X-Key': 'hc-super-secret-value' } }),
      SECRETS,
    );
    expect(redacted.headers['X-Key']).toBe('${HEALTHCHECK_SECRET}');
  });

  it('leaves existing references untouched', () => {
    const redacted = redactCheck(
      check({ headers: { 'X-Key': '${HEALTHCHECK_SECRET}' } }),
      SECRETS,
    );
    expect(redacted.headers['X-Key']).toBe('${HEALTHCHECK_SECRET}');
  });

  it('drops headers and body from the notifier view entirely', () => {
    const summary = toCheckSummary(
      check({ headers: { 'X-Key': '${HEALTHCHECK_SECRET}' }, body: 'secret-ish' }),
      'unhealthy',
    );
    expect(Object.keys(summary).sort()).toEqual(['id', 'name', 'status', 'tags', 'url']);
  });
});

/**
 * The invariant that matters: for any check built from any combination of
 * secret placements, nothing leaving the system contains a resolved value.
 */
describe('property: no resolved secret escapes', () => {
  const VALUES = Object.values(SECRETS).filter((v): v is string => !!v && v.length >= 8);

  const placements = [
    (v: string) => check({ headers: { 'X-A': v } }),
    (v: string) => check({ headers: { 'X-A': `Bearer ${v}` } }),
    (v: string) => check({ body: `{"token":"${v}"}` }),
    (v: string) => check({ url: `https://api.example.com/h?k=${v}` }),
    (v: string) => check({ headers: { 'X-A': v }, body: v, url: `https://x.test/${v}` }),
  ];

  it('holds across every placement and every secret', () => {
    for (const value of VALUES) {
      for (const place of placements) {
        const c = place(value);

        // The write guard rejects it outright.
        expect(() => assertNoLeakedSecrets(c, SECRETS)).toThrow(LeakedSecretError);

        // And if it somehow reached storage, every outbound view is clean.
        const outbound = [
          JSON.stringify(redactCheck(c, SECRETS)),
          JSON.stringify(toCheckSummary(redactCheck(c, SECRETS), 'unhealthy')),
          scrub(`log line: ${JSON.stringify(c)}`, SECRETS),
        ];
        for (const text of outbound) {
          expect(text).not.toContain(value);
        }
      }
    }
  });

  it('holds for checks that legitimately use references', () => {
    for (const name of Object.keys(SECRETS)) {
      const c = check({ headers: { 'X-A': `\${${name}}` } });
      expect(() => assertNoLeakedSecrets(c, SECRETS)).not.toThrow();
      const text = JSON.stringify(redactCheck(c, SECRETS));
      for (const value of VALUES) expect(text).not.toContain(value);
    }
  });
});

describe('buildBodySnippet', () => {
  it('collapses whitespace to a single line', () => {
    expect(buildBodySnippet('a\n\n  b\t c ', {})).toBe('a b c');
  });

  it('returns null for a body with nothing in it', () => {
    expect(buildBodySnippet('', {})).toBeNull();
    expect(buildBodySnippet('   \n\t ', {})).toBeNull();
  });

  it('caps the snippet and marks the cut', () => {
    const out = buildBodySnippet('y'.repeat(MAX_BODY_SNIPPET_LENGTH * 3), {})!;
    expect(out.length).toBe(MAX_BODY_SNIPPET_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a body at exactly the cap untouched', () => {
    const exact = 'z'.repeat(MAX_BODY_SNIPPET_LENGTH);
    expect(buildBodySnippet(exact, {})).toBe(exact);
  });

  it('replaces a secret value with its reference', () => {
    const out = buildBodySnippet('token=abcdefgh12345 failed', { API_KEY: 'abcdefgh12345' })!;
    expect(out).toBe('token=${API_KEY} failed');
  });

  it('scrubs before truncating, so a secret spanning the cut cannot survive', () => {
    const secret = 'supersecretvalue-0123456789';
    // Position the secret so it straddles the cap boundary.
    const prefix = 'p'.repeat(MAX_BODY_SNIPPET_LENGTH - 10);
    const out = buildBodySnippet(`${prefix}${secret}`, { TOKEN: secret })!;
    expect(out).not.toContain('supersecret');
    for (let i = 8; i < secret.length; i++) {
      expect(out).not.toContain(secret.slice(0, i));
    }
  });
});
