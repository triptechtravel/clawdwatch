# clawdwatch

Synthetic monitoring for Cloudflare Workers — health checks, state machine alerts, and an embedded dashboard.

ClawdWatch is responsible for **detecting problems**. Your agent (e.g. [openclaw](https://github.com/triptechtravel/openclaw)) is responsible for **deciding what to do about them**. When a check transitions to unhealthy or recovers, clawdwatch fires an `onAlert` callback with the details. What happens next — which channels to notify, how to format the message, who to wake up — is entirely up to the agent.

- **Dynamic check config** stored in D1 — add/edit/delete checks without redeploying
- **Analytics Engine metrics** — 90-day retention, query any time range
- **HTTP health checks** with custom assertions, retries, configurable thresholds
- **State machine** deduplication — no alert spam
- **`onAlert` callback** — clawdwatch reports, your agent decides
- **CRUD API** — manage checks, view incidents, export/import config
- **Embedded dashboard** — Datadog-style UI served from your worker
- **R2 hot state** — simplified state for the alert state machine (no history bloat)

## Install

```bash
npm install clawdwatch
```

## Quick Start

```typescript
import { createMonitor } from 'clawdwatch';

const monitor = createMonitor<Env>({
  storage: {
    getD1: (env) => env.MONITORING_DB,
    getR2: (env) => env.MY_BUCKET,
    getAnalyticsEngine: (env) => env.MONITORING_AE,
  },
  resolveUrl: (url, env) =>
    url.replace('{{WORKER_URL}}', env.WORKER_URL ?? 'http://localhost:8787'),
  onAlert: async (alert, env) => {
    // POST to your agent — it decides how/where to alert
    console.log(`Alert: ${alert.type} for ${alert.check.name}`);
  },
});

// Mount dashboard + CRUD API (apply your own auth middleware first)
app.route('/monitoring', monitor.app);

// Run checks from your scheduled handler
export default {
  async scheduled(event, env, ctx) {
    await monitor.runChecks(env);
  },
  fetch: app.fetch,
};
```

See [`examples/`](./examples/) for full integration patterns including dual-auth middleware and agent skill setup.

## Storage

ClawdWatch v2 uses three Cloudflare storage services:

| Service | Purpose | Free Tier |
|---|---|---|
| **D1** | Check config, incidents, alert rules | 5M reads, 100K writes/month |
| **Analytics Engine** | Every check result (90-day retention) | 10M events/month |
| **R2** | Hot state for alert state machine | 10M reads, 1M writes/month |

See [`examples/wrangler-bindings.jsonc`](./examples/wrangler-bindings.jsonc) for required bindings.

## Design Philosophy

| Responsibility | Owner |
|---|---|
| Running health checks | clawdwatch |
| Tracking state transitions | clawdwatch |
| Creating incidents on failures | clawdwatch |
| Serving the dashboard UI | clawdwatch |
| CRUD API for checks | clawdwatch |
| **Deciding how to alert** | **Your agent** |
| **Choosing notification channels** | **Your agent** |
| **Formatting alert messages** | **Your agent** |

## Configuration

### `createMonitor<TEnv>(options)`

| Option | Type | Description |
|---|---|---|
| `storage.getD1` | `(env) => D1Database` | Returns your D1 binding |
| `storage.getR2` | `(env) => R2Bucket` | Returns your R2 bucket binding |
| `storage.getAnalyticsEngine` | `(env) => AnalyticsEngineDataset` | Returns your AE binding |
| `resolveUrl` | `(url, env) => string` | Resolve `{{WORKER_URL}}` and other placeholders |
| `onAlert` | `(alert, env) => Promise<void>` | Called on state transitions (failure/recovery) |
| `defaults.stateKey` | `string` | R2 key for state (default: `clawdwatch/state.json`) |
| `defaults.failureThreshold` | `number` | Consecutive failures before alert (default: 2) |
| `defaults.timeoutMs` | `number` | Check timeout (default: 10,000) |
| `defaults.userAgent` | `string` | User-Agent header (default: `clawdwatch/2.0`) |

### Check Config

Checks are stored in D1 and managed via the CRUD API:

```typescript
interface CheckConfig {
  id: string;              // unique identifier (lowercase, hyphens)
  name: string;            // human-readable name
  type?: string;           // 'api' (default) or 'browser' (coming soon)
  url: string;             // supports {{WORKER_URL}} placeholder
  method?: string;         // HTTP method (default: 'GET')
  headers?: object;        // custom request headers
  body?: string;           // request body for POST/PUT
  assertions?: Assertion[];// custom assertions (default: statusCode 200)
  retry_count?: number;    // retries on failure (default: 0)
  retry_delay_ms?: number; // delay between retries (default: 300)
  timeout_ms?: number;     // override default (default: 10000)
  failure_threshold?: number; // override default (default: 2)
  tags?: string[];
  enabled?: boolean;       // default: true
}
```

### Assertions

```typescript
// Status code
{ type: 'statusCode', operator: 'is', value: 200 }

// Response header
{ type: 'header', name: 'Content-Type', operator: 'contains', value: 'application/json' }

// Response body
{ type: 'body', operator: 'contains', value: '"status":"ok"' }

// Response time
{ type: 'responseTime', operator: 'lessThan', value: 5000 }
```

### API Routes (provided by `monitor.app`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Overall status with all check states |
| GET | `/api/checks` | List all checks |
| GET | `/api/checks/:id` | Get single check |
| POST | `/api/checks` | Create check |
| PUT | `/api/checks/:id` | Update check (partial) |
| DELETE | `/api/checks/:id` | Delete check |
| POST | `/api/checks/:id/toggle` | Enable/disable check |
| POST | `/api/checks/:id/run` | Run check immediately |
| GET | `/api/incidents` | List incidents (?check_id, ?status, ?limit) |
| GET | `/api/alert-rules` | List alert rules |
| POST | `/api/alert-rules` | Create alert rule |
| DELETE | `/api/alert-rules/:id` | Delete alert rule |
| GET | `/api/maintenance` | List maintenance windows |
| POST | `/api/maintenance` | Create maintenance window |
| DELETE | `/api/maintenance/:id` | Delete maintenance window |
| GET | `/api/config` | Export full config (checks + alert rules) |
| PUT | `/api/config` | Import checks (declarative sync) |

### State Machine

```
unknown  → healthy    (first success, no alert)
unknown  → degraded   (first failure, threshold not met)
healthy  → degraded   (failure, threshold not met)
degraded → unhealthy  (threshold met → onAlert 'failure')
unhealthy → healthy   (success → onAlert 'recovery')
unhealthy → unhealthy (still failing, no alert)
```

### Alert Payload

```typescript
interface AlertPayload {
  type: 'failure' | 'recovery';
  check: CheckConfig;
  checkState: CheckState;
  result: CheckResult;
  timestamp: string;
}
```

## Dashboard

The embedded dashboard is served at the mount point (e.g., `/monitoring/`). It includes:

- Overall system status
- Per-check status timeline
- Response time sparkline
- Auto-refresh every 60 seconds

## Agent Integration

ClawdWatch is designed to be managed by an AI agent. See [`examples/agent-skill.md`](./examples/agent-skill.md) for a template skill that gives your agent full CRUD access to the monitoring API.

The pattern:
1. Worker exposes `/monitoring/api/*` with dual-auth (your auth + `?secret=` query param)
2. Pass `MONITORING_API_KEY` and `WORKER_URL` to the agent's container
3. Agent uses `curl` with `?secret=` to manage checks via the API

## License

Apache-2.0
