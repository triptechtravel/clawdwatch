# Configuration

## createMonitor

```ts
const monitor = createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,
  secrets: (env) => ({ SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL }),
  baseUrl: (env) => env.BASE_URL,
  auth: (env) => ({ teamDomain: env.CF_ACCESS_TEAM_DOMAIN, aud: env.CF_ACCESS_AUD }),
  notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })],
  headerRules: [],
  resolveUrl: (url, env) => url,
  defaults: {},
});
```

| Option | Required | Purpose |
|---|---|---|
| `d1` | yes | The D1 binding holding checks, state, and history |
| `secrets` | no | Values that checks and notifiers reference as `${NAME}` |
| `baseUrl` | no | Public URL, used to build the links inside alerts |
| `auth` | no | Access configuration. Without it, writes are refused |
| `notifiers` | no | Where alerts go. Defaults to Slack if `SLACK_WEBHOOK_URL` is set |
| `headerRules` | no | Headers applied to every check on a matching host |
| `resolveUrl` | no | Rewrites check URLs at run time, e.g. `{{BASE_URL}}` |
| `defaults` | no | Fallbacks for check options and run behaviour |

### defaults

| Key | Default | Notes |
|---|---|---|
| `failureThreshold` | `3` | Consecutive failures before a check is unhealthy |
| `timeoutMs` | `10000` | Per-request timeout |
| `retryCount` | `1` | Retries on failure only; a passing check never retries |
| `retryDelayMs` | `5000` | Wait between retries |
| `reminderIntervalMs` | `3600000` | Re-alert cadence while down. `null` disables |
| `intervalMins` | `5` | How often a check runs |
| `concurrency` | `6` | Checks executed at once |
| `historyRetentionHours` | `48` | How long results are kept |
| `userAgent` | `clawdwatch/3.0` | Sent unless a check overrides it |
| `captureBodyOnFailure` | `false` | Keep a scrubbed excerpt of a **failing** response. See [AI agents](/integration/agents#giving-the-agent-the-evidence) |

## Check options

```json
{
  "id": "api-health",
  "name": "API Health",
  "url": "https://api.example.com/health",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": "{\"query\":\"{__typename}\"}",
  "assertions": [{ "type": "statusCode", "operator": "is", "value": 200 }],
  "retryCount": 1,
  "retryDelayMs": 5000,
  "timeoutMs": 10000,
  "failureThreshold": 3,
  "reminderIntervalMs": 3600000,
  "intervalMins": 5,
  "tags": ["production", "api"],
  "enabled": true,
  "captureBodyOnFailure": false
}
```

`id` may contain letters, digits, `.`, `_`, and `-`. Everything except `id`,
`name`, and `url` is optional.

### Intervals and the cron

`intervalMins` cannot make a check run more often than your cron trigger fires.
With the default `*/5 * * * *`, a check asking for one minute still runs every
five.

Scheduling allows half an interval of slack, so a cron firing a few seconds
early does not skip a tick and silently turn a five-minute check into a
ten-minute one.

## Assertions

Every assertion must pass. Failures are reported together, so one run tells you
everything that was wrong.

### statusCode

```json
{ "type": "statusCode", "operator": "is", "value": 200 }
```

Operators: `is`, `isNot`.

### header

```json
{ "type": "header", "name": "content-type", "operator": "contains", "value": "json" }
```

Operators: `is`, `isNot`, `contains`, `notContains`, `matches`.

### body

```json
{ "type": "body", "operator": "contains", "value": "\"healthy\"" }
```

Operators: `contains`, `notContains`, `matches`.

### responseTime

```json
{ "type": "responseTime", "operator": "lessThan", "value": 3000 }
```

Measured from request start to response headers.

### jsonPath

```json
{ "type": "jsonPath", "path": "$.data.status", "operator": "is", "value": "ok" }
```

Operators: `is`, `isNot`, `contains`, `notContains`, `matches`, `lessThan`,
`greaterThan`.

Path syntax is deliberately small: `$.field`, `$.nested.field`,
`$.array[0].field`. No wildcards, no recursive descent. A missing path fails
the assertion. Non-string values are stringified before comparison, so
`$.count` compares against `"42"`.

Use `isNot` with an empty string to assert a field is present and non-empty:

```json
{ "type": "jsonPath", "path": "$.data.token", "operator": "isNot", "value": "" }
```

## Maintenance windows

A window suppresses alerts, skips checks entirely, or both. It can target one
check, a tag, or everything.

```sql
INSERT INTO maintenance_windows
  (id, check_id, tag, starts_at, ends_at, reason, suppress_alerts, skip_checks)
VALUES
  ('deploy-friday', NULL, 'production', '2026-08-01T22:00:00Z',
   '2026-08-01T23:30:00Z', 'Planned deploy', 1, 0);
```

With `suppress_alerts`, checks still run and history still records the outage —
you just are not paged for it. That is usually what you want: the dashboard
should still show what happened.

## Config as code

Export every check, with secret references intact, and commit the result:

```bash
curl "https://your-worker.workers.dev/api/config" > checks.json
```

Apply it from CI:

```bash
curl -X PUT "https://your-worker.workers.dev/api/config" \
  -H 'Content-Type: application/json' \
  --data @checks.json
```

The UI and this file write through the same validation, so you can use either
or both.
