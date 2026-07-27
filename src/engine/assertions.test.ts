import { describe, it, expect } from 'vitest';
import { evaluateAssertions, readBodyCapped, MAX_BODY_SIZE } from './assertions';
import { MAX_ERROR_LENGTH } from './secrets';
import type { Assertion } from '../types';

describe('evaluateAssertions', () => {
  function fakeResponse(opts: {
    status?: number;
    headers?: Record<string, string>;
  } = {}) {
    return {
      status: opts.status ?? 200,
      headers: new Headers(opts.headers ?? {}),
    } as unknown as Response;
  }

  describe('statusCode', () => {
    it('passes when status matches', () => {
      const assertions: Assertion[] = [{ type: 'statusCode', operator: 'is', value: 200 }];
      expect(evaluateAssertions(assertions, fakeResponse({ status: 200 }), 100, null)).toEqual([]);
    });

    it('fails when status does not match', () => {
      const assertions: Assertion[] = [{ type: 'statusCode', operator: 'is', value: 200 }];
      const failures = evaluateAssertions(assertions, fakeResponse({ status: 503 }), 100, null);
      expect(failures).toEqual(['Expected status 200, got 503']);
    });

    it('supports isNot operator', () => {
      const assertions: Assertion[] = [{ type: 'statusCode', operator: 'isNot', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse({ status: 200 }), 100, null)).toEqual([]);
      expect(evaluateAssertions(assertions, fakeResponse({ status: 500 }), 100, null)).toHaveLength(1);
    });
  });

  describe('header', () => {
    const response = fakeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' } });

    it('passes with is operator', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'is', value: 'text/html; charset=utf-8' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });

    it('fails with is operator on mismatch', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'is', value: 'application/json' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toHaveLength(1);
    });

    it('passes with contains operator', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'contains', value: 'text/html' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });

    it('fails when header is missing', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'x-custom', operator: 'contains', value: 'foo' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toHaveLength(1);
    });

    it('supports matches operator (regex)', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'matches', value: 'text/html.*utf-8' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });

    it('supports notContains operator', () => {
      const assertions: Assertion[] = [{ type: 'header', name: 'content-type', operator: 'notContains', value: 'json' }];
      expect(evaluateAssertions(assertions, response, 100, null)).toEqual([]);
    });
  });

  describe('body', () => {
    it('passes with contains operator', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'contains', value: 'hello' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, 'hello world')).toEqual([]);
    });

    it('fails when body does not contain value', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'contains', value: 'missing' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, 'hello world')).toHaveLength(1);
    });

    it('supports notContains operator', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'notContains', value: 'error' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, 'all good')).toEqual([]);
    });

    it('supports matches operator (regex)', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'matches', value: '<title>.*</title>' }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, '<title>Hello</title>')).toEqual([]);
    });

    it('fails when body is null', () => {
      const assertions: Assertion[] = [{ type: 'body', operator: 'contains', value: 'hello' }];
      const failures = evaluateAssertions(assertions, fakeResponse(), 100, null);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('which was not read');
    });
  });

  describe('responseTime', () => {
    it('passes when under threshold', () => {
      const assertions: Assertion[] = [{ type: 'responseTime', operator: 'lessThan', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, null)).toEqual([]);
    });

    it('fails when over threshold', () => {
      const assertions: Assertion[] = [{ type: 'responseTime', operator: 'lessThan', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse(), 600, null)).toHaveLength(1);
    });

    it('fails when exactly at threshold', () => {
      const assertions: Assertion[] = [{ type: 'responseTime', operator: 'lessThan', value: 500 }];
      expect(evaluateAssertions(assertions, fakeResponse(), 500, null)).toHaveLength(1);
    });
  });

  describe('jsonPath', () => {
    const jsonBody = JSON.stringify({
      data: { token: 'abc123', count: 42 },
      items: [{ id: 'first' }, { id: 'second' }],
      nested: { deep: { value: 'found' } },
      empty: '',
    });

    it('resolves top-level field', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.empty', operator: 'is', value: '' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('resolves nested field', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.data.token', operator: 'is', value: 'abc123' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('resolves deeply nested field', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.nested.deep.value', operator: 'is', value: 'found' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('resolves array index', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.items[0].id', operator: 'is', value: 'first' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('resolves second array element', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.items[1].id', operator: 'is', value: 'second' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('supports isNot operator', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.data.token', operator: 'isNot', value: '' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('supports contains operator', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.data.token', operator: 'contains', value: 'abc' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('supports notContains operator', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.data.token', operator: 'notContains', value: 'xyz' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('supports matches operator (regex)', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.data.token', operator: 'matches', value: '^abc\\d+$' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('stringifies numeric values for comparison', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.data.count', operator: 'is', value: '42' },
      ];
      expect(evaluateAssertions(assertions, fakeResponse(), 100, jsonBody)).toEqual([]);
    });

    it('fails when path is missing', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.nonexistent', operator: 'is', value: 'anything' },
      ];
      const failures = evaluateAssertions(assertions, fakeResponse(), 100, jsonBody);
      expect(failures).toEqual(['jsonPath "$.nonexistent": path not found']);
    });

    it('fails when body is not valid JSON', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.foo', operator: 'is', value: 'bar' },
      ];
      const failures = evaluateAssertions(assertions, fakeResponse(), 100, 'not json');
      expect(failures).toEqual(['jsonPath "$.foo": body is not valid JSON']);
    });

    it('fails when body is null', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.foo', operator: 'is', value: 'bar' },
      ];
      const failures = evaluateAssertions(assertions, fakeResponse(), 100, null);
      expect(failures).toEqual([
        'jsonPath assertion requires the response body, which was not read',
      ]);
    });

    it('fails when array index is out of bounds', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.items[99]', operator: 'is', value: 'anything' },
      ];
      const failures = evaluateAssertions(assertions, fakeResponse(), 100, jsonBody);
      expect(failures).toEqual(['jsonPath "$.items[99]": path not found']);
    });

    it('fails when operator check fails', () => {
      const assertions: Assertion[] = [
        { type: 'jsonPath', path: '$.data.token', operator: 'is', value: 'wrong' },
      ];
      const failures = evaluateAssertions(assertions, fakeResponse(), 100, jsonBody);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('jsonPath "$.data.token"');
      expect(failures[0]).toContain('expected "wrong"');
    });
  });

  describe('multiple assertions', () => {
    it('all pass', () => {
      const assertions: Assertion[] = [
        { type: 'statusCode', operator: 'is', value: 200 },
        { type: 'header', name: 'content-type', operator: 'contains', value: 'html' },
        { type: 'responseTime', operator: 'lessThan', value: 1000 },
      ];
      const response = fakeResponse({ status: 200, headers: { 'content-type': 'text/html' } });
      expect(evaluateAssertions(assertions, response, 50, null)).toEqual([]);
    });

    it('collects all failures', () => {
      const assertions: Assertion[] = [
        { type: 'statusCode', operator: 'is', value: 200 },
        { type: 'responseTime', operator: 'lessThan', value: 100 },
      ];
      const response = fakeResponse({ status: 503 });
      const failures = evaluateAssertions(assertions, response, 500, null);
      expect(failures).toHaveLength(2);
    });
  });
});

// ── v3 additions ────────────────────────────────────────────────────────

describe('failure message truncation', () => {
  function fakeResponse(status = 200) {
    return { status, headers: new Headers() } as unknown as Response;
  }

  it('caps a long message so storage and alerts stay bounded', () => {
    const assertions: Assertion[] = [
      { type: 'body', operator: 'contains', value: 'x'.repeat(1000) },
    ];
    const failures = evaluateAssertions(assertions, fakeResponse(), 10, 'short body');
    expect(failures[0].length).toBe(MAX_ERROR_LENGTH);
  });

  it('leaves a normal message intact', () => {
    const assertions: Assertion[] = [{ type: 'statusCode', operator: 'is', value: 200 }];
    expect(evaluateAssertions(assertions, fakeResponse(502), 10, null)).toEqual([
      'Expected status 200, got 502',
    ]);
  });
});

describe('invalid regex handling', () => {
  function fakeResponse() {
    return { status: 200, headers: new Headers({ 'x-a': 'v' }) } as unknown as Response;
  }

  it('reports an unparseable pattern instead of throwing', () => {
    const assertions: Assertion[] = [
      { type: 'header', name: 'x-a', operator: 'matches', value: '([' },
    ];
    expect(() => evaluateAssertions(assertions, fakeResponse(), 10, null)).not.toThrow();
    expect(evaluateAssertions(assertions, fakeResponse(), 10, null)[0]).toContain('invalid regex');
  });
});

describe('readBodyCapped', () => {
  it('reads a small body whole', async () => {
    expect(await readBodyCapped(new Response('hello'))).toBe('hello');
  });

  it('returns empty string for a bodyless response', async () => {
    expect(await readBodyCapped(new Response(null, { status: 204 }))).toBe('');
  });

  it('stops reading past the cap', async () => {
    const huge = 'x'.repeat(MAX_BODY_SIZE + 50_000);
    const out = await readBodyCapped(new Response(huge));
    expect(out.length).toBeLessThan(huge.length);
    expect(out.length).toBeGreaterThanOrEqual(MAX_BODY_SIZE);
  });
});
