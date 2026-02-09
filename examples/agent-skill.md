# Agent Skill Example

This is a template for an AI agent skill (e.g. openclaw/moltbot) that manages
monitoring via the clawdwatch API. Copy and adapt for your agent.

The key pattern: the agent runs inside a container and calls the worker's
monitoring API using a shared secret passed as an environment variable.

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

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Overall status with all check states |
| GET | `/api/checks` | List all checks |
| GET | `/api/checks/:id` | Get single check |
| POST | `/api/checks` | Create check (requires id, name, url) |
| PUT | `/api/checks/:id` | Update check (partial) |
| DELETE | `/api/checks/:id` | Delete check |
| POST | `/api/checks/:id/toggle` | Enable/disable check |
| POST | `/api/checks/:id/run` | Run check immediately |
| GET | `/api/incidents` | List incidents (?check_id, ?status, ?limit) |
| GET | `/api/alert-rules` | List alert rules (read-only) |
| GET | `/api/config` | Export full config |
| PUT | `/api/config` | Import checks (declarative sync) |
