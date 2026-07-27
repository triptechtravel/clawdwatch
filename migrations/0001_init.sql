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
CREATE TABLE IF NOT EXISTS check_state (
  check_id            TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
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
