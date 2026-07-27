import { useRef, useState, type KeyboardEvent } from 'react';
import type { ResultRow } from './api';
import { clockTime } from './format';

/**
 * The signature element: one mark per check run.
 *
 * Colour encodes status, height encodes latency against this check's own
 * ceiling. Deliberately discrete rather than a smoothed sparkline — a cron
 * produces discrete samples, and interpolating between them would assert
 * measurements that were never taken.
 *
 * Healthy marks are quieted in CSS so amber and red carry the page: a healthy
 * fleet should read as calm, not as several hundred bright green bars.
 */

interface Props {
  results: ResultRow[];
  onTip: (text: string | null, anchor?: DOMRect) => void;
}

function toneOf(result: ResultRow): 'ok' | 'warn' | 'down' {
  if (!result.success) return result.statusCode === null ? 'down' : 'warn';
  return 'ok';
}

function describe(result: ResultRow): string {
  const when = clockTime(result.ranAt);
  if (!result.success) {
    return result.statusCode === null
      ? `${when} · failed`
      : `${when} · ${result.statusCode} · ${result.responseTimeMs}ms`;
  }
  return `${when} · ${result.responseTimeMs}ms`;
}

export function TickStrip({ results, onTip }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  if (results.length === 0) {
    return <div className="ticks-empty">no results yet</div>;
  }

  const ceiling = Math.max(...results.map((r) => r.responseTimeMs), 1);

  function show(index: number) {
    const node = ref.current?.children[index] as HTMLElement | undefined;
    if (node) onTip(describe(results[index]), node.getBoundingClientRect());
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();

    const start = selected ?? results.length;
    const next = Math.max(
      0,
      Math.min(results.length - 1, start + (event.key === 'ArrowRight' ? 1 : -1)),
    );
    setSelected(next);
    show(next);
  }

  return (
    <div
      ref={ref}
      className="ticks"
      tabIndex={0}
      role="img"
      aria-label={`Last ${results.length} runs. Use arrow keys to inspect individual samples.`}
      onKeyDown={onKeyDown}
      onBlur={() => {
        setSelected(null);
        onTip(null);
      }}
      onMouseLeave={() => onTip(null)}
    >
      {results.map((result, index) => {
        const height = result.success
          ? Math.max(14, (result.responseTimeMs / ceiling) * 100)
          : 100;
        return (
          <i
            key={`${result.ranAt}-${index}`}
            className={`${toneOf(result)}${selected === index ? ' sel' : ''}`}
            style={{ height: `${height}%` }}
            onMouseEnter={(e) => onTip(describe(result), e.currentTarget.getBoundingClientRect())}
          />
        );
      })}
    </div>
  );
}
