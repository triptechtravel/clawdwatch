/** Presentation helpers, kept pure so they can be unit-tested. */

import type { Status } from './api';

export const LABEL: Record<Status, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unhealthy: 'Down',
  unknown: 'Unknown',
};

/** Status → the short class token used across the stylesheet. */
export function tone(status: Status): 'ok' | 'warn' | 'down' | 'idle' {
  switch (status) {
    case 'healthy':
      return 'ok';
    case 'degraded':
      return 'warn';
    case 'unhealthy':
      return 'down';
    default:
      return 'idle';
  }
}

/**
 * How long a delivery row stays evidence about a notifier.
 *
 * Rows are only written when an alert actually fires, so a quiet week leaves
 * the last row — success or failure — sitting there looking current. Past this
 * age it says nothing about whether the notifier works today.
 */
export const DELIVERY_STALE_MS = 24 * 3600_000;

/**
 * Tone for one notifier chip. `idle` means "we have not tried recently",
 * which is distinct from both healthy and broken and must not render as red:
 * a failure from six days ago otherwise pins the panel red until the next
 * alert happens to fire, which may be never.
 */
export function deliveryTone(
  delivery: { ok: boolean; deliveredAt: string },
  now = Date.now(),
): 'ok' | 'down' | 'idle' {
  const at = Date.parse(delivery.deliveredAt);
  if (Number.isNaN(at) || now - at >= DELIVERY_STALE_MS) return 'idle';
  return delivery.ok ? 'ok' : 'down';
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const rest = hours % 24;
    return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
  }
  if (hours > 0) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const delta = now - then;
  if (delta < 60_000) return 'just now';
  return `${formatDuration(delta)} ago`;
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A timestamp that stays unambiguous outside today. A bare `13:19` on a
 * three-day-old incident reads as "this afternoon", which is worse than no
 * time at all.
 */
export function timestamp(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? clockTime(iso)
    : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clockTime(iso)}`;
}

/** Percentage of non-failing samples. Null when there is nothing to measure. */
export function uptimePercent(results: Array<{ success: boolean }>): number | null {
  if (results.length === 0) return null;
  return (results.filter((r) => r.success).length / results.length) * 100;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}
