# clawdwatch

Synthetic monitoring for Cloudflare Workers. Checks your endpoints on a cron,
decides when something is genuinely broken, and hands that off to Slack, a
signed webhook, or an AI agent.

- **Detection is deterministic.** Thresholds, a state machine, maintenance
  windows. No model decides whether your site is down.
- **Public code, private config.** Checks live in D1 and are editable through
  the UI, but secret values never enter the database — only `${REFERENCES}`,
  resolved from Worker secrets at request time.
- **One storage system.** D1. No R2 state blob, no analytics dataset you have
  to reason about.
- **A dashboard you'll actually read.** One mark per check run, so a five-minute
  cron looks like five-minute samples rather than a smoothed line.

## Quick start

```bash
npm create cloudflare@latest my-monitor -- \
  --template clawdwatch/clawdwatch/examples/worker
cd my-monitor

wrangler d1 create clawdwatch          # paste the id into wrangler.jsonc
npm run migrate
wrangler secret put SLACK_WEBHOOK_URL   # optional, but this is all Slack needs
npm run deploy
```

Add your first check:

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

Open the Worker's URL for the dashboard.

## Using it as a library

```ts
import { createMonitor, slack } from 'clawdwatch';

const monitor = createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,
  secrets: (env) => ({ SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL }),
  notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })],
});

export default { fetch: monitor.fetch, scheduled: monitor.scheduled };
```

## Assertions

| Type | Operators |
|---|---|
| `statusCode` | `is`, `isNot` |
| `header` | `is`, `isNot`, `contains`, `notContains`, `matches` |
| `body` | `contains`, `notContains`, `matches` |
| `responseTime` | `lessThan` |
| `jsonPath` | `is`, `isNot`, `contains`, `notContains`, `matches`, `lessThan`, `greaterThan` |

Response bodies are read to evaluate assertions and then discarded. Only the
failure message is stored, truncated to 256 characters.

### Sending alerts to a Worker over RPC

When the receiver is a Worker on the same Cloudflare account, a service binding
beats a webhook: the platform authenticates the call, so there is no shared
HMAC secret to distribute or rotate and no public inbox to defend.

```ts
// receiving Worker
import { WorkerEntrypoint } from 'cloudflare:workers';
export class AlertInbox extends WorkerEntrypoint<Env> {
  async alert(event: AlertEvent) { /* … */ }
}
```

```jsonc
// sending Worker config
"services": [{ "binding": "AGENT", "service": "my-agent", "entrypoint": "AlertInbox" }]
```

```ts
import { rpc } from 'clawdwatch';
notifiers: [rpc({ binding: (env) => env.AGENT })]
```

Service bindings are same-account only, so `webhook()` remains the option for
any other receiver. An RPC call carries **no signature** — authenticity comes
from the binding — so keep signature verification in your HTTP handler and do
not let shared downstream code assume it ran.

### Alert payload versioning

Every alert carries `schemaVersion` (exported as `ALERT_SCHEMA_VERSION`). The
contract a receiver can rely on:

- adding an **optional** field does not bump it — `bodySnippet` was added this way;
- removing or renaming a field, or changing its meaning or type, does.

Receivers should ignore unknown fields and must not hard-fail on a version
higher than they know — degrade to what they can read. A receiver that rejects
unknown versions turns every clawdwatch release into a monitoring outage.

### Capturing why a check failed

A status-code assertion tells you a check returned 500. It does not tell you
what the 500 said — and that is usually where the cause is. Set
`captureBodyOnFailure` to keep a short excerpt of the body of a **failing**
response:

```json
{ "id": "api-health", "url": "https://api.example.com/health",
  "assertions": [{ "type": "statusCode", "operator": "is", "value": 200 }],
  "captureBodyOnFailure": true }
```

Or turn it on for every check at once, and opt individual checks back out:

```ts
createMonitor({ /* … */ defaults: { captureBodyOnFailure: true } });
```

The excerpt is capped at 512 characters, taken only from textual content types,
scrubbed of secret values, and never captured for a passing check. It is
delivered to webhook notifiers and shown on the dashboard, but deliberately
**not** posted to Slack. See [SECURITY.md](./SECURITY.md) before enabling it on
an endpoint whose error bodies may contain personal data.

## Secrets

A check that needs an API key references it by name:

```json
{ "headers": { "X-Api-Key": "${MY_API_KEY}" } }
```

The value comes from `secrets` in your config and is substituted when the
request is built. Writing a check that contains a literal secret value is
rejected with a 400 — that guard is what keeps a UI-editable, database-backed
system safe to open-source.

For a token that should apply to a whole domain rather than one check — a WAF
bypass, say — use `headerRules`:

```ts
headerRules: [
  { host: /(^|\.)example\.com$/, headers: { 'x-waf-bypass': '${WAF_TOKEN}' } },
],
```

## Alerts

Four event kinds, batched per run so a ten-endpoint outage is one notification
rather than ten:

| Kind | When |
|---|---|
| `opened` | a check crossed its failure threshold |
| `recovered` | it passed again, with the downtime measured |
| `reminder` | still down, on the configured cadence |
| `summary` | what changed this run, including all-clear |

`slack()` needs a webhook URL and nothing else. `webhook()` POSTs the raw
event, signed:

```ts
notifiers: [
  slack({ webhook: '${SLACK_WEBHOOK_URL}' }),
  webhook({ url: '${INBOX_URL}', auth: hmac('${SIGNING_SECRET}') }),
]
```

Every delivery is recorded, so the dashboard can tell you whether the last
alert actually arrived.

## Sending alerts to an AI agent

An agent inbox is just a URL, so `webhook()` is the whole integration. Nothing
is installed into the agent:

- Each alert carries a `links` object — incident, ack, annotate, run-now —
  as short-lived signed URLs. An agent can act on the alert it received
  without holding any standing credential.
- `GET /api/agent.md` describes the full API, generated from the route table
  so it cannot drift. Point your agent at it and that is the entire setup.

An agent triaging an incident can write its findings back with
`POST /api/incidents/:id/annotate`; the note appears on the incident in the
dashboard.

## Auth

Mount behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).
Reads are open by default; writes always require a principal — a signed-in
person, a service token, or a capability link. There is no query-parameter API
key, deliberately: URLs leak into logs, and a shared static secret has no
identity, expiry, or revocation.

```ts
auth: (env) => ({
  teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
  aud: env.CF_ACCESS_AUD,
  capabilitySecret: env.ALERT_SIGNING_SECRET,
}),
```

Both Access claim shapes are handled: people (`email`) and service tokens
(`common_name`).

## Documentation

- [Getting started](docs/guide/getting-started.md)
- [Configuration](docs/guide/configuration.md)
- [API reference](docs/guide/api-reference.md)
- [Deploying](docs/integration/wrangler.md)

## Development

```bash
npm install
npm test          # unit suite, then integration against a real D1
npm run build
```

The integration suite applies the shipped migration and runs in workerd, so
the SQL is genuinely exercised rather than mocked.

## License

Apache-2.0
