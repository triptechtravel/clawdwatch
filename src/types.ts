/**
 * Types for the clawdwatch synthetic monitoring system
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

// ── Check Config ──

export interface CheckConfig {
  id: string;
  name: string;
  type: CheckType;
  url: string;
  method?: string;
  assertions?: Assertion[];
  retry?: { count: number; delayMs: number };
  timeoutMs?: number;
  failureThreshold?: number;
  tags?: string[];
}

// ── State & Results ──

export interface HistoryEntry {
  timestamp: string;
  status: CheckStatus;
  responseTimeMs: number;
  error: string | null;
}

export interface CheckState {
  id: string;
  status: CheckStatus;
  consecutiveFailures: number;
  lastCheck: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  responseTimeMs: number | null;
  history: HistoryEntry[];
}

export interface MonitoringState {
  checks: Record<string, CheckState>;
  lastRun: string | null;
}

export interface CheckResult {
  id: string;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
}

export type AlertType = 'failure' | 'recovery';

export interface AlertPayload {
  type: AlertType;
  check: CheckConfig;
  checkState: CheckState;
  result: CheckResult;
  timestamp: string;
}

// ── Top-level Config ──

export interface ClawdWatchOptions<TEnv> {
  checks: CheckConfig[];
  defaults?: {
    failureThreshold?: number;
    timeoutMs?: number;
    historySize?: number;
    stateKey?: string;
    userAgent?: string;
  };
  getR2Bucket: (env: TEnv) => R2Bucket;
  getWorkerUrl?: (env: TEnv) => string | undefined;
  onAlert?: (alert: AlertPayload, env: TEnv) => Promise<void>;
}

// ── API Response Types ──

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
}

export interface MonitoringStatusResponse {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: MonitoringCheckStatus[];
  lastRun: string | null;
}
