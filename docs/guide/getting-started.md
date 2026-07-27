# Getting started

clawdwatch runs as a Cloudflare Worker: a cron trigger executes your checks,
D1 stores the configuration and results, and the Worker serves both the API and
the dashboard.

You need a Cloudflare account on any plan that includes D1 and cron triggers.

## Deploy the reference worker

```bash
npm create cloudflare@latest my-monitor -- \
  --template clawdwatch/clawdwatch/examples/worker
cd my-monitor
```

Create the database and paste the id it prints into `wrangler.jsonc`:

```bash
wrangler d1 create clawdwatch
```

Apply the schema:

```bash
npm run migrate
```

Point alerts at Slack — this is the only configuration Slack needs:

```bash
wrangler secret put SLACK_WEBHOOK_URL
```

Deploy:

```bash
npm run deploy
```

## Add a check

```bash
curl -X POST "https://your-worker.workers.dev/api/checks" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "homepage",
    "name": "Homepage",
    "url": "https://example.com",
    "assertions": [
      { "type": "statusCode", "operator": "is", "value": 200 }
    ],
    "tags": ["production"]
  }'
```

A check with no assertions is treated as "status must be 200".

Run it immediately rather than waiting for the cron:

```bash
curl -X POST "https://your-worker.workers.dev/api/checks/homepage/run"
```

Then open the Worker's URL for the dashboard.

## What happens on a run

1. Checks whose interval has elapsed are executed, several at a time.
2. Each response is measured against its assertions. The body is read only if
   an assertion needs it, and is discarded afterwards.
3. A failure increments a counter. Once it reaches `failureThreshold`, the
   check becomes unhealthy and an incident opens.
4. Events are batched — a ten-endpoint outage produces one notification, not
   ten — and handed to your notifiers.
5. Results, state, incidents, and delivery outcomes are written to D1 in a
   single batch.

A single failure does not alert. That is the point of the threshold: a check
that blips once and recovers should not wake anyone.

## Using it as a library

If you already have a Worker, mount clawdwatch inside it:

```bash
npm install clawdwatch
```

```ts
import { createMonitor, slack } from 'clawdwatch';

const monitor = createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,
  secrets: (env) => ({ SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL }),
  notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })],
});

export default {
  fetch: monitor.fetch,
  scheduled: monitor.scheduled,
};
```

To mount the API under a path alongside your own routes, use `monitor.app`:

```ts
import { Hono } from 'hono';

const app = new Hono();
app.route('/monitoring', monitor.app);
```

## Next

- [Configuration](./configuration.md) — check options and assertions
- [Secrets](./secrets.md) — checks that need credentials
- [Notifiers](../integration/notifiers.md) — where alerts go
- [Authentication](../integration/auth.md) — locking down writes
