/**
 * D1 persistence. The only place that knows about snake_case columns or JSON
 * string encoding — everything above this layer speaks the domain types.
 *
 * Writes go through `assertNoLeakedSecrets`, so a literal secret value cannot
 * enter the database from the UI, the API, or a config import.
 */

import type {
  CheckConfig,
  CheckResult,
  CheckState,
  Incident,
  MaintenanceWindow,
  SecretMap,
} from '../../types';
import { DEFAULTS } from '../../types';
import { assertNoLeakedSecrets } from '../secrets';
import { emptyState } from '../transition';

// ── Row shapes ──────────────────────────────────────────────────────────

interface CheckRow {
  id: string;
  name: string;
  url: string;
  method: string;
  headers: string;
  body: string | null;
  assertions: string;
  retry_count: number;
  retry_delay_ms: number;
  timeout_ms: number;
  failure_threshold: number;
  reminder_interval_ms: number | null;
  interval_mins: number;
  tags: string;
  enabled: number;
}

interface StateRow {
  check_id: string;
  status: string;
  consecutive_failures: number;
  last_check_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_response_ms: number | null;
  down_since: string | null;
  last_alert_at: string | null;
  incident_id: string | null;
}

/** Tolerant JSON parse — a malformed column must not take down a whole run. */
function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function rowToCheck(row: CheckRow): CheckConfig {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method || 'GET',
    headers: parseJson<Record<string, string>>(row.headers, {}),
    body: row.body,
    assertions: parseJson(row.assertions, []),
    retryCount: row.retry_count ?? DEFAULTS.retryCount,
    retryDelayMs: row.retry_delay_ms ?? DEFAULTS.retryDelayMs,
    timeoutMs: row.timeout_ms ?? DEFAULTS.timeoutMs,
    failureThreshold: row.failure_threshold ?? DEFAULTS.failureThreshold,
    reminderIntervalMs: row.reminder_interval_ms,
    intervalMins: row.interval_mins ?? DEFAULTS.intervalMins,
    tags: parseJson<string[]>(row.tags, []),
    enabled: row.enabled === 1,
  };
}

export function rowToState(row: StateRow): CheckState {
  return {
    checkId: row.check_id,
    status: (row.status as CheckState['status']) ?? 'unknown',
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastCheckAt: row.last_check_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastResponseMs: row.last_response_ms,
    downSince: row.down_since,
    lastAlertAt: row.last_alert_at,
    incidentId: row.incident_id,
  };
}

// ── Checks ──────────────────────────────────────────────────────────────

export async function listChecks(db: D1Database, enabledOnly = false): Promise<CheckConfig[]> {
  const sql = enabledOnly
    ? 'SELECT * FROM checks WHERE enabled = 1 ORDER BY name'
    : 'SELECT * FROM checks ORDER BY name';
  const { results } = await db.prepare(sql).all<CheckRow>();
  return (results ?? []).map(rowToCheck);
}

export async function getCheck(db: D1Database, id: string): Promise<CheckConfig | null> {
  const row = await db.prepare('SELECT * FROM checks WHERE id = ?').bind(id).first<CheckRow>();
  return row ? rowToCheck(row) : null;
}

export async function upsertCheck(
  db: D1Database,
  check: CheckConfig,
  secrets: SecretMap,
): Promise<void> {
  // The write-time guard: refuse literal secret values, whatever the source.
  assertNoLeakedSecrets(check, secrets);

  await db
    .prepare(
      `INSERT INTO checks (
         id, name, url, method, headers, body, assertions,
         retry_count, retry_delay_ms, timeout_ms, failure_threshold,
         reminder_interval_ms, interval_mins, tags, enabled, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, url=excluded.url, method=excluded.method,
         headers=excluded.headers, body=excluded.body, assertions=excluded.assertions,
         retry_count=excluded.retry_count, retry_delay_ms=excluded.retry_delay_ms,
         timeout_ms=excluded.timeout_ms, failure_threshold=excluded.failure_threshold,
         reminder_interval_ms=excluded.reminder_interval_ms,
         interval_mins=excluded.interval_mins, tags=excluded.tags,
         enabled=excluded.enabled,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(
      check.id,
      check.name,
      check.url,
      check.method,
      JSON.stringify(check.headers),
      check.body,
      JSON.stringify(check.assertions),
      check.retryCount,
      check.retryDelayMs,
      check.timeoutMs,
      check.failureThreshold,
      check.reminderIntervalMs,
      check.intervalMins,
      JSON.stringify(check.tags),
      check.enabled ? 1 : 0,
    )
    .run();
}

export async function deleteCheck(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM check_state WHERE check_id = ?').bind(id),
    db.prepare('DELETE FROM check_results WHERE check_id = ?').bind(id),
    db.prepare('DELETE FROM checks WHERE id = ?').bind(id),
  ]);
}

// ── State ───────────────────────────────────────────────────────────────

export async function loadStates(db: D1Database): Promise<Map<string, CheckState>> {
  const { results } = await db.prepare('SELECT * FROM check_state').all<StateRow>();
  const map = new Map<string, CheckState>();
  for (const row of results ?? []) map.set(row.check_id, rowToState(row));
  return map;
}

export async function getState(db: D1Database, checkId: string): Promise<CheckState> {
  const row = await db
    .prepare('SELECT * FROM check_state WHERE check_id = ?')
    .bind(checkId)
    .first<StateRow>();
  return row ? rowToState(row) : emptyState(checkId);
}

export function saveStateStatement(db: D1Database, state: CheckState): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO check_state (
         check_id, status, consecutive_failures, last_check_at, last_success_at,
         last_error, last_response_ms, down_since, last_alert_at, incident_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(check_id) DO UPDATE SET
         status=excluded.status,
         consecutive_failures=excluded.consecutive_failures,
         last_check_at=excluded.last_check_at,
         last_success_at=excluded.last_success_at,
         last_error=excluded.last_error,
         last_response_ms=excluded.last_response_ms,
         down_since=excluded.down_since,
         last_alert_at=excluded.last_alert_at,
         incident_id=excluded.incident_id`,
    )
    .bind(
      state.checkId,
      state.status,
      state.consecutiveFailures,
      state.lastCheckAt,
      state.lastSuccessAt,
      state.lastError,
      state.lastResponseMs,
      state.downSince,
      state.lastAlertAt,
      state.incidentId,
    );
}

// ── Results ─────────────────────────────────────────────────────────────

export function insertResultStatement(
  db: D1Database,
  result: CheckResult,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO check_results (check_id, success, status_code, response_time_ms, error, ran_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(
      result.checkId,
      result.success ? 1 : 0,
      result.statusCode,
      result.responseTimeMs,
      result.error,
      result.ranAt,
    );
}

export async function listResults(
  db: D1Database,
  checkId: string,
  limit = 288,
): Promise<CheckResult[]> {
  const { results } = await db
    .prepare(
      `SELECT check_id, success, status_code, response_time_ms, error, ran_at
       FROM check_results WHERE check_id = ? ORDER BY ran_at DESC LIMIT ?`,
    )
    .bind(checkId, limit)
    .all<{
      check_id: string;
      success: number;
      status_code: number | null;
      response_time_ms: number;
      error: string | null;
      ran_at: string;
    }>();

  return (results ?? [])
    .map((r) => ({
      checkId: r.check_id,
      success: r.success === 1,
      statusCode: r.status_code,
      responseTimeMs: r.response_time_ms,
      error: r.error,
      ranAt: r.ran_at,
    }))
    .reverse();
}

export async function pruneResults(db: D1Database, retentionHours: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionHours * 3600_000).toISOString();
  await db.prepare('DELETE FROM check_results WHERE ran_at < ?').bind(cutoff).run();
}

// ── Incidents ───────────────────────────────────────────────────────────

export function openIncidentStatement(
  db: D1Database,
  incident: Pick<Incident, 'id' | 'checkId' | 'startedAt' | 'triggerError'>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO incidents (id, check_id, started_at, trigger_error)
       VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(incident.id, incident.checkId, incident.startedAt, incident.triggerError);
}

export function resolveIncidentStatement(
  db: D1Database,
  incidentId: string,
  resolvedAt: string,
  durationMs: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE incidents SET resolved_at = ?, duration_ms = ?
       WHERE id = ? AND resolved_at IS NULL`,
    )
    .bind(resolvedAt, durationMs, incidentId);
}

export async function listIncidents(
  db: D1Database,
  opts: { checkId?: string; open?: boolean; limit?: number } = {},
): Promise<Incident[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.checkId) {
    where.push('check_id = ?');
    binds.push(opts.checkId);
  }
  if (opts.open === true) where.push('resolved_at IS NULL');
  if (opts.open === false) where.push('resolved_at IS NOT NULL');

  const sql =
    `SELECT * FROM incidents${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
    ' ORDER BY started_at DESC LIMIT ?';
  binds.push(opts.limit ?? 50);

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<{
      id: string;
      check_id: string;
      started_at: string;
      resolved_at: string | null;
      duration_ms: number | null;
      trigger_error: string | null;
      annotation: string | null;
    }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    checkId: r.check_id,
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    durationMs: r.duration_ms,
    triggerError: r.trigger_error,
    annotation: r.annotation,
  }));
}

export async function annotateIncident(
  db: D1Database,
  incidentId: string,
  annotation: string,
): Promise<void> {
  await db
    .prepare('UPDATE incidents SET annotation = ? WHERE id = ?')
    .bind(annotation, incidentId)
    .run();
}

// ── Maintenance ─────────────────────────────────────────────────────────

export async function activeMaintenance(
  db: D1Database,
  nowIso: string,
): Promise<MaintenanceWindow[]> {
  const { results } = await db
    .prepare('SELECT * FROM maintenance_windows WHERE starts_at <= ? AND ends_at >= ?')
    .bind(nowIso, nowIso)
    .all<{
      id: string;
      check_id: string | null;
      tag: string | null;
      starts_at: string;
      ends_at: string;
      reason: string | null;
      suppress_alerts: number;
      skip_checks: number;
    }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    checkId: r.check_id,
    tag: r.tag,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    reason: r.reason,
    suppressAlerts: r.suppress_alerts === 1,
    skipChecks: r.skip_checks === 1,
  }));
}

/** The window covering a check, if any. A null check_id and tag matches all. */
export function windowFor(
  windows: MaintenanceWindow[],
  check: CheckConfig,
): MaintenanceWindow | null {
  for (const w of windows) {
    if (w.checkId === check.id) return w;
    if (w.tag && check.tags.includes(w.tag)) return w;
    if (w.checkId === null && w.tag === null) return w;
  }
  return null;
}

// ── Notifier deliveries ─────────────────────────────────────────────────

export interface DeliveryRow {
  notifier: string;
  eventKind: string;
  ok: boolean;
  error: string | null;
  attempts: number;
  deliveredAt: string;
}

export function insertDeliveryStatement(
  db: D1Database,
  delivery: DeliveryRow,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifier_deliveries (notifier, event_kind, ok, error, attempts, delivered_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(
      delivery.notifier,
      delivery.eventKind,
      delivery.ok ? 1 : 0,
      delivery.error,
      delivery.attempts,
      delivery.deliveredAt,
    );
}

/** Most recent delivery per notifier — what the dashboard panel shows. */
export async function latestDeliveries(db: D1Database): Promise<DeliveryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT d.notifier, d.event_kind, d.ok, d.error, d.attempts, d.delivered_at
       FROM notifier_deliveries d
       JOIN (SELECT notifier, MAX(id) AS max_id FROM notifier_deliveries GROUP BY notifier) m
         ON d.id = m.max_id
       ORDER BY d.notifier`,
    )
    .all<{
      notifier: string;
      event_kind: string;
      ok: number;
      error: string | null;
      attempts: number;
      delivered_at: string;
    }>();

  return (results ?? []).map((r) => ({
    notifier: r.notifier,
    eventKind: r.event_kind,
    ok: r.ok === 1,
    error: r.error,
    attempts: r.attempts,
    deliveredAt: r.delivered_at,
  }));
}

export async function pruneDeliveries(db: D1Database, retentionHours: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionHours * 3600_000).toISOString();
  await db.prepare('DELETE FROM notifier_deliveries WHERE delivered_at < ?').bind(cutoff).run();
}
