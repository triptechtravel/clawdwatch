# Agent Skill Example

This is a template for an AI agent skill (e.g. [openclaw](https://github.com/triptechtravel/openclaw)) that manages
monitoring via the clawdwatch API. Copy and adapt for your agent.

The key pattern: the agent runs inside a container and calls the worker's
monitoring API using CF Access service token headers to bypass Cloudflare Access.

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
| GET | `/api/alert-rules` | List alert rules |
| POST | `/api/alert-rules` | Create alert rule (requires channel) |
| DELETE | `/api/alert-rules/:id` | Delete alert rule |
| GET | `/api/maintenance` | List maintenance windows |
| POST | `/api/maintenance` | Create maintenance window (requires starts_at, ends_at) |
| DELETE | `/api/maintenance/:id` | Delete maintenance window |
| GET | `/api/config` | Export full config |
| PUT | `/api/config` | Import checks (declarative sync) |
