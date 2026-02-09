# clawdwatch

Synthetic monitoring for Cloudflare Workers — health checks, state machine alerts, and an embedded dashboard.

ClawdWatch is responsible for **detecting problems**. Your agent (e.g. [OpenClaw](https://openclaw.ai)) is responsible for **deciding what to do about them**. When a check transitions to unhealthy or recovers, clawdwatch fires an `onAlert` callback with the details. What happens next — which channels to notify, how to format the message, who to wake up — is entirely up to the agent.

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
    console.log(`Alert: ${alert.type} for ${alert.check.name}`);
  },
});

app.route("/monitoring", monitor.app);

export default {
  async scheduled(event, env, ctx) {
    await monitor.runChecks(env);
  },
  fetch: app.fetch,
};
```

## Documentation

Full documentation is available at **[triptechtravel.github.io/clawdwatch](https://triptechtravel.github.io/clawdwatch/)**.

- [Getting Started](https://triptechtravel.github.io/clawdwatch/guide/getting-started) — install, quick start, storage
- [Configuration](https://triptechtravel.github.io/clawdwatch/guide/configuration) — createMonitor options, check config, assertions
- [API Reference](https://triptechtravel.github.io/clawdwatch/guide/api-reference) — all routes, state machine, alert payload
- [Agent Setup](https://triptechtravel.github.io/clawdwatch/integration/agent-setup) — agent skill template
- [Wrangler Bindings](https://triptechtravel.github.io/clawdwatch/integration/wrangler) — required bindings

## License

Apache-2.0
