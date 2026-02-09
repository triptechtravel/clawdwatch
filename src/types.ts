/**
 * Types for clawdwatch v2 synthetic monitoring system
 *
 * v2 changes:
 * - Checks loaded from D1 (not static array)
 * - History stored in Analytics Engine (not R2)
 * - R2 state simplified (no history array)
 * - Incidents tracked in D1
 */

export type CheckType = 'api' | 'browser';

export type CheckStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

// ── Assertions ──

export type AssertionOperator = 'is' | 'isNot' | 'contains' | 'notContains' | 'matches' | 'lessThan' | 'greaterThan';

export interface StatusCodeAssertion {
  type: 'statusCode';
  operator: 'is' | 'isNot';
  value: number;
}

export interface HeaderAssertion {
  type: 'header';
  name: string;
  operator: 'is' | 'isNot' | 'contains' | 'notContains' | 'matches';
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

export type Assertion =
  | StatusCodeAssertion
  | HeaderAssertion
  | BodyAssertion
  | ResponseTimeAssertion;

// ── Check Config (matches D1 schema) ──

export interface CheckConfig {
  id: string;
  name: string;
  type: CheckType;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  assertions: Assertion[];
  retry_count: number;
  retry_delay_ms: number;
  timeout_ms: number;
  failure_threshold: number;
  tags: string[];
  group_id: string | null;
  regions: string[];
  enabled: boolean;
}

/** Raw row from D1 checks table (JSON columns are strings) */
export interface CheckRow {
  id: string;
  name: string;
  type: string;
  url: string;
  method: string;
  headers: string;
  body: string | null;
  assertions: string;
  retry_count: number;
  retry_delay_ms: number;
  timeout_ms: number;
  failure_threshold: number;
  tags: string;
  group_id: string | null;
  regions: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ── R2 State (simplified — no history) ──

export interface CheckState {
  status: CheckStatus;
  consecutiveFailures: number;
  lastCheck: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  responseTimeMs: number | null;
}

export interface MonitoringState {
  checks: Record<string, CheckState>;
  lastRun: string | null;
}

// ── Check Results ──

export interface CheckResult {
  id: string;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
}

// ── Alerts ──

export type AlertType = 'failure' | 'recovery';

export interface AlertPayload {
  type: AlertType;
  check: CheckConfig;
  checkState: CheckState;
  result: CheckResult;
  timestamp: string;
}

// ── Incidents (D1) ──

export interface Incident {
  id: number;
  check_id: string;
  type: string;
  started_at: string;
  resolved_at: string | null;
  duration_s: number | null;
  trigger_error: string | null;
}

// ── Alert Rules (D1) ──

export interface AlertRule {
  id: number;
  check_id: string | null;
  group_id: string | null;
  channel: string;
  config: Record<string, unknown>;
  on_failure: boolean;
  on_recovery: boolean;
  enabled: boolean;
}

// ── Maintenance Windows (D1) ──

export interface MaintenanceWindow {
  id: number;
  check_id: string | null;
  group_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  suppress_alerts: boolean;
  skip_checks: boolean;
}

// ── Top-level Config ──

export interface ClawdWatchOptions<TEnv> {
  storage: {
    getD1: (env: TEnv) => D1Database;
    getR2: (env: TEnv) => R2Bucket;
    getAnalyticsEngine?: (env: TEnv) => AnalyticsEngineDataset;
  };
  defaults?: {
    failureThreshold?: number;
    timeoutMs?: number;
    stateKey?: string;
    userAgent?: string;
  };
  resolveUrl?: (url: string, env: TEnv) => string;
  onAlert?: (alert: AlertPayload, env: TEnv) => Promise<void>;
}

// ── API Response Types ──

export interface HistoryEntry {
  timestamp: string;
  status: CheckStatus;
  responseTimeMs: number;
  error: string | null;
}

export interface MonitoringCheckStatus {
  id: string;
  name: string;
  type: string;
  url: string;
  tags: string[];
  status: CheckStatus;
  consecutiveFailures: number;
  lastCheck: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  responseTimeMs: number | null;
  history: HistoryEntry[];
  uptimePercent: number | null;
  enabled: boolean;
}

export interface MonitoringStatusResponse {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: MonitoringCheckStatus[];
  lastRun: string | null;
}
