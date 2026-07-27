-- clawdwatch v3 — initial schema.
--
-- One storage system: D1. (v2 split hot state into an R2 JSON blob and
-- history into Analytics Engine that nothing ever read.)
--
-- Columns are snake_case; the mapping to camelCase domain types lives in
-- src/engine/store/d1.ts and nowhere else.
--
-- Secret values must never be stored here. Header and body values may
-- contain ${NAME} references only; the write-time guard in
-- src/engine/secrets.ts rejects anything else.

CREATE TABLE IF NOT EXISTS checks (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  url                 TEXT NOT NULL,
  method              TEXT NOT NULL DEFAULT 'GET',
  headers             TEXT NOT NULL DEFAULT '{}',   -- JSON object, ${REF} values only
  body                TEXT,
  assertions          TEXT NOT NULL DEFAULT '[]',   -- JSON array
  retry_count         INTEGER NOT NULL DEFAULT 1,
  retry_delay_ms      INTEGER NOT NULL DEFAULT 5000,
  timeout_ms          INTEGER NOT NULL DEFAULT 10000,
  failure_threshold   INTEGER NOT NULL DEFAULT 3,
  reminder_interval_ms INTEGER,                     -- NULL disables reminders
  interval_mins       INTEGER NOT NULL DEFAULT 5,
  tags                TEXT NOT NULL DEFAULT '[]',   -- JSON array
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_checks_enabled ON checks (enabled);

-- Hot state for the alert machine. One row per check.
-- last_alert_at is what makes reminders expressible.
--
-- Deliberately NOT a foreign key to checks(id). A run writes every check's
-- result and state in one batch; if a check were deleted mid-run, an FK
-- violation would fail the whole batch and silently lose that tick for every
-- other check too. State is derived data, deleteCheck() clears it explicitly,
-- and an orphaned row is inert — loadStates only ever reads state for checks
-- that still exist.
CREATE TABLE IF NOT EXISTS check_state (
  check_id            TEXT PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'unknown',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_check_at       TEXT,
  last_success_at     TEXT,
  last_error          TEXT,
  last_response_ms    INTEGER,
  down_since          TEXT,
  last_alert_at       TEXT,
  incident_id         TEXT
);

-- Rolling result history. Pruned to the configured retention window.
-- Stores no response bodies — only assertion failure summaries.
CREATE TABLE IF NOT EXISTS check_results (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id            TEXT NOT NULL,
  success             INTEGER NOT NULL,
  status_code         INTEGER,
  response_time_ms    INTEGER NOT NULL,
  error               TEXT,
  ran_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_check_results_lookup ON check_results (check_id, ran_at);
CREATE INDEX IF NOT EXISTS idx_check_results_ran_at ON check_results (ran_at);

CREATE TABLE IF NOT EXISTS incidents (
  id                  TEXT PRIMARY KEY,
  check_id            TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  resolved_at         TEXT,
  duration_ms         INTEGER,
  trigger_error       TEXT,
  annotation          TEXT            -- triage note from an agent or inline AI
);

CREATE INDEX IF NOT EXISTS idx_incidents_check ON incidents (check_id, started_at);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents (resolved_at);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id                  TEXT PRIMARY KEY,
  check_id            TEXT,            -- NULL + NULL tag = applies to everything
  tag                 TEXT,
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  reason              TEXT,
  suppress_alerts     INTEGER NOT NULL DEFAULT 1,
  skip_checks         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_maintenance_window ON maintenance_windows (starts_at, ends_at);

-- Notifier delivery log. Small and self-pruning: the dashboard needs "did the
-- last alert actually arrive?", which is precisely the question nobody could
-- answer when a broken alert path went unnoticed for months.
CREATE TABLE IF NOT EXISTS notifier_deliveries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  notifier            TEXT NOT NULL,
  event_kind          TEXT NOT NULL,
  ok                  INTEGER NOT NULL,
  error               TEXT,
  attempts            INTEGER NOT NULL DEFAULT 1,
  delivered_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_at ON notifier_deliveries (delivered_at);
