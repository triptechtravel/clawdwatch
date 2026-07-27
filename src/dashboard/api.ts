/**
 * Dashboard API client. Reads only — writes arrive with the check editor.
 *
 * Requests carry credentials so an Access session cookie is sent when the
 * dashboard is mounted behind Zero Trust.
 */

export type Status = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export interface StatusRow {
  id: string;
  name: string;
  url: string;
  tags: string[];
  enabled: boolean;
  status: Status;
  consecutiveFailures: number;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResponseMs: number | null;
  downSince: string | null;
}

export interface StatusResponse {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: StatusRow[];
  generatedAt: string;
}

export interface ResultRow {
  checkId: string;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
  ranAt: string;
}

export interface IncidentRow {
  id: string;
  checkId: string;
  startedAt: string;
  resolvedAt: string | null;
  durationMs: number | null;
  triggerError: string | null;
  annotation: string | null;
}

export interface DeliveryRow {
  notifier: string;
  eventKind: string;
  ok: boolean;
  error: string | null;
  attempts: number;
  deliveredAt: string;
}

export interface CheckDetail {
  id: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  assertions: Array<Record<string, unknown>>;
  retryCount: number;
  timeoutMs: number;
  failureThreshold: number;
  reminderIntervalMs: number | null;
  intervalMins: number;
  tags: string[];
  enabled: boolean;
}

/** Base path the dashboard is mounted at, e.g. '' or '/monitoring'. */
export function basePath(): string {
  const path = window.location.pathname.replace(/\/+$/, '');
  return path.endsWith('/dashboard') ? path.slice(0, -'/dashboard'.length) : path;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${basePath()}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403 || response.status === 401
        ? 'Not authorised. Sign in through Cloudflare Access and reload.'
        : `Request failed (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  status: () => get<StatusResponse>('/api/status'),
  history: (id: string) =>
    get<{ results: ResultRow[] }>(`/api/checks/${encodeURIComponent(id)}/history`),
  incidents: (id: string) =>
    get<{ incidents: IncidentRow[] }>(`/api/incidents?check_id=${encodeURIComponent(id)}&limit=5`),
  check: (id: string) => get<CheckDetail>(`/api/checks/${encodeURIComponent(id)}`),
  deliveries: () => get<{ deliveries: DeliveryRow[] }>('/api/deliveries'),
};
