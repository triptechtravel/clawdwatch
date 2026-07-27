/**
 * Secret reference resolution and redaction.
 *
 * This is the single module allowed to turn a `${NAME}` reference into a real
 * value. Resolution happens at exactly one moment: building the outbound
 * request in the runner. Everything travelling the other way — API responses,
 * alert payloads, logs, config exports — goes through `redactCheck`/`scrub`
 * and keeps references un-resolved.
 *
 * The write-time guard (`findLeakedSecrets`) is what keeps a UI-editable,
 * database-backed system honest: a check whose header/body contains a real
 * secret value is rejected before it can be stored.
 */

import type { CheckConfig, CheckSummary, HeaderRule, SecretMap } from '../types';

/** `${NAME}` where NAME is a conventional env-var identifier. */
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Values shorter than this are too common to treat as secrets. */
const MIN_SECRET_LENGTH = 8;

/** Assertion failure messages are capped before they ever reach storage. */
export const MAX_ERROR_LENGTH = 256;

export class UnresolvedSecretError extends Error {
  constructor(public readonly names: string[]) {
    super(
      `Unresolved secret reference(s): ${names.join(', ')}. ` +
        `Add them to the \`secrets\` option and set the corresponding Worker secret.`,
    );
    this.name = 'UnresolvedSecretError';
  }
}

export class LeakedSecretError extends Error {
  constructor(public readonly names: string[], public readonly where: string) {
    super(
      `Refusing to store a literal secret value in ${where} (matches: ${names.join(', ')}). ` +
        `Use a reference like \${${names[0]}} instead.`,
    );
    this.name = 'LeakedSecretError';
  }
}

/** Names referenced by a template string. */
export function referencedSecrets(template: string): string[] {
  return [...template.matchAll(REF)].map((m) => m[1]);
}

/**
 * Substitute `${NAME}` with its value. Throws if any reference is missing, so
 * a misconfigured check fails loudly at run time rather than silently sending
 * an empty header.
 */
export function resolveTemplate(template: string, secrets: SecretMap): string {
  const missing: string[] = [];
  const out = template.replace(REF, (_match, name: string) => {
    const value = secrets[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });
  if (missing.length > 0) throw new UnresolvedSecretError([...new Set(missing)]);
  return out;
}

/** Resolve every value in a record. Keys are never templated. */
export function resolveRecord(
  record: Record<string, string>,
  secrets: SecretMap,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) out[k] = resolveTemplate(v, secrets);
  return out;
}

function hostMatches(host: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') return host === pattern;
  // Fresh instance: a shared /g regex would carry lastIndex between calls.
  return new RegExp(pattern.source, pattern.flags.replace('g', '')).test(host);
}

/**
 * Headers for an outbound check request: the check's own headers plus any
 * matching host rules, all resolved. Rules apply after the check's headers,
 * so a rule can supply a WAF-bypass token the check itself doesn't know about.
 */
export function buildRequestHeaders(
  check: CheckConfig,
  resolvedUrl: string,
  rules: HeaderRule[],
  secrets: SecretMap,
  userAgent: string,
): Record<string, string> {
  let host = '';
  try {
    host = new URL(resolvedUrl).host;
  } catch {
    // Malformed URL — the fetch will fail with a clearer message than we could.
  }

  const merged: Record<string, string> = { 'User-Agent': userAgent, ...check.headers };
  for (const rule of rules) {
    if (host && hostMatches(host, rule.host)) Object.assign(merged, rule.headers);
  }
  return resolveRecord(merged, secrets);
}

/**
 * Secret names whose literal values appear in `text`. Used by the write-time
 * guard. Short values are ignored — a two-character secret would match
 * everything and make the guard useless.
 */
export function findLeakedSecrets(text: string, secrets: SecretMap): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (text.includes(value)) hits.push(name);
  }
  return hits;
}

/**
 * Reject a check that carries literal secret values. Called on every create
 * and update, whether it came from the UI, the API, or a config import.
 */
export function assertNoLeakedSecrets(check: CheckConfig, secrets: SecretMap): void {
  const headerText = Object.entries(check.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const headerHits = findLeakedSecrets(headerText, secrets);
  if (headerHits.length > 0) throw new LeakedSecretError(headerHits, 'check headers');

  if (check.body) {
    const bodyHits = findLeakedSecrets(check.body, secrets);
    if (bodyHits.length > 0) throw new LeakedSecretError(bodyHits, 'the check body');
  }

  const urlHits = findLeakedSecrets(check.url, secrets);
  if (urlHits.length > 0) throw new LeakedSecretError(urlHits, 'the check URL');
}

/**
 * Last-resort scrub for anything about to leave the system. References are
 * left intact; only literal values are masked. Cheap insurance for paths that
 * forget to use the typed redactors.
 */
export function scrub(text: string, secrets: SecretMap): string {
  let out = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    out = out.split(value).join(`\${${name}}`);
  }
  return out;
}

/** Truncate an assertion failure message to its storage cap. */
export function truncateError(message: string): string {
  return message.length <= MAX_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

/**
 * The notifier/API view of a check: identity and routing only. Headers and
 * body are dropped entirely rather than masked — a notifier has no use for
 * them, and what is absent cannot leak.
 */
export function toCheckSummary(check: CheckConfig, status: CheckSummary['status']): CheckSummary {
  return {
    id: check.id,
    name: check.name,
    url: check.url,
    tags: check.tags,
    status,
  };
}

/**
 * The API view of a check: everything, but with header/body/URL references
 * left un-resolved. Safe to serialise into a config export.
 */
export function redactCheck(check: CheckConfig, secrets: SecretMap): CheckConfig {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(check.headers)) headers[k] = scrub(v, secrets);
  return {
    ...check,
    url: scrub(check.url, secrets),
    headers,
    body: check.body === null ? null : scrub(check.body, secrets),
  };
}
