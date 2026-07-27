import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, type CheckDetail, type IncidentRow, type ResultRow, type StatusRow } from './api';
import { LABEL, clockTime, formatDuration, percentile, timeAgo, timestamp, tone, uptimePercent } from './format';

interface Props {
  row: StatusRow | null;
  results: ResultRow[];
  onClose: () => void;
}

export function Drawer({ row, results, onClose }: Props) {
  const [detail, setDetail] = useState<CheckDetail | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!row) return;
    setDetail(null);
    setIncidents([]);
    closeRef.current?.focus();

    let cancelled = false;
    void Promise.all([api.check(row.id), api.incidents(row.id)])
      .then(([check, list]) => {
        if (cancelled) return;
        setDetail(check);
        setIncidents(list.incidents);
      })
      .catch(() => {
        /* Detail is supplementary; the summary above is already rendered. */
      });

    return () => {
      cancelled = true;
    };
  }, [row]);

  /** Keep focus inside the panel while it is open. */
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;

    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const uptime = uptimePercent(results);
  const p95 = percentile(
    results.filter((r) => r.success).map((r) => r.responseTimeMs),
    0.95,
  );

  return (
    <>
      <div className={`scrim${row ? ' open' : ''}`} onClick={onClose} />
      <aside
        ref={panelRef}
        className={`drawer${row ? ' open' : ''}`}
        aria-hidden={row ? 'false' : 'true'}
        aria-label="Check detail"
        onKeyDown={onKeyDown}
      >
        {row && (
          <>
            <header>
              <div className="t">
                <h2>{row.name}</h2>
                <div className="u">
                  {detail?.method ?? 'GET'} {row.url}
                </div>
              </div>
              <button ref={closeRef} className="iconbtn" type="button" aria-label="Close detail" onClick={onClose}>
                ✕
              </button>
            </header>

            <div className="body">
              <section className="sec">
                <h3>Current</h3>
                <dl className="kv">
                  <dt>Status</dt>
                  <dd>
                    <span className={`pill ${tone(row.status)}`}>{LABEL[row.status]}</span>
                  </dd>
                  <dt>Last run</dt>
                  <dd>{row.lastCheckAt ? `${clockTime(row.lastCheckAt)} · ${timeAgo(row.lastCheckAt)}` : 'never'}</dd>
                  <dt>Latency</dt>
                  <dd>{row.lastResponseMs === null ? '—' : `${row.lastResponseMs}ms`}</dd>
                  <dt>Uptime 24h</dt>
                  <dd>{uptime === null ? '—' : `${uptime.toFixed(2)}%`}</dd>
                  <dt>p95</dt>
                  <dd>{p95 === null ? '—' : `${p95}ms`}</dd>
                  {row.downSince && (
                    <>
                      <dt>Down for</dt>
                      <dd>{formatDuration(Date.now() - Date.parse(row.downSince))}</dd>
                    </>
                  )}
                  <dt>Tags</dt>
                  <dd>{row.tags.length > 0 ? row.tags.join(', ') : '—'}</dd>
                </dl>
                {row.lastError && (
                  <div className="assert" style={{ marginTop: 10 }}>
                    <span className="mark">✕</span>
                    <span className="txt">{row.lastError}</span>
                  </div>
                )}
              </section>

              <section className="sec">
                <h3>Assertions</h3>
                {detail === null ? (
                  <p className="hint">Loading…</p>
                ) : detail.assertions.length === 0 ? (
                  <div className="assert">
                    <span className="mark">·</span>
                    <span className="txt">status is 200 (default)</span>
                  </div>
                ) : (
                  detail.assertions.map((assertion, index) => (
                    <div className="assert" key={index}>
                      <span className="mark">·</span>
                      <span className="txt">{describeAssertion(assertion)}</span>
                    </div>
                  ))
                )}
              </section>

              <section className="sec">
                <h3>Recent incidents</h3>
                {incidents.length === 0 ? (
                  <p className="hint">No incidents recorded.</p>
                ) : (
                  incidents.map((incident) => (
                    <div className="inc" key={incident.id}>
                      <span className="when">{timestamp(incident.startedAt)}</span>
                      <span className="what">
                        {incident.resolvedAt ? (
                          <>
                            Resolved{' '}
                            <span className="dur">
                              after {incident.durationMs ? formatDuration(incident.durationMs) : '—'}
                            </span>
                          </>
                        ) : (
                          <>
                            Down{' '}
                            <span className="dur">
                              ongoing, {formatDuration(Date.now() - Date.parse(incident.startedAt))}
                            </span>
                          </>
                        )}
                        {incident.annotation && <span className="note">{incident.annotation}</span>}
                      </span>
                    </div>
                  ))
                )}
              </section>

              {detail && Object.keys(detail.headers).length > 0 && (
                <section className="sec">
                  <h3>Request headers</h3>
                  <dl className="kv">
                    {Object.entries(detail.headers).map(([key, value]) => (
                      <div key={key} style={{ display: 'contents' }}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="hint">
                    Secrets are stored by reference. Values resolve from Worker secrets at run time
                    and never touch the database.
                  </p>
                </section>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function describeAssertion(assertion: Record<string, unknown>): string {
  const type = String(assertion.type ?? 'unknown');
  const operator = String(assertion.operator ?? '');
  const value = String(assertion.value ?? '');

  switch (type) {
    case 'statusCode':
      return `status ${operator === 'isNot' ? 'is not' : 'is'} ${value}`;
    case 'header':
      return `header "${String(assertion.name)}" ${operator} ${value}`;
    case 'body':
      return `body ${operator} "${value}"`;
    case 'responseTime':
      return `response time under ${value}ms`;
    case 'jsonPath':
      return `${String(assertion.path)} ${operator} ${value}`;
    default:
      return type;
  }
}
