/**
 * The capability document served at `GET /api/agent.md`.
 *
 * This replaces the idea of shipping a skill file for agents to install. A
 * static file that duplicates a live API drifts and, in practice, never gets
 * installed at all — the previous generation's skill claimed 90-day retention
 * for a system that kept 48 hours, and was never copied into the container.
 *
 * The route table below is the single source of truth: `createRoutes` mounts
 * exactly these paths, and a test asserts the two never diverge.
 */

export interface RouteDoc {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  auth: 'public' | 'write' | 'capability';
  body?: string;
}

export const ROUTES: RouteDoc[] = [
  {
    method: 'GET',
    path: '/api/status',
    summary: 'Current status of every check, plus an overall verdict.',
    auth: 'public',
  },
  {
    method: 'GET',
    path: '/api/checks',
    summary: 'All check definitions. Secret values appear as ${NAME} references.',
    auth: 'public',
  },
  {
    method: 'GET',
    path: '/api/checks/:id',
    summary: 'One check definition.',
    auth: 'public',
  },
  {
    method: 'GET',
    path: '/api/checks/:id/history',
    summary: 'Recent results for one check (48h retention).',
    auth: 'public',
  },
  {
    method: 'POST',
    path: '/api/checks',
    summary: 'Create a check.',
    auth: 'write',
    body: '{ "id": "api-health", "name": "API Health", "url": "https://api.example.com/health", "assertions": [{"type":"statusCode","operator":"is","value":200}], "tags": ["production"] }',
  },
  {
    method: 'PUT',
    path: '/api/checks/:id',
    summary: 'Update a check. Only the fields you send change.',
    auth: 'write',
    body: '{ "timeoutMs": 5000 }',
  },
  {
    method: 'DELETE',
    path: '/api/checks/:id',
    summary: 'Delete a check and its history.',
    auth: 'write',
  },
  {
    method: 'POST',
    path: '/api/checks/:id/toggle',
    summary: 'Enable or disable a check.',
    auth: 'write',
  },
  {
    method: 'POST',
    path: '/api/checks/:id/run',
    summary: 'Run a check immediately and return the result.',
    auth: 'capability',
  },
  {
    method: 'GET',
    path: '/api/incidents',
    summary: 'Incidents. Filter with ?check_id=, ?status=open|resolved, ?limit=.',
    auth: 'public',
  },
  {
    method: 'POST',
    path: '/api/incidents/:id/annotate',
    summary: 'Attach a triage note to an incident. This is how an agent records what it found.',
    auth: 'capability',
    body: '{ "annotation": "Deploy abc123 at 14:02 changed auth middleware; Sentry shows a matching spike." }',
  },
  {
    method: 'POST',
    path: '/api/incidents/:id/ack',
    summary: 'Acknowledge an incident.',
    auth: 'capability',
    body: '{ "note": "investigating" }',
  },
  {
    method: 'GET',
    path: '/api/maintenance',
    summary: 'Maintenance windows currently in effect.',
    auth: 'public',
  },
  {
    method: 'GET',
    path: '/api/config',
    summary: 'Export every check as JSON, safe to commit (secrets stay as references).',
    auth: 'public',
  },
  {
    method: 'PUT',
    path: '/api/config',
    summary: 'Import a check set, replacing matching ids.',
    auth: 'write',
    body: '{ "checks": [ ... ] }',
  },
  {
    method: 'GET',
    path: '/api/agent.md',
    summary: 'This document.',
    auth: 'public',
  },
];

const ASSERTIONS = `
| Type | Operators | Example |
|---|---|---|
| \`statusCode\` | is, isNot | \`{"type":"statusCode","operator":"is","value":200}\` |
| \`header\` | is, isNot, contains, notContains, matches | \`{"type":"header","name":"content-type","operator":"contains","value":"json"}\` |
| \`body\` | contains, notContains, matches | \`{"type":"body","operator":"contains","value":"\\"healthy\\""}\` |
| \`responseTime\` | lessThan | \`{"type":"responseTime","operator":"lessThan","value":3000}\` |
| \`jsonPath\` | is, isNot, contains, notContains, matches, lessThan, greaterThan | \`{"type":"jsonPath","path":"$.data.status","operator":"is","value":"ok"}\` |
`.trim();

export function buildAgentDoc(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');

  const table = ROUTES.map(
    (r) => `| \`${r.method}\` | \`${r.path}\` | ${r.summary} | ${r.auth} |`,
  ).join('\n');

  const examples = ROUTES.filter((r) => r.body)
    .map(
      (r) =>
        `### ${r.method} ${r.path}\n\n\`\`\`bash\ncurl -X ${r.method} "${base}${r.path}" \\\n  -H 'Content-Type: application/json' \\\n  -d '${r.body}'\n\`\`\``,
    )
    .join('\n\n');

  return `# clawdwatch API

Synthetic monitoring for this deployment. Base URL: \`${base}\`

## Acting on an alert

Alerts arrive as a signed POST with a \`links\` object — incident, ack,
annotate, runNow, capabilities. Those links are short-lived signed URLs, so you
can act on the alert you received without any standing credential. Use them
directly; no setup required.

## Standing access

For anything not driven by an alert, authenticate with a Cloudflare Access
service token:

\`\`\`bash
curl "${base}/api/status" \\
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
\`\`\`

Reads are open unless the deployment mounts them behind Access. Writes always
require a principal.

## Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
${table}

## Assertions

${ASSERTIONS}

## Secrets

Never send a literal secret. Reference it by name and the Worker resolves it at
request time:

\`\`\`json
{ "headers": { "X-Api-Key": "\${MY_API_KEY}" } }
\`\`\`

A request carrying a literal secret value is rejected with 400.

## Examples

${examples}

## Notes

- Response bodies are never stored. Failures are recorded as assertion
  messages, truncated to 256 characters.
- Results are retained for 48 hours.
- A check is unhealthy after \`failureThreshold\` consecutive failures, and
  reminders repeat on \`reminderIntervalMs\` while it stays down.
`;
}
