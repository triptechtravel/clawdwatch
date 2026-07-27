# Changelog

## 0.2.0

A rewrite. The public API has changed shape; there is no upgrade path from
0.1.x, which was never released outside its original deployment.

### Added

- **Secret references.** Checks reference credentials as `${NAME}` and the
  value is substituted only when the outbound request is built. A write
  containing a literal secret value is rejected. This is what makes a
  UI-editable, database-backed monitor safe to open-source, and it unblocks
  monitoring authenticated endpoints.
- **`headerRules`** — headers applied to every check on a matching host, for
  WAF-bypass tokens and similar.
- **Reminder alerts.** A check that stays down now re-alerts on a cadence.
  Previously a multi-day outage alerted exactly once.
- **Batched events.** `opened`, `recovered`, `reminder`, and a per-run
  `summary`, so a ten-endpoint outage is one notification rather than ten.
- **`slack()`** — Block Kit messages; set `SLACK_WEBHOOK_URL` and it is wired
  by default.
- **`webhook()`** — signed POST of the raw event, with `hmac()` or
  `serviceToken()` auth. This is also the entire AI-agent integration; an agent
  inbox is just a URL.
- **Delivery reporting.** Every alert delivery is recorded and surfaced at
  `GET /api/deliveries` and in the dashboard, so you can tell whether the last
  alert actually arrived.
- **Capability links.** Alerts carry short-lived signed URLs scoped to one
  action on one incident, letting a receiver act with no standing credential.
- **`GET /api/agent.md`** — the API described for agents, generated from the
  route table and tested against it in both directions.
- **Cloudflare Access authentication**, handling both identity JWTs (`email`)
  and service tokens (`common_name`).
- **Incident annotations**, so a triage note lands next to the outage.
- **A rebuilt dashboard** — one mark per check run rather than a smoothed line,
  fleet summary, filters, detail drawer, keyboard sample inspection, and both
  themes.
- **Migrations ship with the package**, and the integration suite applies them,
  so schema drift fails in CI.

### Changed

- **D1 is the only storage.** Hot state moved from an R2 JSON blob into a
  table, so a run's writes are one transaction.
- **Checks run concurrently** (six at a time) instead of serially. Ten checks
  at a ten-second timeout with retries could previously exceed the
  invocation's wall clock and lose an entire tick.
- **A failing notifier is isolated, retried once, and recorded.** Previously a
  single callback was awaited and its result never inspected, so a delivery
  that 404'd looked identical to one that worked.
- Domain types are camelCase; the snake_case mapping lives in one module.

### Removed

- **Analytics Engine.** Written to on every run and never read.
- **R2 state.** Superseded by the `check_state` table.
- **`alert_rules`, `check_groups`, `regions`** — schema nothing consulted.
- **`type: 'browser'`** — declared but never implemented.
- **Query-parameter API keys.** URLs leak into logs, and a shared static secret
  has no identity, expiry, or revocation.
- **Agent skill files.** Superseded by self-describing alerts and
  `/api/agent.md`, neither of which can drift or go uninstalled.

### Fixed

- `check_state` no longer has a foreign key to `checks`. A run writes every
  check's result and state in one batch; deleting a check mid-run would fail
  the whole batch and silently lose that tick for every other check.
- The response-body cap is byte-exact rather than chunk-granular. A single
  oversized chunk was previously accepted whole, so the limit did nothing.
- A `/g` regex in a header rule no longer carries `lastIndex` between checks
  and intermittently fails to match.
