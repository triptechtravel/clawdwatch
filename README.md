# clawdwatch

Synthetic monitoring for Cloudflare Workers — checks, state machine, and a built-in dashboard.

ClawdWatch is responsible for **detecting problems**. Your agent (e.g. moltbot/openclaw) is responsible for **deciding what to do about them**. When a check transitions to unhealthy or recovers, clawdwatch fires an `onAlert` callback with the details. What happens next — which channels to notify, how to format the message, who to wake up — is entirely up to the agent.

- **HTTP health checks** with custom assertions, retries, configurable thresholds
- **Browser synthetic tests** (coming soon — Datadog-style real user monitoring)
- **State machine** deduplication — no alert spam
- **`onAlert` callback** — clawdwatch reports, your agent decides
- **Embedded dashboard** — Datadog-style UI served from your worker
- **R2 state persistence** — no external database needed

## Install

```bash
npm install clawdwatch
```

## Quick Start

```typescript
import { createMonitor } from 'clawdwatch';

const monitor = createMonitor<Env>({
  checks: [
    {
      id: 'website',
      name: 'Website',
      type: 'api',
      url: 'https://example.com',
    },
    {
      id: 'worker-health',
      name: 'Worker Health',
      type: 'api',
      url: '{{WORKER_URL}}/sandbox-health',
      tags: ['infrastructure'],
    },
  ],
  getR2Bucket: (env) => env.MY_BUCKET,
  getWorkerUrl: (env) => env.WORKER_URL,
  onAlert: async (alert, env) => {
    // POST to your agent — it decides how/where to alert
    await fetch('http://localhost/api/monitoring-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
    });
  },
});

// Mount dashboard + admin API (apply your own auth middleware)
app.route('/monitoring', monitor.app);

// Public status endpoint (no auth)
app.get('/api/status', monitor.statusHandler);

// Run checks from your scheduled handler
export default {
  async scheduled(event, env, ctx) {
    await monitor.runChecks(env);
  },
  fetch: app.fetch,
};
```

## Design Philosophy

ClawdWatch follows a clear separation of concerns:

| Responsibility | Owner |
|---|---|
| Running health checks | clawdwatch |
| Tracking state transitions | clawdwatch |
| Persisting history to R2 | clawdwatch |
| Serving the dashboard UI | clawdwatch |
| **Deciding how to alert** | **Your agent** (e.g. moltbot/openclaw) |
| **Choosing notification channels** | **Your agent** |
| **Formatting alert messages** | **Your agent** |

This means clawdwatch has no opinions about Telegram, Slack, email, or any other notification channel. It gives you an `AlertPayload` and gets out of the way. In moltworker, the `onAlert` callback POSTs to the moltbot gateway — the agent decides which channel(s) to notify and how to format the message.

If the agent isn't running when an alert fires, that's fine — the next cron run re-evaluates the checks and the dashboard always shows current state.

## Configuration

### `createMonitor<TEnv>(options)`

| Option | Type | Description |
|---|---|---|
| `checks` | `CheckConfig[]` | Checks to run |
| `getR2Bucket` | `(env) => R2Bucket` | Returns your R2 bucket binding |
| `getWorkerUrl` | `(env) => string` | Worker URL for `{{WORKER_URL}}` resolution |
| `onAlert` | `(alert, env) => Promise<void>` | Called on state transitions (failure/recovery) |
| `defaults.failureThreshold` | `number` | Consecutive failures before alert (default: 2) |
| `defaults.timeoutMs` | `number` | Check timeout (default: 10,000) |
| `defaults.historySize` | `number` | History entries to keep (default: 288 = 24h @ 5min) |
| `defaults.stateKey` | `string` | R2 key for state (default: `clawdwatch/state.json`) |
| `defaults.userAgent` | `string` | User-Agent header (default: `clawdwatch/1.0`) |

### Check Config

```typescript
interface CheckConfig {
  id: string;
  name: string;
  type: 'api';              // 'browser' coming soon
  url: string;               // supports {{WORKER_URL}} placeholder
  method?: string;           // HTTP method (default: 'GET')
  assertions?: Assertion[];  // custom assertions (default: statusCode 200)
  retry?: {
    count: number;           // retries on failure
    delayMs: number;         // delay between retries
  };
  timeoutMs?: number;         // override default
  failureThreshold?: number;  // override default
  tags?: string[];
}
```

### Assertions

Custom assertions let you validate beyond just status code:

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

### Alert Payload

The `onAlert` callback receives an `AlertPayload` with everything needed to act on the event:

```typescript
interface AlertPayload {
  type: 'failure' | 'recovery';
  check: CheckConfig;       // which check triggered
  checkState: CheckState;   // current state after transition
  result: CheckResult;      // the check result that caused it
  timestamp: string;
}
```

### State Machine

```
unknown  → healthy    (first success, no alert)
unknown  → degraded   (first failure, threshold not met)
healthy  → degraded   (failure, threshold not met)
degraded → unhealthy  (threshold met → onAlert 'failure')
unhealthy → healthy   (success → onAlert 'recovery')
unhealthy → unhealthy (still failing, no alert)
```

## Dashboard

The embedded dashboard is served at the mount point (e.g., `/monitoring/`). It includes:

- Overall system status with 24h uptime percentage
- Per-check status timeline (24h history bar)
- Response time sparkline
- Auto-refresh every 60 seconds

## Roadmap

- **Browser synthetic tests** — Datadog-style browser checks using headless browsers
- **Custom check types** — pluggable check runners beyond HTTP

## License

Apache-2.0
