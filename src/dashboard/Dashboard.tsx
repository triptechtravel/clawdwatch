import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './dashboard.css';
import { api, type DeliveryRow, type ResultRow, type StatusRow } from './api';
import { LABEL, clockTime, formatDuration, percentile, timeAgo, tone, uptimePercent } from './format';
import { TickStrip } from './TickStrip';
import { Drawer } from './Drawer';

const REFRESH_MS = 60_000;
const TONES = ['ok', 'warn', 'down'] as const;

export function Dashboard() {
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [history, setHistory] = useState<Record<string, ResultRow[]>>({});
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const status = await api.status();
      setRows(status.checks);
      setGeneratedAt(status.generatedAt);
      setError(null);

      // History drives the tick strips; fetched per check but tolerant of
      // individual failures so one bad check can't blank the whole table.
      const entries = await Promise.all(
        status.checks.map(async (check) => {
          try {
            const { results } = await api.history(check.id);
            return [check.id, results] as const;
          } catch {
            return [check.id, []] as const;
          }
        }),
      );
      setHistory(Object.fromEntries(entries));

      try {
        setDeliveries((await api.deliveries()).deliveries);
      } catch {
        /* Notifier health is supplementary. */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const counts = useMemo(() => {
    const tally = { ok: 0, warn: 0, down: 0, idle: 0 };
    for (const row of rows) tally[tone(row.status)]++;
    return tally;
  }, [rows]);

  const tags = useMemo(
    () => [...new Set(rows.flatMap((r) => r.tags))].sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter.size > 0 && !statusFilter.has(tone(row.status))) return false;
      if (tagFilter.size > 0 && !row.tags.some((t) => tagFilter.has(t))) return false;
      if (needle) {
        const hay = `${row.name} ${row.url} ${row.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, query, statusFilter, tagFilter]);

  const allResults = useMemo(() => Object.values(history).flat(), [history]);
  const fleetUptime = uptimePercent(allResults);
  const fleetP95 = percentile(
    allResults.filter((r) => r.success).map((r) => r.responseTimeMs),
    0.95,
  );

  const worstDown = rows.find((r) => r.status === 'unhealthy' && r.downSince);
  const hasFilters = query !== '' || statusFilter.size > 0 || tagFilter.size > 0;

  const onTip = useCallback((text: string | null, anchor?: DOMRect) => {
    if (!text || !anchor) {
      setTip(null);
      return;
    }
    setTip({ text, x: anchor.left + anchor.width / 2, y: anchor.top });
    if (liveRef.current) liveRef.current.textContent = text;
  }, []);

  function toggle(set: Set<string>, value: string, apply: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  }

  const verdictTone = counts.down > 0 ? 'down' : counts.warn > 0 ? 'warn' : 'ok';
  const selectedRow = rows.find((r) => r.id === selected) ?? null;

  return (
    <>
      <div className="topbar">
        <div className="wordmark">
          <span className={`pulse ${verdictTone}`} style={{ color: `var(--${verdictTone})` }} aria-hidden="true" />
          clawdwatch
        </div>
        <div className="spacer" />
        <div className="lastrun">
          updated <b>{generatedAt ? clockTime(generatedAt) : '—'}</b>
        </div>
        <button className="btn" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="wrap">
        {error && <div className="error-banner">{error}</div>}

        <section className="summary" aria-label="Fleet summary">
          <div className="verdict">
            <div className="headline">
              <span className={`dot ${verdictTone}`} />
              {counts.down > 0
                ? `${counts.down} check${counts.down === 1 ? '' : 's'} down`
                : counts.warn > 0
                  ? `${counts.warn} check${counts.warn === 1 ? '' : 's'} degraded`
                  : rows.length === 0
                    ? 'No checks yet'
                    : 'All checks healthy'}
            </div>
            <div className="sub">
              {worstDown
                ? `${worstDown.name} · down ${formatDuration(Date.now() - Date.parse(worstDown.downSince!))}`
                : `Across ${rows.length} check${rows.length === 1 ? '' : 's'}`}
            </div>
          </div>

          <div className="fleet">
            <div className="fleetbar" role="img" aria-label="Estate health">
              {TONES.map((key) =>
                counts[key] > 0 ? (
                  <span
                    key={key}
                    className={`s-${key}`}
                    style={{ width: `${(counts[key] / Math.max(1, rows.length)) * 100}%` }}
                  />
                ) : null,
              )}
            </div>
            <div className="legend">
              {TONES.map((key) => (
                <i key={key}>
                  <span className={`dot ${key}`} />
                  {LABEL[key === 'ok' ? 'healthy' : key === 'warn' ? 'degraded' : 'unhealthy']}{' '}
                  <b>{counts[key]}</b>
                </i>
              ))}
            </div>
          </div>

          <div className="stat">
            <span className="k">Uptime 24h</span>
            <span className="v">{fleetUptime === null ? '—' : `${fleetUptime.toFixed(1)}%`}</span>
          </div>
          <div className="stat">
            <span className="k">p95 latency</span>
            <span className="v">
              {fleetP95 === null ? '—' : fleetP95}
              {fleetP95 !== null && <small>ms</small>}
            </span>
          </div>
        </section>

        <div className="toolbar">
          <input
            className="search"
            type="search"
            placeholder="Filter by name, URL or tag"
            aria-label="Filter checks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="chips" role="group" aria-label="Filter by status">
            {TONES.map((key) => (
              <button
                key={key}
                type="button"
                className={`chip st-${key}`}
                aria-pressed={statusFilter.has(key)}
                onClick={() => toggle(statusFilter, key, setStatusFilter)}
              >
                <span className={`dot ${key}`} />
                {LABEL[key === 'ok' ? 'healthy' : key === 'warn' ? 'degraded' : 'unhealthy']}
                <span className="n">{counts[key]}</span>
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Filter by tag">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="chip"
                aria-pressed={tagFilter.has(tag)}
                onClick={() => toggle(tagFilter, tag, setTagFilter)}
              >
                {tag}
              </button>
            ))}
          </div>
          {hasFilters && (
            <button
              type="button"
              className="chip clear"
              onClick={() => {
                setQuery('');
                setStatusFilter(new Set());
                setTagFilter(new Set());
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="sev" aria-label="Severity" />
                <th>Check</th>
                <th>Status</th>
                <th style={{ minWidth: 220 }}>Recent runs</th>
                <th className="num">Uptime</th>
                <th className="num">Latency</th>
                <th className="num">Last run</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const results = history[row.id] ?? [];
                const uptime = uptimePercent(results);
                return (
                  <tr
                    key={row.id}
                    className={`st-${tone(row.status)}${row.enabled ? '' : ' disabled'}`}
                    tabIndex={0}
                    aria-selected={selected === row.id}
                    onClick={() => setSelected(row.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(row.id);
                      }
                    }}
                  >
                    <td className="sev" />
                    <td>
                      <div className="name">{row.name}</div>
                      <span className="url">{row.url}</span>
                    </td>
                    <td>
                      <span className={`pill ${tone(row.status)}`}>{LABEL[row.status]}</span>
                    </td>
                    <td>
                      <TickStrip results={results} onTip={onTip} />
                      {results.length > 0 && (
                        <div className="tickscale">
                          <span>{clockTime(results[0].ranAt)}</span>
                          <span>now</span>
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {uptime === null ? <span className="weak">—</span> : <>{uptime.toFixed(1)}<span className="weak">%</span></>}
                    </td>
                    <td className="num">
                      {row.lastResponseMs === null ? (
                        <span className="weak">—</span>
                      ) : (
                        <>
                          {row.lastResponseMs}
                          <span className="weak">ms</span>
                        </>
                      )}
                    </td>
                    <td className="num">
                      <span className="weak">{timeAgo(row.lastCheckAt)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!loading && visible.length === 0 && (
            <div className="empty">
              {rows.length === 0 ? (
                <>
                  No checks yet. Add one with <code>POST /api/checks</code>, or see{' '}
                  <a href="api/agent.md">the API guide</a>.
                </>
              ) : (
                'No checks match that filter.'
              )}
            </div>
          )}
        </div>

        {deliveries.length > 0 && (
          <div className="notifiers" aria-label="Notifier health">
            {deliveries.map((delivery) => (
              <span
                key={delivery.notifier}
                className={`notifier${delivery.ok ? '' : ' failed'}`}
                title={delivery.error ?? undefined}
              >
                <span className={`dot ${delivery.ok ? 'ok' : 'down'}`} />
                <span className="who">{delivery.notifier}</span>
                <span className="when">
                  {delivery.ok ? 'delivered' : `failed after ${delivery.attempts}×`} ·{' '}
                  {timeAgo(delivery.deliveredAt)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="sr" aria-live="polite" ref={liveRef} />
      {tip && (
        <div className="tip show" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}

      <Drawer
        row={selectedRow}
        results={selectedRow ? (history[selectedRow.id] ?? []) : []}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
