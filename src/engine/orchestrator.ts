/**
 * One monitoring run: pick due checks, execute them concurrently, advance the
 * state machine, persist, and emit batched alert events.
 *
 * Two v2 defects are fixed structurally here:
 *   - checks ran serially in a `for … await` loop, so 10 checks × 10s timeout
 *     × retries could exhaust the cron's wall clock. Now a bounded pool.
 *   - alerts fired one-per-check inside that loop, so a 10-endpoint outage
 *     produced 10 separate notifications. Now transitions are collected and
 *     turned into per-check events plus a single `summary`.
 */

import type {
  AlertEvent,
  AlertLinks,
  CheckConfig,
  CheckResult,
  CheckState,
  CheckSummary,
  HeaderRule,
  SecretMap,
} from '../types';
import { toCheckSummary } from './secrets';
import { computeTransition, emptyState, type Transition } from './transition';
import { runCheck } from './runner';
import {
  activeMaintenance,
  insertResultStatement,
  listChecks,
  loadStates,
  openIncidentStatement,
  pruneResults,
  resolveIncidentStatement,
  saveStateStatement,
  windowFor,
} from './store/d1';

export interface RunOptions {
  db: D1Database;
  secrets: SecretMap;
  headerRules: HeaderRule[];
  resolveUrl: (url: string) => string;
  userAgent: string;
  concurrency: number;
  historyRetentionHours: number;
  baseUrl?: string;
  now?: () => number;
  makeId?: () => string;
}

export interface RunReport {
  ran: number;
  skipped: number;
  events: AlertEvent[];
  results: CheckResult[];
}

/** A check is due when its interval has elapsed, allowing for cron jitter. */
export function isDue(check: CheckConfig, state: CheckState, now: number): boolean {
  if (!state.lastCheckAt) return true;
  const elapsed = now - Date.parse(state.lastCheckAt);
  if (Number.isNaN(elapsed)) return true;
  const interval = check.intervalMins * 60_000;
  // Half-interval grace: a 5-minute check on a 5-minute cron must not skip a
  // tick merely because the cron fired a few seconds early.
  return elapsed >= interval / 2;
}

/** Run `tasks` with at most `limit` in flight. Order of results is preserved. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return out;
}

function linksFor(baseUrl: string | undefined, check: CheckConfig, incidentId?: string): AlertLinks {
  if (!baseUrl) return {};
  const base = baseUrl.replace(/\/+$/, '');
  const links: AlertLinks = {
    capabilities: `${base}/api/agent.md`,
    runNow: `${base}/api/checks/${encodeURIComponent(check.id)}/run`,
    maintenance: `${base}/api/maintenance`,
  };
  if (incidentId) {
    links.incident = `${base}/api/incidents/${encodeURIComponent(incidentId)}`;
    links.ack = `${base}/api/incidents/${encodeURIComponent(incidentId)}/ack`;
    links.annotate = `${base}/api/incidents/${encodeURIComponent(incidentId)}/annotate`;
  }
  return links;
}

export async function runMonitoringChecks(opts: RunOptions): Promise<RunReport> {
  const now = opts.now ?? (() => Date.now());
  const makeId = opts.makeId ?? (() => crypto.randomUUID());
  const startedAt = now();
  const nowIso = new Date(startedAt).toISOString();

  const [checks, states, windows] = await Promise.all([
    listChecks(opts.db, true),
    loadStates(opts.db),
    activeMaintenance(opts.db, nowIso),
  ]);

  const due: CheckConfig[] = [];
  let skipped = 0;

  for (const check of checks) {
    const state = states.get(check.id) ?? emptyState(check.id);
    const window = windowFor(windows, check);
    if (window?.skipChecks || !isDue(check, state, startedAt)) {
      skipped++;
      continue;
    }
    due.push(check);
  }

  const results = await pooled(due, opts.concurrency, (check) =>
    runCheck(check, {
      resolvedUrl: opts.resolveUrl(check.url),
      headerRules: opts.headerRules,
      secrets: opts.secrets,
      userAgent: opts.userAgent,
      now,
    }),
  );

  const writes: D1PreparedStatement[] = [];
  const opened: Array<{ check: CheckConfig; state: CheckState; result: CheckResult }> = [];
  const recovered: Array<{ check: CheckConfig; state: CheckState; downtimeMs: number }> = [];
  const reminders: Array<{
    check: CheckConfig;
    state: CheckState;
    result: CheckResult;
    downSinceMs: number;
  }> = [];
  const stillDown: CheckSummary[] = [];
  const suppressed = new Set<string>();

  for (let i = 0; i < due.length; i++) {
    const check = due[i];
    const result = results[i];
    const prev = states.get(check.id) ?? emptyState(check.id);
    const incidentId = makeId();

    const { state, transition } = computeTransition(prev, result, check, now(), incidentId);
    states.set(check.id, state);

    writes.push(insertResultStatement(opts.db, result));
    writes.push(saveStateStatement(opts.db, state));

    const window = windowFor(windows, check);
    if (window?.suppressAlerts) suppressed.add(check.id);

    collect(transition, check, state, prev, result);
  }

  function collect(
    transition: Transition,
    check: CheckConfig,
    state: CheckState,
    prev: CheckState,
    result: CheckResult,
  ) {
    switch (transition.kind) {
      case 'opened':
        writes.push(
          openIncidentStatement(opts.db, {
            id: state.incidentId!,
            checkId: check.id,
            startedAt: state.downSince ?? new Date(now()).toISOString(),
            triggerError: result.error,
          }),
        );
        opened.push({ check, state, result });
        break;

      case 'recovered':
        if (prev.incidentId) {
          writes.push(
            resolveIncidentStatement(
              opts.db,
              prev.incidentId,
              new Date(now()).toISOString(),
              transition.downtimeMs,
            ),
          );
        }
        recovered.push({ check, state: prev, downtimeMs: transition.downtimeMs });
        break;

      case 'reminder':
        reminders.push({ check, state, result, downSinceMs: transition.downSinceMs });
        break;

      case 'none':
        if (state.status === 'unhealthy') stillDown.push(toCheckSummary(check, state.status));
        break;
    }
  }

  if (writes.length > 0) await opts.db.batch(writes);
  await pruneResults(opts.db, opts.historyRetentionHours).catch((err) => {
    console.error('[clawdwatch] pruning check_results failed:', err);
  });

  const at = new Date(now()).toISOString();
  const events: AlertEvent[] = [];

  for (const { check, state, result } of opened) {
    if (suppressed.has(check.id)) continue;
    events.push({
      kind: 'opened',
      at,
      check: toCheckSummary(check, state.status),
      failure: {
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        assertions: result.error ? result.error.split('; ') : [],
        consecutiveFailures: state.consecutiveFailures,
      },
      incidentId: state.incidentId!,
      links: linksFor(opts.baseUrl, check, state.incidentId!),
    });
  }

  for (const { check, state, downtimeMs } of recovered) {
    if (suppressed.has(check.id)) continue;
    events.push({
      kind: 'recovered',
      at,
      check: toCheckSummary(check, 'healthy'),
      downtimeMs,
      incidentId: state.incidentId ?? '',
      links: linksFor(opts.baseUrl, check, state.incidentId ?? undefined),
    });
  }

  for (const { check, state, result, downSinceMs } of reminders) {
    if (suppressed.has(check.id)) continue;
    events.push({
      kind: 'reminder',
      at,
      check: toCheckSummary(check, state.status),
      failure: {
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        assertions: result.error ? result.error.split('; ') : [],
        consecutiveFailures: state.consecutiveFailures,
      },
      downSinceMs,
      incidentId: state.incidentId ?? '',
      links: linksFor(opts.baseUrl, check, state.incidentId ?? undefined),
    });
  }

  // A summary only when something actually changed — a quiet run stays quiet.
  const openedSummaries = opened
    .filter((o) => !suppressed.has(o.check.id))
    .map((o) => toCheckSummary(o.check, o.state.status));
  const recoveredSummaries = recovered
    .filter((r) => !suppressed.has(r.check.id))
    .map((r) => toCheckSummary(r.check, 'healthy'));

  if (openedSummaries.length > 0 || recoveredSummaries.length > 0) {
    const anyDown = stillDown.length > 0 || openedSummaries.length > 0;
    events.push({
      kind: 'summary',
      at,
      opened: openedSummaries,
      recovered: recoveredSummaries,
      stillDown,
      allClear: recoveredSummaries.length > 0 && !anyDown,
      totalChecks: checks.length,
      links: opts.baseUrl ? { capabilities: `${opts.baseUrl.replace(/\/+$/, '')}/api/agent.md` } : {},
    });
  }

  return { ran: due.length, skipped, events, results };
}
