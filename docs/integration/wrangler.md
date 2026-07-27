# Worker setup

## Minimum configuration

```jsonc
{
  "name": "clawdwatch",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],

  "d1_databases": [
    {
      "binding": "MONITORING_DB",
      "database_name": "clawdwatch",
      "database_id": "<from wrangler d1 create>",
      "migrations_dir": "node_modules/clawdwatch/migrations"
    }
  ],

  "triggers": { "crons": ["*/5 * * * *"] },

  "vars": { "BASE_URL": "https://clawdwatch.example.workers.dev" }
}
```

D1 is the only binding required. There is no R2 bucket and no analytics
dataset — v2 had both, and neither earned its place.

## Migrations

```bash
wrangler d1 migrations apply clawdwatch --local    # development
wrangler d1 migrations apply clawdwatch --remote   # production
```

Migrations ship inside the package, so `migrations_dir` points at
`node_modules/clawdwatch/migrations`. The reference worker uses a relative path
because it lives in this repository.

## Secrets

Never in `wrangler.jsonc` — `vars` are visible in the dashboard and in your
repository.

```bash
wrangler secret put SLACK_WEBHOOK_URL      # alerts reach Slack
wrangler secret put ALERT_SIGNING_SECRET   # signs webhooks and capability links
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put CF_ACCESS_AUD
```

Plus one for each credential your checks need, wired through the `secrets`
option. See [Secrets](../guide/secrets.md).

## Cron

The cron sets the floor for how often anything runs. `*/5 * * * *` suits most
deployments; go to `* * * * *` if you need minute-resolution checks, and expect
proportionally more invocations.

Each run only executes checks whose interval has elapsed, so a one-minute cron
with mostly hourly checks is cheap.

## Concurrency and limits

Checks run several at a time (six by default). A serial loop would be a
liability: ten checks at a ten-second timeout with a retry each could exceed
the invocation's wall clock and lose the entire tick.

If you monitor many slow endpoints, raise `concurrency` rather than the
timeout.

```ts
defaults: { concurrency: 12 }
```

## Custom domain

Alert links use `BASE_URL`, so set it to the address you actually browse:

```jsonc
"routes": [{ "pattern": "status.example.com", "custom_domain": true }],
"vars": { "BASE_URL": "https://status.example.com" }
```

## Costs

The Worker itself is a cron invocation every five minutes plus whatever
dashboard traffic you generate. D1 holds check definitions and a rolling 48
hours of results — kilobytes for a typical deployment. Both sit inside the
free tier for most people; the paid plan is only needed for higher volume.
