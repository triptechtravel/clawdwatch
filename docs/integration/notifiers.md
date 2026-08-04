# Notifiers

clawdwatch decides *whether* something is broken. What happens next is a
notifier — a small object with a `notify` method.

## Events

Events are batched per run, so a ten-endpoint outage produces one round of
notifications rather than ten.

| Kind | Fires when | Carries |
|---|---|---|
| `opened` | a check crossed its failure threshold | the failing assertions, the incident id |
| `recovered` | it passed again | how long it was down |
| `reminder` | still down, cadence elapsed | how long it has been down |
| `summary` | anything changed this run | what opened, what recovered, what is still down, and whether this is all-clear |

Every event includes a `links` object of short-lived signed URLs — incident,
ack, annotate, run-now, capabilities — so a receiver can act without holding a
standing credential.

## Slack

```ts
import { slack } from 'clawdwatch';

notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })]
```

That is the whole configuration. If you set `SLACK_WEBHOOK_URL` and pass no
`notifiers` at all, this is what you get by default.

Messages are Block Kit: red for an incident, green for recovery and all-clear,
amber for a reminder.

Route different checks to different channels by running more than one:

```ts
notifiers: [
  slack({ webhook: '${SLACK_ONCALL}', name: 'slack:oncall' }),
  slack({ webhook: '${SLACK_STATUS}', name: 'slack:status', on: ['summary'] }),
]
```

## Webhook

POSTs the raw event as JSON. This is how you reach anything that is not Slack —
your own service, PagerDuty via a translator, or an AI agent.

```ts
import { webhook, hmac } from 'clawdwatch';

notifiers: [
  webhook({ url: '${INBOX_URL}', auth: hmac('${SIGNING_SECRET}') }),
]
```

### Verifying a signature

The signature covers `timestamp.body`, not just the body, so a captured
payload cannot be replayed later. Use the exported verifier rather than
reimplementing it:

```ts
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from 'clawdwatch';

const body = await request.text();
const ok = await verifySignature({
  secret: env.SIGNING_SECRET,
  body,
  signature: request.headers.get(SIGNATURE_HEADER),
  timestamp: request.headers.get(TIMESTAMP_HEADER),
});
if (!ok) return new Response('bad signature', { status: 401 });
```

Signatures older than five minutes are rejected.

### Behind Cloudflare Access

If the receiver is itself behind Access, send a service token instead:

```ts
import { webhook, serviceToken, combineAuth, hmac } from 'clawdwatch';

webhook({
  url: '${INBOX_URL}',
  auth: serviceToken('${CF_ACCESS_CLIENT_ID}', '${CF_ACCESS_CLIENT_SECRET}'),
})
```

`combineAuth(serviceToken(...), hmac(...))` does both — Access proves the
caller is allowed through the edge, the signature proves the payload is
authentic.

## RPC (Worker to Worker)

When the receiver is a Worker on the same Cloudflare account, a service binding
beats a webhook. The platform authenticates the call, so there is no shared
secret to distribute or rotate, no public inbox to defend, and no replay window
to reason about.

The receiver exposes an entrypoint:

```ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AlertEvent } from 'clawdwatch';

export class AlertInbox extends WorkerEntrypoint<Env> {
  async alert(event: AlertEvent) {
    // Return promptly. Delivery outcomes are recorded, so holding the caller
    // open for slow work shows up as a slow or failed notification.
    this.ctx.waitUntil(handle(event));
  }
}
```

The sender binds it:

```jsonc
"services": [
  { "binding": "AGENT", "service": "my-agent", "entrypoint": "AlertInbox" }
]
```

```ts
import { rpc } from 'clawdwatch';

notifiers: [rpc({ binding: (env) => env.AGENT })]
```

Use `method` if your entrypoint names it something other than `alert`.

This does not replace `webhook()`. Service bindings are same-account only, so
any other receiver — a self-hosted agent, an automation platform, someone
else's deployment — still needs a URL.

::: warning No signature
An RPC call carries no signature; authenticity comes from the binding. Keep
signature verification in your HTTP handler, and make sure shared downstream
code does not assume it ran.
:::

## Filtering

```ts
webhook({ url: '${INBOX_URL}', on: ['opened', 'recovered'] })
```

Without `on`, a notifier receives every kind.

## Failure handling

A notifier that throws does not stop the others, and does not fail the run.
Each delivery is retried once, then recorded:

```bash
curl "https://your-worker.workers.dev/api/deliveries"
```

```json
{
  "deliveries": [
    { "notifier": "slack", "ok": true, "attempts": 1, "deliveredAt": "..." },
    { "notifier": "webhook", "ok": false, "error": "Webhook returned 502", "attempts": 2, "deliveredAt": "..." }
  ]
}
```

The dashboard shows this at the bottom of the page. It answers the question
that is easy to forget to ask: *did the last alert actually arrive?* An alert
path that fails silently is worse than no alerting, because you believe you are
covered.

## Writing your own

```ts
import type { Notifier } from 'clawdwatch';

export function pagerduty(routingKey: string): Notifier<Env> {
  return {
    name: 'pagerduty',
    on: ['opened', 'recovered'],
    async notify(event, ctx) {
      const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: ctx.resolve(routingKey),
          event_action: event.kind === 'opened' ? 'trigger' : 'resolve',
          dedup_key: 'incidentId' in event ? event.incidentId : undefined,
          payload: {
            summary: 'check' in event ? event.check.name : 'monitoring summary',
            severity: 'error',
            source: 'clawdwatch',
          },
        }),
      });

      // Throw on failure — that is what makes it visible in /api/deliveries.
      if (!response.ok) throw new Error(`PagerDuty returned ${response.status}`);
    },
  };
}
```

Two rules: use `ctx.resolve` for anything that might be a `${SECRET}`, and
throw when delivery fails. Swallowing the error is what makes a dead alert path
invisible.
