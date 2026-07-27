import { describe, it, expect } from 'vitest';
import {
  LABEL,
  clockTime,
  formatDuration,
  percentile,
  timeAgo,
  timestamp,
  tone,
  uptimePercent,
} from './format';

const NOW = Date.parse('2026-07-27T13:00:00.000Z');

describe('tone', () => {
  it('maps every status to a class token', () => {
    expect(tone('healthy')).toBe('ok');
    expect(tone('degraded')).toBe('warn');
    expect(tone('unhealthy')).toBe('down');
    expect(tone('unknown')).toBe('idle');
  });

  it('labels every status', () => {
    expect(Object.keys(LABEL).sort()).toEqual(['degraded', 'healthy', 'unhealthy', 'unknown']);
    // "Down" reads better than "Unhealthy" in a status pill.
    expect(LABEL.unhealthy).toBe('Down');
  });
});

describe('formatDuration', () => {
  it.each([
    [12_000, '12s'],
    [45 * 60_000, '45m'],
    [2 * 3_600_000, '2h'],
    [(2 * 60 + 10) * 60_000, '2h 10m'],
    [24 * 3_600_000, '1d'],
    [(24 + 3) * 3_600_000, '1d 3h'],
  ])('formats %i as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('clamps a negative duration rather than printing nonsense', () => {
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('timeAgo', () => {
  it('says never when there is no timestamp', () => {
    expect(timeAgo(null, NOW)).toBe('never');
  });

  it('collapses the last minute to "just now"', () => {
    expect(timeAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
  });

  it('reports older times as a duration', () => {
    expect(timeAgo(new Date(NOW - 18 * 60_000).toISOString(), NOW)).toBe('18m ago');
  });

  it('survives an unparseable timestamp', () => {
    expect(timeAgo('nonsense', NOW)).toBe('unknown');
  });
});

describe('timestamp', () => {
  it('shows only the time for today', () => {
    const today = new Date(NOW - 60 * 60_000).toISOString();
    expect(timestamp(today, NOW)).toBe(clockTime(today));
  });

  it('adds a date for anything older, so it cannot be misread as today', () => {
    const old = new Date(NOW - 3 * 86_400_000).toISOString();
    const rendered = timestamp(old, NOW);
    expect(rendered).not.toBe(clockTime(old));
    expect(rendered).toMatch(/\d+ \w+/);
  });

  it('survives an unparseable timestamp', () => {
    expect(timestamp('nonsense', NOW)).toBe('--:--');
  });
});

describe('uptimePercent', () => {
  it('is null with no samples rather than a misleading 100%', () => {
    expect(uptimePercent([])).toBeNull();
  });

  it('computes the success ratio', () => {
    expect(uptimePercent([{ success: true }, { success: true }, { success: false }])).toBeCloseTo(
      66.67,
      1,
    );
  });

  it('reports a total outage as zero', () => {
    expect(uptimePercent([{ success: false }])).toBe(0);
  });
});

describe('percentile', () => {
  it('is null with no values', () => {
    expect(percentile([], 0.95)).toBeNull();
  });

  it('picks the p95 sample', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(96);
  });

  it('never runs off the end of a short series', () => {
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2], 0.99)).toBe(2);
  });

  it('does not mutate the caller array', () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});
