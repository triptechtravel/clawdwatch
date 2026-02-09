import { useState, useEffect, useCallback } from 'react';
import './Dashboard.css';

const REFRESH_INTERVAL = 60_000;
const MAX_HISTORY = 288;

interface HistoryEntry {
  timestamp: string;
  status: string;
  responseTimeMs: number;
  error: string | null;
}

interface CheckStatus {
  id: string;
  name: string;
  type: string;
  url: string;
  tags: string[];
  status: string;
  consecutiveFailures: number;
  lastCheck: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  responseTimeMs: number | null;
  history: HistoryEntry[];
  uptimePercent: number | null;
}

interface StatusResponse {
  overall: string;
  checks: CheckStatus[];
  lastRun: string | null;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'healthy': return 'Healthy';
    case 'degraded': return 'Degraded';
    case 'unhealthy': return 'Down';
    default: return 'Unknown';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'healthy': return '#4ade80';
    case 'degraded': return '#fbbf24';
    case 'unhealthy': return '#ef4444';
    default: return '#6b7280';
  }
}

function statusBgColor(status: string): string {
  switch (status) {
    case 'healthy': return 'rgba(74, 222, 128, 0.25)';
    case 'degraded': return 'rgba(251, 191, 36, 0.25)';
    case 'unhealthy': return 'rgba(239, 68, 68, 0.25)';
    default: return 'rgba(107, 114, 128, 0.25)';
  }
}

function formatTimeShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatMs(ms: number | null): string {
  if (ms === null) return '--';
  return `${ms}ms`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function Dashboard() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('./api/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const status = await res.json();
      setData(status);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load monitoring status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="cw-loading">
        <div className="cw-spinner" />
        <p>Loading monitoring status...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="cw-error-banner">
        <span>{error}</span>
        <button className="cw-btn" onClick={() => { setError(null); fetchData(); }}>
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const allHistory = data.checks.flatMap((c) => c.history);
  const totalSuccess = allHistory.filter((h) => h.status === 'healthy').length;
  const overallUptime = allHistory.length > 0
    ? Math.round((totalSuccess / allHistory.length) * 10000) / 100
    : null;

  return (
    <div className="cw-page">
      <HeroSection
        overall={data.overall}
        lastRun={data.lastRun}
        overallUptime={overallUptime}
        checkCount={data.checks.length}
        onRefresh={fetchData}
      />
      <div className="cw-checks-grid">
        {data.checks.map((check) => (
          <CheckCard key={check.id} check={check} />
        ))}
      </div>
      {data.checks.length === 0 && (
        <div className="cw-empty">
          <p>No monitoring checks configured.</p>
        </div>
      )}
    </div>
  );
}

function HeroSection({
  overall,
  lastRun,
  overallUptime,
  checkCount,
  onRefresh,
}: {
  overall: string;
  lastRun: string | null;
  overallUptime: number | null;
  checkCount: number;
  onRefresh: () => void;
}) {
  return (
    <div className={`cw-hero cw-hero-${overall}`}>
      <div className="cw-hero-left">
        <div className="cw-hero-status-row">
          <span className={`cw-dot cw-dot-${overall}`} style={{ width: 12, height: 12 }} />
          <h1 className="cw-hero-title">
            {overall === 'healthy'
              ? 'All Systems Operational'
              : overall === 'degraded'
                ? 'Partial Degradation'
                : 'Service Disruption'}
          </h1>
        </div>
        <div className="cw-hero-meta">
          <span className="cw-hero-stat">
            {checkCount} check{checkCount !== 1 ? 's' : ''} monitored
          </span>
          {overallUptime !== null && (
            <span className="cw-hero-stat">
              {overallUptime}% uptime (24h)
            </span>
          )}
          {lastRun && (
            <span className="cw-hero-stat">
              Last run: {timeAgo(lastRun)}
            </span>
          )}
        </div>
      </div>
      <button className="cw-btn" onClick={onRefresh}>Refresh</button>
    </div>
  );
}

function CheckCard({ check }: { check: CheckStatus }) {
  const history = padHistory(check.history);
  const maxResponseTime = Math.max(...history.map((h) => h?.responseTimeMs ?? 0), 1);

  return (
    <div className="cw-card">
      <div className="cw-card-header">
        <div className="cw-card-header-left">
          <span className={`cw-dot cw-dot-${check.status}`} />
          <h3 className="cw-card-name">{check.name}</h3>
        </div>
        <div className="cw-card-header-right">
          {check.uptimePercent !== null && (
            <span className="cw-uptime-pill" style={{
              backgroundColor: statusBgColor(check.uptimePercent >= 99 ? 'healthy' : check.uptimePercent >= 95 ? 'degraded' : 'unhealthy'),
              color: statusColor(check.uptimePercent >= 99 ? 'healthy' : check.uptimePercent >= 95 ? 'degraded' : 'unhealthy'),
            }}>
              {check.uptimePercent}%
            </span>
          )}
          <span className={`cw-status-badge cw-status-${check.status}`}>
            {statusLabel(check.status)}
          </span>
        </div>
      </div>

      <div className="cw-viz">
        <div className="cw-viz-label">Status</div>
        <StatusTimeline history={history} />
      </div>

      <div className="cw-viz">
        <div className="cw-viz-label">Response</div>
        <ResponseSparkline history={history} maxResponseTime={maxResponseTime} />
      </div>

      <div className="cw-card-footer">
        <div className="cw-card-footer-left">
          <span className="cw-footer-item">{formatMs(check.responseTimeMs)}</span>
          <span className="cw-footer-item cw-footer-muted">{timeAgo(check.lastCheck)}</span>
        </div>
        <div className="cw-card-tags">
          {check.tags.map((tag) => (
            <span key={tag} className="cw-tag">{tag}</span>
          ))}
        </div>
      </div>

      {check.lastError && check.status !== 'healthy' && (
        <div className="cw-card-error">{check.lastError}</div>
      )}
    </div>
  );
}

function padHistory(history: HistoryEntry[]): (HistoryEntry | null)[] {
  if (history.length >= MAX_HISTORY) return history.slice(-MAX_HISTORY);
  const padding: null[] = Array.from({ length: MAX_HISTORY - history.length }, () => null);
  return [...padding, ...history];
}

function StatusTimeline({ history }: { history: (HistoryEntry | null)[] }) {
  const [tooltip, setTooltip] = useState<{ x: number; entry: HistoryEntry } | null>(null);

  return (
    <div className="cw-timeline-container">
      <div className="cw-timeline-bar">
        {history.map((entry, i) => (
          <div
            key={i}
            className="cw-timeline-segment"
            style={{
              backgroundColor: entry ? statusColor(entry.status) : '#21262d',
            }}
            onMouseEnter={(e) => {
              if (entry) {
                const rect = (e.target as HTMLElement).getBoundingClientRect();
                const container = (e.target as HTMLElement).parentElement!.getBoundingClientRect();
                setTooltip({ x: rect.left - container.left + rect.width / 2, entry });
              }
            }}
            onMouseLeave={() => setTooltip(null)}
          />
        ))}
      </div>
      {tooltip && (
        <div className="cw-tooltip" style={{ left: `${tooltip.x}px` }}>
          <span className="cw-tooltip-status" style={{ color: statusColor(tooltip.entry.status) }}>
            {statusLabel(tooltip.entry.status)}
          </span>
          <span className="cw-tooltip-time">{formatTimeShort(tooltip.entry.timestamp)}</span>
          <span className="cw-tooltip-ms">{tooltip.entry.responseTimeMs}ms</span>
        </div>
      )}
      <div className="cw-timeline-labels">
        <span>24h ago</span>
        <span>Now</span>
      </div>
    </div>
  );
}

function ResponseSparkline({
  history,
  maxResponseTime,
}: {
  history: (HistoryEntry | null)[];
  maxResponseTime: number;
}) {
  const [tooltip, setTooltip] = useState<{ x: number; entry: HistoryEntry } | null>(null);

  return (
    <div className="cw-sparkline-container">
      <div className="cw-sparkline-bar">
        {history.map((entry, i) => {
          const height = entry
            ? Math.max((entry.responseTimeMs / maxResponseTime) * 100, 2)
            : 0;
          return (
            <div
              key={i}
              className="cw-sparkline-segment"
              onMouseEnter={(e) => {
                if (entry) {
                  const rect = (e.target as HTMLElement).getBoundingClientRect();
                  const container = (e.target as HTMLElement).parentElement!.getBoundingClientRect();
                  setTooltip({ x: rect.left - container.left + rect.width / 2, entry });
                }
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              <div
                className="cw-sparkline-fill"
                style={{
                  height: `${height}%`,
                  backgroundColor: entry ? statusColor(entry.status) : 'transparent',
                }}
              />
            </div>
          );
        })}
      </div>
      {tooltip && (
        <div className="cw-tooltip" style={{ left: `${tooltip.x}px` }}>
          <span className="cw-tooltip-ms">{tooltip.entry.responseTimeMs}ms</span>
          <span className="cw-tooltip-time">{formatTimeShort(tooltip.entry.timestamp)}</span>
        </div>
      )}
    </div>
  );
}
