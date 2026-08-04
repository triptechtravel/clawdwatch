/**
 * clawdwatch v3 — public contracts.
 *
 * Domain types are camelCase; D1 columns are snake_case. The mapping lives
 * in engine/store/d1.ts and nowhere else.
 *
 * Two invariants hold throughout:
 *   1. Secret VALUES never appear in a CheckConfig, an AlertEvent, an API
 *      response, or a log. Only references (`${NAME}`). See engine/secrets.ts.
 *   2. Response bodies are never persisted or emitted — only assertion
 *      failure messages, truncated — UNLESS a check sets
 *      `captureBodyOnFailure`, which stores a short scrubbed excerpt of a
 *      FAILING response so an operator or agent can see why. Off by default,
 *      per check, and never populated for a passing check.
 */

// ── Assertions ──────────────────────────────────────────────────────────

export type StringOperator = 'is' | 'isNot' | 'contains' | 'notContains' | 'matches';
export type NumericOperator = 'lessThan' | 'greaterThan';

export interface StatusCodeAssertion {
  type: 'statusCode';
  operator: 'is' | 'isNot';
  value: number;
}

export interface HeaderAssertion {
  type: 'header';
  name: string;
  operator: StringOperator;
  value: string;
}

export interface BodyAssertion {
  type: 'body';
  operator: 'contains' | 'notContains' | 'matches';
  value: string;
}

export interface ResponseTimeAssertion {
  type: 'responseTime';
  operator: 'lessThan';
  value: number;
}

export interface JsonPathAssertion {
  type: 'jsonPath';
  path: string;
  operator: StringOperator | NumericOperator;
  value: string;
}

export type Assertion =
  | StatusCodeAssertion
  | HeaderAssertion
  | BodyAssertion
  | ResponseTimeAssertion
  | JsonPathAssertion;

/** True when any assertion requires reading the response body. */
export function needsBody(assertions: Assertion[]): boolean {
  return assertions.some((a) => a.type === 'body' || a.type === 'jsonPath');
}

// ── Checks ──────────────────────────────────────────────────────────────

export type CheckStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export interface CheckConfig {
  id: string;
  name: string;
  url: string;
  method: string;
  /** Values may contain `${SECRET_NAME}` references — never raw secrets. */
  headers: Record<string, string>;
  body: string | null;
  assertions: Assertion[];
  retryCount: number;
  retryDelayMs: number;
  timeoutMs: number;
  /** Consecutive failures before a check is declared unhealthy. */
  failureThreshold: number;
  /** Re-alert cadence while unhealthy. null disables reminders. */
  reminderIntervalMs: number | null;
  intervalMins: number;
  tags: string[];
  enabled: boolean;
  /**
   * Opt in to capturing a short, secret-scrubbed excerpt of the response body
   * when this check FAILS. Off by default: bodies may carry personal or
   * sensitive data, so capturing one is a decision the check owner makes.
   *
   * A passing check never reads its body for this purpose. See
   * `buildBodySnippet` in engine/secrets.ts for the scrubbing and cap.
   */
  captureBodyOnFailure: boolean;
}

/** Per-check hot state driving the alert machine. */
export interface CheckState {
  checkId: string;
  status: CheckStatus;
  consecutiveFailures: number;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResponseMs: number | null;
  /** Set when the check first went unhealthy; cleared on recovery. */
  downSince: string | null;
  /** Drives reminder scheduling. */
  lastAlertAt: string | null;
  /** Open incident id, if any. */
  incidentId: string | null;
}

export interface CheckResult {
  checkId: string;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  /** Assertion failure summary — never a response body. */
  error: string | null;
  ranAt: string;
  /**
   * Scrubbed excerpt of a failing response body. Non-null only when the check
   * set `captureBodyOnFailure`, the check failed, and the body was textual.
   */
  bodySnippet: string | null;
}

export interface Incident {
  id: string;
  checkId: string;
  startedAt: string;
  resolvedAt: string | null;
  durationMs: number | null;
  triggerError: string | null;
  /** Optional triage note written by an agent or inline AI. */
  annotation: string | null;
}

export interface MaintenanceWindow {
  id: string;
  checkId: string | null;
  tag: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  suppressAlerts: boolean;
  skipChecks: boolean;
}

// ── Alert events ────────────────────────────────────────────────────────

export type AlertEventKind = 'opened' | 'recovered' | 'reminder' | 'summary';

/** A check as seen by a notifier — no headers, no secrets. */
export interface CheckSummary {
  id: string;
  name: string;
  url: string;
  tags: string[];
  status: CheckStatus;
}

export interface FailureDetail {
  statusCode: number | null;
  responseTimeMs: number;
  /** Assertion failure messages, each already truncated. */
  assertions: string[];
  consecutiveFailures: number;
  /**
   * Scrubbed excerpt of the failing response body, when the check opted in via
   * `captureBodyOnFailure`. Absent otherwise — a receiver must not rely on it.
   */
  bodySnippet?: string | null;
}

/**
 * Self-describing affordances. Action links are short-lived signed URLs so a
 * receiving agent can act without standing credentials.
 */
export interface AlertLinks {
  incident?: string;
  ack?: string;
  annotate?: string;
  runNow?: string;
  maintenance?: string;
  capabilities?: string;
}

/**
 * Version of the alert payload on the wire.
 *
 * The compatibility rule, which receivers may rely on:
 *   - Adding an OPTIONAL field does NOT bump this. `bodySnippet` was added
 *     this way: an older receiver simply ignores it.
 *   - Removing or renaming a field, or changing the meaning or type of one,
 *     DOES bump it.
 *
 * A receiver should ignore fields it does not recognise, and must not hard
 * fail on a version higher than it knows — degrade to what it can read. The
 * alternative is that shipping clawdwatch breaks every agent pointed at it.
 */
export const ALERT_SCHEMA_VERSION = 1;

export type AlertEvent =
  | {
      schemaVersion: number;
      kind: 'opened';
      at: string;
      check: CheckSummary;
      failure: FailureDetail;
      incidentId: string;
      links: AlertLinks;
    }
  | {
      schemaVersion: number;
      kind: 'recovered';
      at: string;
      check: CheckSummary;
      downtimeMs: number;
      incidentId: string;
      links: AlertLinks;
    }
  | {
      schemaVersion: number;
      kind: 'reminder';
      at: string;
      check: CheckSummary;
      failure: FailureDetail;
      downSinceMs: number;
      incidentId: string;
      links: AlertLinks;
    }
  | {
      schemaVersion: number;
      kind: 'summary';
      at: string;
      opened: CheckSummary[];
      recovered: CheckSummary[];
      stillDown: CheckSummary[];
      allClear: boolean;
      totalChecks: number;
      links: AlertLinks;
    };

// ── Notifiers ───────────────────────────────────────────────────────────

export interface NotifierContext<TEnv = unknown> {
  env: TEnv;
  /** Resolves `${NAME}` references in notifier config (webhook URLs etc.). */
  resolve: (template: string) => string;
}

export interface Notifier<TEnv = unknown> {
  name: string;
  /** Event kinds this notifier wants. Defaults to all. */
  on?: AlertEventKind[];
  notify(event: AlertEvent, ctx: NotifierContext<TEnv>): Promise<void>;
}

// ── Secrets ─────────────────────────────────────────────────────────────

export type SecretMap = Record<string, string | undefined>;

/** Attach extra headers to checks whose URL host matches. */
export interface HeaderRule {
  /** Exact host string, or a pattern tested against the URL host. */
  host: string | RegExp;
  /** Values may contain `${SECRET_NAME}` references. */
  headers: Record<string, string>;
}

// ── Top-level options ───────────────────────────────────────────────────

export interface ClawdWatchDefaults {
  failureThreshold?: number;
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  reminderIntervalMs?: number | null;
  intervalMins?: number;
  userAgent?: string;
  /** Max checks executed concurrently per run. */
  concurrency?: number;
  /** Hours of check_results retained. */
  historyRetentionHours?: number;
  /**
   * Fleet-wide default for `CheckConfig.captureBodyOnFailure`. Set this once
   * to give every check diagnostic body capture; override per check to opt a
   * sensitive endpoint back out. Ships off — turning it on is a deliberate
   * choice about what your responses contain.
   */
  captureBodyOnFailure?: boolean;
}

export interface ClawdWatchOptions<TEnv> {
  d1: (env: TEnv) => D1Database;
  /** API authorization. Omit and writes are refused with 403. */
  auth?: (env: TEnv) => import('./auth').AuthConfig;
  /** Secret values, keyed by the name used in `${NAME}` references. */
  secrets?: (env: TEnv) => SecretMap;
  headerRules?: HeaderRule[];
  resolveUrl?: (url: string, env: TEnv) => string;
  notifiers?: Notifier<TEnv>[];
  /** Public base URL, used to build AlertLinks. */
  baseUrl?: (env: TEnv) => string;
  defaults?: ClawdWatchDefaults;
}

export const DEFAULTS = {
  failureThreshold: 3,
  timeoutMs: 10_000,
  retryCount: 1,
  retryDelayMs: 5_000,
  reminderIntervalMs: 60 * 60 * 1000 as number | null,
  intervalMins: 5,
  userAgent: 'clawdwatch/3.0',
  concurrency: 6,
  historyRetentionHours: 48,
  captureBodyOnFailure: false,
};
