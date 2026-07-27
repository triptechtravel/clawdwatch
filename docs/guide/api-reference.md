# API reference

Generated from the same route table that serves `GET /api/agent.md`, so this
page and the running API cannot disagree.

Base URL is wherever you deployed the Worker.

## Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET` | `/api/status` | Current status of every check, plus an overall verdict. | public |
| `GET` | `/api/checks` | All check definitions. Secret values appear as ${NAME} references. | public |
| `GET` | `/api/checks/:id` | One check definition. | public |
| `GET` | `/api/checks/:id/history` | Recent results for one check (48h retention). | public |
| `POST` | `/api/checks` | Create a check. | write |
| `PUT` | `/api/checks/:id` | Update a check. Only the fields you send change. | write |
| `DELETE` | `/api/checks/:id` | Delete a check and its history. | write |
| `POST` | `/api/checks/:id/toggle` | Enable or disable a check. | write |
| `POST` | `/api/checks/:id/run` | Run a check immediately and return the result. | capability |
| `GET` | `/api/incidents` | Incidents. Filter with ?check_id=, ?status=open|resolved, ?limit=. | public |
| `POST` | `/api/incidents/:id/annotate` | Attach a triage note to an incident. This is how an agent records what it found. | capability |
| `POST` | `/api/incidents/:id/ack` | Acknowledge an incident. | capability |
| `GET` | `/api/maintenance` | Maintenance windows currently in effect. | public |
| `GET` | `/api/deliveries` | Most recent alert delivery per notifier — did the last alert arrive? | public |
| `GET` | `/api/config` | Export every check as JSON, safe to commit (secrets stay as references). | public |
| `PUT` | `/api/config` | Import a check set, replacing matching ids. | write |
| `GET` | `/api/agent.md` | This document. | public |

`public` endpoints need no credential unless you mount them behind Access.
`write` requires a principal. `capability` accepts a signed link from an alert
as well as a principal.

## Status

```bash
curl "$BASE/api/status"
```

```json
{
  "overall": "degraded",
  "generatedAt": "2026-07-27T13:00:00.000Z",
  "checks": [
    {
      "id": "homepage",
      "name": "Homepage",
      "url": "https://example.com",
      "tags": ["production"],
      "enabled": true,
      "status": "healthy",
      "consecutiveFailures": 0,
      "lastCheckAt": "2026-07-27T12:59:00.000Z",
      "lastSuccessAt": "2026-07-27T12:59:00.000Z",
      "lastError": null,
      "lastResponseMs": 142,
      "downSince": null
    }
  ]
}
```

`overall` is the worst status among enabled checks.

## Statuses

| Status | Meaning |
|---|---|
| `unknown` | never run |
| `healthy` | last run passed |
| `degraded` | failing, but below the threshold — no alert yet |
| `unhealthy` | threshold reached; an incident is open |

## History

```bash
curl "$BASE/api/checks/homepage/history"
```

Returns up to 288 results, oldest first — one per run, which is what the
dashboard's tick strip draws. Results older than the retention window (48 hours
by default) are pruned.

## Incidents

```bash
curl "$BASE/api/incidents?status=open&limit=20"
```

Filters: `check_id`, `status` (`open` or `resolved`), `limit`.

An incident opens when a check crosses its threshold and resolves when it
passes again, recording the duration. `annotation` holds a triage note, usually
written by an agent.

## Errors

| Status | Meaning |
|---|---|
| `400` | Invalid body, failed validation, or a literal secret value |
| `401` | No credential supplied |
| `403` | Credential rejected, or Access not configured |
| `404` | No such check or incident |
| `409` | A check with that id already exists |

Authentication failures do not explain which check failed — that would tell an
attacker how close they were.
