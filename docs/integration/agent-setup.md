# Agent Setup

ClawdWatch is designed to be managed by an AI agent. This guide provides a template skill that gives your agent full CRUD access to the monitoring API.

## Container Environment

Pass these from your worker secrets to the container:

| Worker Secret | Container Env Var | Purpose |
|---|---|---|
| `MONITORING_API_KEY` | `MONITORING_API_KEY` | Shared secret for API auth |
| `WORKER_URL` | `WORKER_URL` | Public URL of the worker |

## Auth Pattern

All API calls use query param auth: `?secret=${MONITORING_API_KEY}`

```bash
BASE="${WORKER_URL}/monitoring/api"
SECRET="?secret=${MONITORING_API_KEY}"

# List checks
curl -s "${BASE}/checks${SECRET}" | jq

# Create a check
curl -s -X POST "${BASE}/checks${SECRET}" \
  -H 'Content-Type: application/json' \
  -d '{"id":"my-check","name":"My Check","url":"https://example.com"}' | jq

# Get status
curl -s "${BASE}/status${SECRET}" | jq

# Run a check immediately
curl -s -X POST "${BASE}/checks/my-check/run${SECRET}" | jq
```

## Available API Endpoints

See the full [API Reference](/guide/api-reference) for all endpoints.

## Integration Pattern

1. Worker exposes `/monitoring/api/*` with dual-auth (your auth middleware + `?secret=` query param)
2. Pass `MONITORING_API_KEY` and `WORKER_URL` to the agent's container
3. Agent uses `curl` with `?secret=` to manage checks via the API
