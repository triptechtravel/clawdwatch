/**
 * Notifier dispatch.
 *
 * One rule above all: a failing notifier must never take down a run, and must
 * never prevent the other notifiers from firing. In v2 a single `onAlert`
 * callback was awaited inline and its result never inspected — a delivery that
 * 404'd looked exactly like a delivery that worked, which is how a broken
 * alert path survived unnoticed in production.
 *
 * So every delivery here is isolated, retried once, and reported.
 */

import type { AlertEvent, Notifier, NotifierContext } from '../types';

export interface DeliveryReport {
  notifier: string;
  kind: AlertEvent['kind'];
  ok: boolean;
  error?: string;
  attempts: number;
}

export interface DispatchOptions {
  retries?: number;
  retryDelayMs?: number;
  onReport?: (report: DeliveryReport) => void;
}

function wants(notifier: Notifier<never>, kind: AlertEvent['kind']): boolean {
  return notifier.on === undefined || notifier.on.includes(kind);
}

/**
 * Deliver every event to every interested notifier.
 *
 * Notifiers run concurrently; each event is delivered in order to a given
 * notifier so a `summary` never overtakes the `opened` it summarises.
 */
export async function dispatch<TEnv>(
  events: AlertEvent[],
  notifiers: Notifier<TEnv>[],
  ctx: NotifierContext<TEnv>,
  opts: DispatchOptions = {},
): Promise<DeliveryReport[]> {
  if (events.length === 0 || notifiers.length === 0) return [];

  const retries = opts.retries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  const reports: DeliveryReport[] = [];

  await Promise.all(
    notifiers.map(async (notifier) => {
      for (const event of events) {
        if (!wants(notifier as Notifier<never>, event.kind)) continue;

        let attempts = 0;
        let lastError: unknown;

        while (attempts <= retries) {
          attempts++;
          try {
            await notifier.notify(event, ctx);
            const report: DeliveryReport = { notifier: notifier.name, kind: event.kind, ok: true, attempts };
            reports.push(report);
            opts.onReport?.(report);
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            if (attempts <= retries) await sleep(retryDelayMs);
          }
        }

        if (lastError !== undefined) {
          const message = lastError instanceof Error ? lastError.message : String(lastError);
          const report: DeliveryReport = {
            notifier: notifier.name,
            kind: event.kind,
            ok: false,
            error: message,
            attempts,
          };
          reports.push(report);
          opts.onReport?.(report);
          console.error(
            `[clawdwatch] notifier "${notifier.name}" failed to deliver "${event.kind}" after ${attempts} attempt(s): ${message}`,
          );
        }
      }
    }),
  );

  return reports;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
