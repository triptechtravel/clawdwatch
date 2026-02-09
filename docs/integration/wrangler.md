# Wrangler Bindings

Add these bindings to your existing `wrangler.jsonc` configuration. Create the D1 database first with `wrangler d1 create <name>`.

```jsonc
{
  // D1 database for check config, incidents, alert rules
  "d1_databases": [
    {
      "binding": "MONITORING_DB",
      "database_name": "my-monitoring",
      "database_id": "<your-database-id>"
    }
  ],

  // Analytics Engine for metrics (90-day retention, 10M events/month free)
  "analytics_engine_datasets": [
    {
      "binding": "MONITORING_AE",
      "dataset": "monitoring_checks"
    }
  ],

  // R2 bucket for hot state (current status for alert state machine)
  // You likely already have an R2 bucket — clawdwatch stores a single
  // state.json file at the configured stateKey path.
  "r2_buckets": [
    {
      "binding": "MOLTBOT_BUCKET",
      "bucket_name": "my-data"
    }
  ],

  // Cron trigger to run checks (every 5 minutes)
  "triggers": {
    "crons": ["*/5 * * * *"]
  }
}
```

## Binding Summary

| Binding | Type | Purpose |
|---|---|---|
| `MONITORING_DB` | D1 | Check config, incidents, alert rules |
| `MONITORING_AE` | Analytics Engine | Check result metrics (90-day retention) |
| `MOLTBOT_BUCKET` | R2 | Hot state for alert state machine |
