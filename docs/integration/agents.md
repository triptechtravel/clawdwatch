# AI agents

An agent can do something no threshold can: look at an alert, check what
deployed recently, correlate it with your error tracker, and tell you *why*
the endpoint is failing.

clawdwatch supports this without knowing anything about your agent. There is no
plugin to install, no fork, no skill file to copy. An agent inbox is a URL — or,
if your agent is a Worker on the same account, a [service binding](/integration/notifiers#rpc-worker-to-worker).

[thinkbot](https://github.com/triptechtravel/thinkbot) is a working
implementation of everything on this page, if you would rather read code than
prose — or deploy one rather than write one.

## Sending alerts

```ts
import { webhook, hmac } from 'clawdwatch';

notifiers: [
  slack({ webhook: '${SLACK_WEBHOOK_URL}' }),
  webhook({
    url: '${AGENT_INBOX_URL}',
    auth: hmac('${SIGNING_SECRET}'),
    on: ['opened', 'recovered'],
  }),
]
```

Keep Slack alongside it. An agent is a more complex system than the monitor;
if it is your only alert path, an agent outage is a monitoring outage, and you
will not find out until you need it.

## Acting on an alert

Every payload carries its own affordances:

```json
{
  "kind": "opened",
  "at": "2026-07-27T13:01:00.000Z",
  "check": {
    "id": "business-login",
    "name": "Business Login",
    "url": "https://business.example.com/auth/login",
    "tags": ["apps"],
    "status": "unhealthy"
  },
  "failure": {
    "statusCode": 502,
    "responseTimeMs": 310,
    "assertions": ["Expected status 200, got 502"],
    "consecutiveFailures": 3
  },
  "incidentId": "018f...",
  "links": {
    "incident": "https://mon.example.com/api/incidents/018f...",
    "ack": "https://mon.example.com/api/incidents/018f.../ack",
    "annotate": "https://mon.example.com/api/incidents/018f.../annotate",
    "runNow": "https://mon.example.com/api/checks/business-login/run",
    "capabilities": "https://mon.example.com/api/agent.md"
  }
}
```

Those action links are signed and scoped: valid for that one action on that one
incident, for about an hour. An agent receiving the alert can act on it
immediately, with no credential provisioned anywhere.

The natural loop:

1. Receive the alert.
2. Gather context from wherever you keep it — recent deploys, error tracker,
   metrics.
3. Write the finding back to `links.annotate`.
4. Decide whether a human needs waking.

The annotation appears on the incident in the dashboard, so the explanation
lives next to the outage rather than scrolling away in a chat channel.

```bash
curl -X POST "$ANNOTATE_LINK" \
  -H 'Content-Type: application/json' \
  -d '{"annotation":"Deploy 4f21c9 merged 13:55 touched auth middleware; error tracker shows a matching spike from 14:03. Likely cause — rollback candidate."}'
```

## Giving the agent the evidence

A status-code assertion tells an agent that an endpoint returned 500. It does
not tell it what the 500 *said* — and that is usually where the cause is.

Set `captureBodyOnFailure` on a check and a failing alert carries a
`bodySnippet`: an excerpt of the response body, capped at 512 characters, taken
only from textual content types, and scrubbed of secret values before it is
truncated.

```json
{ "id": "api-health", "url": "https://api.example.com/health",
  "assertions": [{ "type": "statusCode", "operator": "is", "value": 200 }],
  "captureBodyOnFailure": true }
```

Or fleet-wide, opting individual checks back out:

```ts
createMonitor({ /* … */ defaults: { captureBodyOnFailure: true } });
```

It is never captured for a passing check, and never posted to Slack — a channel
is a wider and more retained audience than an agent inbox. It reaches webhook
and RPC notifiers, and the dashboard.

::: warning
This is off by default for a reason. Do not enable it on an endpoint whose
error paths can return personal data. See
[SECURITY.md](https://github.com/triptechtravel/clawdwatch/blob/main/SECURITY.md).
:::

An agent should treat the snippet as an excerpt, not the whole response — it is
truncated and scrubbed, so it is a lead to verify rather than a quote to cite.

## Surviving a version change

Every alert carries `schemaVersion` (exported as `ALERT_SCHEMA_VERSION`). The
contract:

- adding an **optional** field does not bump it — `bodySnippet` was added this way;
- removing or renaming a field, or changing its meaning, does.

A receiver should ignore fields it does not recognise and must not hard-fail on
a version higher than it knows — degrade to what it can read. An agent that
rejects unknown versions turns every clawdwatch release into a monitoring
outage. The two systems deploy independently; skew is normal, not exceptional.

## Standing access

For anything not driven by an alert — "add a check for the new endpoint" —
the agent needs credentials of its own. Use a Cloudflare Access service token:

```bash
curl "$MONITORING_URL/api/checks" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

See [Authentication](./auth.md) for issuing one.

## Teaching an agent the API

Point it at `GET /api/agent.md`. That document lists every endpoint, every
assertion type, and the secret-reference rule, and it is generated from the
route table — a test fails if a route is added without documenting it, or
documented without existing.

So the entire integration is one line of agent configuration:

> Monitoring lives at `$MONITORING_URL/api/agent.md`. Fetch it when you need to
> work with checks or incidents.

There is deliberately no skill file to install. A static copy of a live API
drifts, and in practice often never gets installed at all — an endpoint the
server generates is always current and always reachable.

## Keeping detection deterministic

Let the agent explain and decide; do not let it detect. Thresholds and the
state machine are cheap, predictable, and testable. A model deciding whether
your site is down is none of those things, and it costs an inference every
five minutes to reach the same answer.

For anomaly detection — "more 4xx than usual" rather than "down" — feed a
metrics platform's anomaly monitor into the same inbox and let the agent
narrate what it means.
