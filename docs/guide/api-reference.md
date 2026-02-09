# API Reference

## Routes

All routes are relative to the mount point (e.g., `/monitoring`).

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Overall status with all check states |
| GET | `/api/checks` | List all checks |
| GET | `/api/checks/:id` | Get single check |
| POST | `/api/checks` | Create check |
| PUT | `/api/checks/:id` | Update check (partial) |
| DELETE | `/api/checks/:id` | Delete check |
| POST | `/api/checks/:id/toggle` | Enable/disable check |
| POST | `/api/checks/:id/run` | Run check immediately |
| GET | `/api/incidents` | List incidents (`?check_id`, `?status`, `?limit`) |
| GET | `/api/alert-rules` | List alert rules |
| POST | `/api/alert-rules` | Create alert rule |
| DELETE | `/api/alert-rules/:id` | Delete alert rule |
| GET | `/api/maintenance` | List maintenance windows |
| POST | `/api/maintenance` | Create maintenance window |
| DELETE | `/api/maintenance/:id` | Delete maintenance window |
| GET | `/api/config` | Export full config (checks + alert rules) |
| PUT | `/api/config` | Import checks (declarative sync) |

## State Machine

```
unknown  → healthy    (first success, no alert)
unknown  → degraded   (first failure, threshold not met)
healthy  → degraded   (failure, threshold not met)
degraded → unhealthy  (threshold met → onAlert 'failure')
unhealthy → healthy   (success → onAlert 'recovery')
unhealthy → unhealthy (still failing, no alert)
```

## Alert Payload

When a state transition triggers an alert, `onAlert` receives:

```typescript
interface AlertPayload {
  type: "failure" | "recovery";
  check: CheckConfig;
  checkState: CheckState;
  result: CheckResult;
  timestamp: string;
}
```

## Dashboard

The embedded dashboard is served at the mount point root (e.g., `/monitoring/`). It includes:

- Overall system status
- Per-check status timeline
- Response time sparkline
- Auto-refresh every 60 seconds
