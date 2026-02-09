/**
 * Types for the clawdwatch synthetic monitoring system
 */

export type CheckType = 'api' | 'browser';

export type CheckStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export interface CheckConfig {
  id: string;
  name: string;
  type: CheckType;
  url: string;
  expectedStatus?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  tags?: string[];
}

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
