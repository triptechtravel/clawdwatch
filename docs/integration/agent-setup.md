# Agent Setup

ClawdWatch is designed to be managed by an AI agent. This guide provides a template skill that gives your agent full CRUD access to the monitoring API.

## Container Environment

Pass these from your worker secrets to the container:

| Worker Secret | Container Env Var | Purpose |
|---|---|---|
| `WORKER_URL` | `WORKER_URL` | Public URL of the worker |
| `CF_ACCESS_CLIENT_ID` | `CF_ACCESS_CLIENT_ID` | CF Access service token client ID |
| `CF_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | CF Access service token client secret |

## Auth Pattern

All API calls use CF Access service token headers to bypass Cloudflare Access at the edge:

```bash
BASE="${WORKER_URL}/monitoring/api"
AUTH=(-H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}")

# List checks
curl -s "${AUTH[@]}" "${BASE}/checks" | jq

# Create a check
curl -s "${AUTH[@]}" -X POST "${BASE}/checks" \
  -H 'Content-Type: application/json' \
  -d '{"id":"my-check","name":"My Check","url":"https://example.com"}' | jq

# Get status
curl -s "${AUTH[@]}" "${BASE}/status" | jq

# Run a check immediately
curl -s "${AUTH[@]}" -X POST "${BASE}/checks/my-check/run" | jq
```

## Available API Endpoints

See the full [API Reference](/guide/api-reference) for all endpoints.

## Integration Pattern

1. Worker exposes `/monitoring/api/*` with CF Access protecting all routes
2. Pass `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `WORKER_URL` to the agent's container
3. Agent uses `curl` with `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers to manage checks via the API
