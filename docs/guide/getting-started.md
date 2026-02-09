# Getting Started

## Install

```bash
npm install clawdwatch
```

## Quick Start

```typescript
import { createMonitor } from "clawdwatch";

const monitor = createMonitor<Env>({
  storage: {
    getD1: (env) => env.MONITORING_DB,
    getR2: (env) => env.MY_BUCKET,
    getAnalyticsEngine: (env) => env.MONITORING_AE,
  },
  resolveUrl: (url, env) =>
    url.replace("{{WORKER_URL}}", env.WORKER_URL ?? "http://localhost:8787"),
  onAlert: async (alert, env) => {
    // POST to your agent — it decides how/where to alert
    console.log(`Alert: ${alert.type} for ${alert.check.name}`);
  },
});

// Mount dashboard + CRUD API (apply your own auth middleware first)
app.route("/monitoring", monitor.app);

// Run checks from your scheduled handler
export default {
  async scheduled(event, env, ctx) {
    await monitor.runChecks(env);
  },
  fetch: app.fetch,
};
```

See [Wrangler Bindings](/integration/wrangler) for the required `wrangler.jsonc` config.

## Storage

ClawdWatch v2 uses three Cloudflare storage services:

| Service | Purpose | Free Tier |
|---|---|---|
| **D1** | Check config, incidents, alert rules | 5M reads, 100K writes/month |
| **Analytics Engine** | Every check result (90-day retention) | 10M events/month |
| **R2** | Hot state for alert state machine | 10M reads, 1M writes/month |

## Design Philosophy

| Responsibility | Owner |
|---|---|
| Running health checks | ClawdWatch |
| Tracking state transitions | ClawdWatch |
| Creating incidents on failures | ClawdWatch |
| Serving the dashboard UI | ClawdWatch |
| CRUD API for checks | ClawdWatch |
| **Deciding how to alert** | **Your agent** |
| **Choosing notification channels** | **Your agent** |
| **Formatting alert messages** | **Your agent** |
