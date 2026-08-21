---
title: clawdwatch
---

<div class="run-strip">
  <div class="run-strip-label"><span>homepage</span><span>every 5 min · last 2 hours</span></div>
  <div class="run-strip-marks">
    <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
    <i></i><i></i><i data-state="degraded"></i><i></i><i></i><i></i><i></i>
    <i data-state="unhealthy"></i><i data-state="unhealthy"></i><i data-state="unhealthy"></i>
    <i data-state="unknown"></i><i></i><i></i><i></i>
  </div>
  <div class="run-strip-note">One mark per run. Three consecutive failures opened an incident; the faded mark is a run that never reported.</div>
</div>

# clawdwatch

Synthetic monitoring for Cloudflare Workers. It checks your endpoints on a
cron, decides when something is genuinely broken, and hands that off to Slack,
a signed webhook, or an agent.

Detection is deterministic — thresholds, a state machine, and maintenance
windows decide whether something is down. No model is in that loop. State lives
in D1 and nowhere else.

## Install

```bash
npm create cloudflare@latest my-monitor -- \
  --template clawdwatch/clawdwatch/examples/worker
cd my-monitor

wrangler d1 create clawdwatch          # paste the id into wrangler.jsonc
npm run migrate
wrangler secret put SLACK_WEBHOOK_URL   # optional; this is all Slack needs
npm run deploy
```

Add a check:

```bash
curl -X POST "https://your-worker.workers.dev/api/checks" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "homepage",
    "name": "Homepage",
    "url": "https://example.com",
    "assertions": [
      { "type": "statusCode", "operator": "is", "value": 200 },
      { "type": "responseTime", "operator": "lessThan", "value": 3000 }
    ],
    "tags": ["production"]
  }'
```

## Where to go

| Page | What it covers |
|---|---|
| [Getting started](/guide/getting-started) | Deploy it and add your first check |
| [Configuration](/guide/configuration) | Every check and fleet option |
| [Secrets](/guide/secrets) | Why a check may reference a secret but never contain one |
| [Notifiers](/integration/notifiers) | Slack, signed webhook, and RPC over a service binding |
| [AI agents](/integration/agents) | Response-body capture, and the alert payload contract |
| [API reference](/guide/api-reference) | Routes, auth, and the agent-facing description |

## Reading an alert

Four event kinds, batched per run, so a ten-endpoint outage is one
notification rather than ten:

| Kind | When |
|---|---|
| `opened` | a check crossed its failure threshold |
| `recovered` | it passed again, with the downtime measured |
| `reminder` | still down, on the configured cadence |
| `summary` | what changed this run, including all-clear |

Every alert carries `schemaVersion` and a `links` object of short-lived signed
URLs, so a receiver can annotate or acknowledge an incident without holding a
standing credential.

## The other half

[thinkbot](https://triptechtravel.github.io/thinkbot/) is an ops agent built on
this. It takes an alert, correlates it against GitHub, Datadog, Sentry and
Rollbar, and reports what changed — the step monitoring cannot do on its own.

MIT. [Source on GitHub](https://github.com/triptechtravel/clawdwatch).
