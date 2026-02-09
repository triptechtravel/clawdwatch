/**
 * D1 database operations for check configs, incidents, alert rules, maintenance windows
 */

import type { CheckConfig, CheckRow, Incident, AlertRule, MaintenanceWindow } from '../types';

/** Parse a D1 check row into a CheckConfig */
export function parseCheckRow(row: CheckRow): CheckConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as CheckConfig['type'],
    url: row.url,
    method: row.method,
    headers: JSON.parse(row.headers),
    body: row.body,
    assertions: JSON.parse(row.assertions),
    retry_count: row.retry_count,
    retry_delay_ms: row.retry_delay_ms,
    timeout_ms: row.timeout_ms,
    failure_threshold: row.failure_threshold,
    tags: JSON.parse(row.tags),
    group_id: row.group_id,
    regions: JSON.parse(row.regions),
    enabled: row.enabled === 1,
  };
}

/** Load all enabled checks from D1 */
export async function loadChecks(db: D1Database): Promise<CheckConfig[]> {
  const result = await db.prepare('SELECT * FROM checks WHERE enabled = 1').all<CheckRow>();
  return result.results.map(parseCheckRow);
}

/** Load all checks from D1 (including disabled) */
export async function loadAllChecks(db: D1Database): Promise<CheckConfig[]> {
  const result = await db.prepare('SELECT * FROM checks ORDER BY created_at').all<CheckRow>();
  return result.results.map(parseCheckRow);
}

/** Load a single check by ID */
export async function loadCheck(db: D1Database, id: string): Promise<CheckConfig | null> {
  const result = await db.prepare('SELECT * FROM checks WHERE id = ?').bind(id).first<CheckRow>();
  return result ? parseCheckRow(result) : null;
}

/** Create a new check */
export async function createCheck(db: D1Database, check: Partial<CheckConfig> & { id: string; name: string; url: string }): Promise<void> {
  await db.prepare(`
    INSERT INTO checks (id, name, type, url, method, headers, body, assertions, retry_count, retry_delay_ms, timeout_ms, failure_threshold, tags, group_id, regions, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    check.id,
    check.name,
    check.type ?? 'api',
    check.url,
    check.method ?? 'GET',
    JSON.stringify(check.headers ?? {}),
    check.body ?? null,
    JSON.stringify(check.assertions ?? [{ type: 'statusCode', operator: 'is', value: 200 }]),
    check.retry_count ?? 0,
    check.retry_delay_ms ?? 300,
    check.timeout_ms ?? 10000,
    check.failure_threshold ?? 2,
    JSON.stringify(check.tags ?? []),
    check.group_id ?? null,
    JSON.stringify(check.regions ?? ['default']),
    check.enabled === false ? 0 : 1,
  ).run();
}

/** Update an existing check (partial update) */
export async function updateCheck(db: D1Database, id: string, updates: Partial<CheckConfig>): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, (v: unknown) => unknown> = {
    name: (v) => v,
    type: (v) => v,
    url: (v) => v,
    method: (v) => v,
    headers: (v) => JSON.stringify(v),
    body: (v) => v,
    assertions: (v) => JSON.stringify(v),
    retry_count: (v) => v,
    retry_delay_ms: (v) => v,
    timeout_ms: (v) => v,
    failure_threshold: (v) => v,
    tags: (v) => JSON.stringify(v),
    group_id: (v) => v,
    regions: (v) => JSON.stringify(v),
    enabled: (v) => v ? 1 : 0,
  };

  for (const [key, transform] of Object.entries(fieldMap)) {
    if (key in updates) {
      fields.push(`${key} = ?`);
      values.push(transform((updates as Record<string, unknown>)[key]));
    }
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const result = await db.prepare(
    `UPDATE checks SET ${fields.join(', ')} WHERE id = ?`,
  ).bind(...values).run();

  return result.meta.changes > 0;
}

/** Delete a check */
export async function deleteCheck(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM checks WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

/** Toggle check enabled/disabled */
export async function toggleCheck(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE checks SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?",
  ).bind(id).run();
  return result.meta.changes > 0;
}

// ── Incidents ──

/** Create an incident (on state transition to degraded/unhealthy) */
export async function createIncident(db: D1Database, checkId: string, type: string, error: string | null): Promise<void> {
  await db.prepare(
    'INSERT INTO incidents (check_id, type, started_at, trigger_error) VALUES (?, ?, datetime(\'now\'), ?)',
  ).bind(checkId, type, error).run();
}

/** Resolve open incidents for a check (on recovery) */
export async function resolveIncidents(db: D1Database, checkId: string): Promise<void> {
  await db.prepare(`
    UPDATE incidents
    SET resolved_at = datetime('now'),
        duration_s = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER)
    WHERE check_id = ? AND resolved_at IS NULL
  `).bind(checkId).run();
}

/** List incidents */
export async function listIncidents(
  db: D1Database,
  options: { checkId?: string; status?: 'open' | 'resolved'; limit?: number } = {},
): Promise<Incident[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.checkId) {
    conditions.push('check_id = ?');
    params.push(options.checkId);
  }
  if (options.status === 'open') {
    conditions.push('resolved_at IS NULL');
  } else if (options.status === 'resolved') {
    conditions.push('resolved_at IS NOT NULL');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? 50;

  const result = await db.prepare(
    `SELECT * FROM incidents ${where} ORDER BY started_at DESC LIMIT ?`,
  ).bind(...params, limit).all<Incident>();

  return result.results;
}

// ── Alert Rules ──

/** Load alert rules matching a check */
export async function loadAlertRules(db: D1Database, checkId: string, groupId: string | null): Promise<AlertRule[]> {
  const result = await db.prepare(`
    SELECT * FROM alert_rules
    WHERE enabled = 1
      AND (check_id IS NULL OR check_id = ?)
      AND (group_id IS NULL OR group_id = ?)
  `).bind(checkId, groupId).all<AlertRule>();

  return result.results.map((row) => ({
    ...row,
    config: JSON.parse(row.config as unknown as string),
    on_failure: Boolean(row.on_failure),
    on_recovery: Boolean(row.on_recovery),
    enabled: Boolean(row.enabled),
  }));
}

/** Load all alert rules */
export async function loadAllAlertRules(db: D1Database): Promise<AlertRule[]> {
  const result = await db.prepare('SELECT * FROM alert_rules ORDER BY id').all<AlertRule>();
  return result.results.map(parseAlertRuleRow);
}

function parseAlertRuleRow(row: AlertRule): AlertRule {
  return {
    ...row,
    config: JSON.parse(row.config as unknown as string),
    on_failure: Boolean(row.on_failure),
    on_recovery: Boolean(row.on_recovery),
    enabled: Boolean(row.enabled),
  };
}

/** Create an alert rule */
export async function createAlertRule(
  db: D1Database,
  rule: { channel: string; check_id?: string | null; group_id?: string | null; config?: Record<string, unknown>; on_failure?: boolean; on_recovery?: boolean; enabled?: boolean },
): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO alert_rules (check_id, group_id, channel, config, on_failure, on_recovery, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    rule.check_id ?? null,
    rule.group_id ?? null,
    rule.channel,
    JSON.stringify(rule.config ?? {}),
    rule.on_failure === false ? 0 : 1,
    rule.on_recovery === false ? 0 : 1,
    rule.enabled === false ? 0 : 1,
  ).run();

  return result.meta.last_row_id;
}

/** Delete an alert rule */
export async function deleteAlertRule(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM alert_rules WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

// ── Maintenance Windows ──

/** Check if a check is in a maintenance window right now */
export async function isInMaintenance(db: D1Database, checkId: string, groupId: string | null): Promise<MaintenanceWindow | null> {
  const result = await db.prepare(`
    SELECT * FROM maintenance_windows
    WHERE datetime('now') BETWEEN starts_at AND ends_at
      AND (check_id IS NULL OR check_id = ?)
      AND (group_id IS NULL OR group_id = ?)
    LIMIT 1
  `).bind(checkId, groupId).first<MaintenanceWindow>();

  return result ?? null;
}

/** List maintenance windows */
export async function listMaintenanceWindows(db: D1Database): Promise<MaintenanceWindow[]> {
  const result = await db.prepare('SELECT * FROM maintenance_windows ORDER BY starts_at DESC').all<MaintenanceWindow>();
  return result.results.map((row) => ({
    ...row,
    suppress_alerts: Boolean(row.suppress_alerts),
    skip_checks: Boolean(row.skip_checks),
  }));
}

/** Create a maintenance window */
export async function createMaintenanceWindow(
  db: D1Database,
  window: { starts_at: string; ends_at: string; check_id?: string | null; group_id?: string | null; reason?: string | null; suppress_alerts?: boolean; skip_checks?: boolean },
): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO maintenance_windows (check_id, group_id, starts_at, ends_at, reason, suppress_alerts, skip_checks)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    window.check_id ?? null,
    window.group_id ?? null,
    window.starts_at,
    window.ends_at,
    window.reason ?? null,
    window.suppress_alerts === false ? 0 : 1,
    window.skip_checks ? 1 : 0,
  ).run();

  return result.meta.last_row_id;
}

/** Delete a maintenance window */
export async function deleteMaintenanceWindow(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM maintenance_windows WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}
