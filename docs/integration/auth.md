# Authentication

Reads are open by default so a status page needs no login. Writes always
require a principal: a signed-in person, a machine holding a service token, or
a capability link embedded in an alert.

There is deliberately **no query-parameter API key**. URLs end up in logs,
analytics, and referrer headers, and a single shared static secret has no
identity, no expiry, and no per-client revocation.

## Cloudflare Access

```ts
createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,
  auth: (env) => ({
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,   // myteam.cloudflareaccess.com
    aud: env.CF_ACCESS_AUD,                  // the application's AUD tag
    capabilitySecret: env.ALERT_SIGNING_SECRET,
  }),
});
```

Every JWT is verified against your team's JWKS, the expected `aud`, the issuer,
and the clock. Arriving through the Access edge is not treated as evidence:
anyone who learns the Worker's direct route bypasses it.

Both claim shapes are handled — people carry `email`, service tokens carry
`common_name` and no email.

## Recommended topology

Two Access applications on the same hostname:

| Application | Path | Policies |
|---|---|---|
| Dashboard | `/*` | Allow: your team |
| API | `/api/*` | Allow: your team, **and** Service Auth: agent tokens |

Separate applications mean separate AUD tags, so a leaked agent token is valid
only for `/api/*` and can be rotated without touching human access.

## Issuing a service token

In the Zero Trust dashboard: **Access → Service Tokens → Create**. You get a
client id and secret, shown once.

Add a policy on the API application with action **Service Auth** that includes
the token, then send both headers:

```bash
curl "https://your-worker.workers.dev/api/checks" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

Restrict which tokens may write:

```ts
auth: (env) => ({
  teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
  aud: env.CF_ACCESS_AUD,
  allowedServiceTokens: ['agent-token.access'],
}),
```

## Capability links

Every alert carries signed URLs for the actions relevant to it — ack, annotate,
run-now. Each is scoped to one action on one incident and expires after about
an hour.

This is what lets an agent act on an alert without holding any standing
credential. A leaked link can acknowledge one incident, once, for an hour.

They are enabled by setting `capabilitySecret`. Without it, those endpoints
fall back to requiring Access like any other write.

## Local development

```ts
auth: (env) => ({ devMode: env.DEV_MODE === 'true' }),
```

`DEV_MODE` skips authentication entirely and is intended only for
`wrangler dev`. Never set it in a deployed environment — an env-flag auth
bypass that ships is the same class of hole as a query-parameter key.

## What is not stored

The verified identity is used for the authorization decision and then
discarded. There are no email, IP, or user-agent columns anywhere in the
schema.
