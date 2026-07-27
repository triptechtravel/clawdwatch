import { env } from 'cloudflare:test';
import migration from '../migrations/0001_init.sql?raw';
import type { CheckConfig } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const TABLES = [
  'notifier_deliveries',
  'maintenance_windows',
  'incidents',
  'check_results',
  'check_state',
  'checks',
];

/**
 * Apply the shipped migration to the test database.
 *
 * This is the point of the suite: the same file operators run through
 * `wrangler d1 migrations apply` is the one the tests execute, so a schema
 * that drifts from the code fails here rather than on someone's first deploy.
 */
export async function migrate(): Promise<void> {
  // Strip comment lines before splitting: a naive split on ';' leaves chunks
  // that begin with a comment block, and dropping those would silently discard
  // the CREATE TABLE that follows them.
  const statements = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

/** Empty every table, preserving schema. */
export async function reset(): Promise<void> {
  for (const table of TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export function check(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    id: 'c1',
    name: 'Check One',
    url: 'https://api.example.com/health',
    method: 'GET',
    headers: {},
    body: null,
    assertions: [],
    retryCount: 0,
    retryDelayMs: 0,
    timeoutMs: 5000,
    failureThreshold: 2,
    reminderIntervalMs: null,
    intervalMins: 5,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

/** Count rows, for assertions about pruning and cascade deletes. */
export async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Rewind a check's last-run timestamp so the scheduler considers it due again.
 * Simulates elapsed time between cron ticks without a fake clock — runChecks
 * reads the wall clock, and isDue would otherwise skip a check invoked twice
 * in the same instant.
 */
export async function rewindLastCheck(checkId: string, minutes: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE check_state
     SET last_check_at = datetime(last_check_at, ?),
         down_since    = CASE WHEN down_since IS NULL THEN NULL
                              ELSE datetime(down_since, ?) END,
         last_alert_at = CASE WHEN last_alert_at IS NULL THEN NULL
                              ELSE datetime(last_alert_at, ?) END
     WHERE check_id = ?`,
  )
    .bind(`-${minutes} minutes`, `-${minutes} minutes`, `-${minutes} minutes`, checkId)
    .run();
}
