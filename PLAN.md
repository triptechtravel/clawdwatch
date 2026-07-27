# clawdwatch v3 — Plan

Synthetic monitoring for Cloudflare Workers, rebuilt as proper open source.
Detection stays deterministic in the library; deciding what to do about it is
pluggable — Slack, webhooks, or an AI agent (moltworker/OpenClaw, Workers AI,
anything with an HTTP surface) — **without modifying the agent**.

Target: fully replaces the private `cloudflare-worker-functions/healthcheck`
worker, and is deployable by a stranger in under ten minutes.

---

## 0. Principles

1. **Detect ≠ decide.** The library detects state transitions deterministically
   (thresholds, state machine, maintenance windows). Everything downstream of
   an `AlertEvent` is a notifier plugin.
2. **Public code, private config.** Checks live in D1 and are UI-editable, but
   secret values never enter the database — only references (`${NAME}`)
   resolved from Worker env at run time.
3. **No PII by design.** The system stores check configs, results, and
   incidents. It never stores response bodies, viewer identities, IPs, or
   emails. See §6.
4. **Agents are consumers, not dependencies.** Integration happens over the
   agent's existing public surface (HTTP + self-describing payloads).
   clawdwatch never requires a fork or patch of moltworker/OpenClaw.
5. **Every capability is exercised by the reference deployment.** No dead
   schema (the v2 `alert_rules`/`check_groups`/`regions` mistake).

---

## 1. Package shape

```
clawdwatch/
├── src/
│   ├── index.ts              createMonitor() — public API
│   ├── types.ts              CheckConfig, AlertEvent, Notifier, StateStore
│   ├── engine/
│   │   ├── runner.ts         fetch + assertions (KEEP from v2, well-tested)
│   │   ├── assertions.ts     evaluateAssertions, resolveJsonPath (KEEP)
│   │   ├── transition.ts     state machine incl. reminder + batch logic (REWRITE)
│   │   ├── orchestrator.ts   parallel fan-out, interval scheduling (REWRITE)
│   │   ├── secrets.ts        ${REF} resolution + redaction (NEW)
│   │   └── store/
│   │       ├── d1.ts         checks, incidents, results, maintenance
│   │       └── state.ts      hot alert-state (D1 table, no R2)
│   ├── notify/
│   │   ├── index.ts          Notifier interface + dispatch/batch/retry
│   │   ├── slack.ts          Block Kit (ported from healthcheck worker)
│   │   ├── webhook.ts        HMAC-signed generic POST
│   │   ├── agent.ts          agent-inbox notifier (HTTP, service-token auth)
│   │   ├── workers-ai.ts     inline triage via env.AI binding
│   │   └── queue.ts          Cloudflare Queues handoff (durable)
│   ├── routes/               Hono API (status public; writes authenticated)
│   └── dashboard/            new UI from design/dashboard-prototype.html
├── migrations/               D1 schema — ships WITH the library
├── examples/worker/          deployable reference worker + Deploy button
├── design/                   prototype (kept as design reference)
└── docs/                     VitePress (rewrite for v3)
```

Dropped from v2: Analytics Engine (write-only, nothing read it), R2 state
(JSON blob; hot state moves to a D1 table — one storage system), `alert_rules`
table (superseded by notifier config), `check_groups`, `regions`,
`type: 'browser'` (never implemented — reintroduce only when it is).

---

## 2. Core API

```ts
const monitor = createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,

  // Secret references — the ONLY way secret values reach a request.
  secrets: (env) => ({
    HEALTHCHECK_SECRET: env.HEALTHCHECK_SECRET,
    E2E_BYPASS_SECRET: env.E2E_BYPASS_SECRET,
  }),

  // Conditional headers by host — the SBFM-bypass pattern, first-class.
  headerRules: [
    { host: /(^|\.)example\.com$/,
      headers: { 'x-waf-bypass': '${WAF_BYPASS_SECRET}' } },
  ],

  resolveUrl: (url, env) => url.replace('{{WORKER_URL}}', env.WORKER_URL),

  notifiers: [
    slack({ webhook: '${SLACK_WEBHOOK_URL}', reminderEvery: '1h' }),
    agent({ url: '${AGENT_INBOX_URL}',
            auth: serviceToken('${CF_ACCESS_CLIENT_ID}', '${CF_ACCESS_CLIENT_SECRET}'),
            on: ['opened', 'recovered'] }),
    workersAi({ binding: (env) => env.AI, mode: 'annotate' }),
  ],
})

export default { fetch: monitor.fetch, scheduled: monitor.scheduled }
```

### AlertEvent (the contract everything plugs into)

```ts
type AlertEvent =
  | { kind: 'opened';    check: CheckSummary; failure: FailureDetail; incidentId: string }
  | { kind: 'recovered'; check: CheckSummary; downtimeMs: number;     incidentId: string }
  | { kind: 'reminder';  check: CheckSummary; failure: FailureDetail; downSinceMs: number }
  | { kind: 'summary';   opened: CheckSummary[]; recovered: CheckSummary[]; allClear: boolean }
```

- Events are **batched per run** (`summary` covers the multi-check outage case
  — v2 fired one alert per check, serially).
- `FailureDetail` carries assertion failure strings only — never response
  bodies (§6).
- `CheckSummary` carries the check with secret refs **redacted**
  (`${NAME}` stays `${NAME}`).

### Notifier interface

```ts
interface Notifier {
  name: string
  on?: AlertEvent['kind'][]          // default: all
  notify(event: AlertEvent, ctx: { env: unknown; fetch: typeof fetch }): Promise<void>
}
```

Failures in one notifier never block others; each is wrapped, logged, and
retried once. `queue()` exists for operators who need durable delivery.

---

## 2b. Slack — the batteries-included path

Slack works exactly like the current healthcheck worker: set one secret and
you get the full message set, no agent anywhere.

```ts
notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })]
// and if `notifiers` is omitted entirely but SLACK_WEBHOOK_URL is set,
// createMonitor defaults to exactly this — parity with healthcheck's
// "webhook configured → alerts flow" behaviour.
```

Event → message mapping is a 1:1 port of `healthcheck/src/slack-messages.ts`
(builders and their tests come across):

| AlertEvent | healthcheck equivalent |
|---|---|
| `opened` (batched in `summary`) | `buildIncidentMessage` — N of M endpoints down |
| `recovered` | `buildRecoveryMessage` — with downtime duration |
| `reminder` | `buildReminderMessage` — hourly while down (`reminderEvery: '1h'` default) |
| `summary.allClear` | `buildAllClearMessage` — all N healthy again |

Options: `channelOverrides` (route by tag), `reminderEvery`, `on` (kind
filter). Multiple `slack()` instances allowed (e.g. #alerts + #status-page).

## 3. Agent hooks — pluggable, zero agent modification

The design constraint: work with moltworker/OpenClaw **as deployed**, and with
anything else that appears later. Three tiers, all config:

### Tier 1 — `webhook()` / `agent()` (works with any agent, today)
Signed HTTP POST of the `AlertEvent` to an inbox URL. For OpenClaw on
moltworker that URL is the gateway's existing public surface behind CF Access,
authenticated with a **service token**. HMAC signature (`x-clawdwatch-signature`,
SHA-256 over timestamp+body) so any receiver can verify authenticity.
No DO bindings, no `script_name` coupling, no knowledge of Sandbox internals —
the v2 mistake (reaching into moltworker's Durable Object and silently
dropping alerts when the container slept) is structurally impossible here.

### Tier 2 — `queue()` (durable delivery for sleepy agents)
Push events to a Cloudflare Queue; the operator's own consumer (10 lines,
their repo) wakes the agent and delivers. Solves "container asleep during the
outage" without clawdwatch knowing what a Sandbox is. Retry/backoff/DLQ come
free from Queues.

### Tier 3 — `workersAi()` (no agent required)
Inline triage on the `AI` binding: classify severity, correlate co-failing
checks, write an annotation onto the incident (visible in the drawer), and
optionally gate escalation ("suppress reminder, this matches a deploy
window"). Cheap, stateless, runs in the same Worker. `mode: 'annotate' |
'gate' | 'both'`.

### The agent's inbound half: self-describing
Nothing is ever installed into the agent. Two mechanisms:

1. **HATEOAS alert payloads with signed capability links.** Every
   `AlertEvent` carries a `links` object — incident URL, ack,
   maintenance-window creation, run-now, capabilities. Action links are
   **short-lived signed URLs** (HMAC over path+expiry, ~1 h TTL, scoped to
   that incident/check), so an agent can act on the alert it received with
   **no standing credentials at all** — nothing pre-provisioned in the
   container, and a leaked link can only ack one incident for an hour.
   Standing API access (unprompted CRUD) uses Access service tokens per §3b;
   for sandboxed agents whose host allow-lists container env (e.g.
   moltworker's `buildEnvVars`), that means the host must forward
   `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` / `MONITORING_URL` —
   a 3-line, upstreamable widening of its config surface, not a coupling
   to clawdwatch.
2. **`GET /api/agent.md`** — a capability document (full API reference,
   assertion types, auth pattern) generated from the route definitions at
   build time, so it cannot drift. For unprompted use ("add a check for X"),
   the operator's whole integration is one line of agent config/memory:
   "monitoring: fetch <url>/api/agent.md". Optionally exposed as
   `/.well-known/llms.txt` for generic agent discovery.

---

## 3b. Auth topology (Cloudflare Zero Trust Access)

Machine access uses **Access service tokens**; humans use the same apps via
SSO. No query-param secrets anywhere (the v2 `?secret=` fallback is dropped —
secrets in URLs leak into logs and violate §6).

- Two Access applications on one hostname: UI (`/*`, Allow: IdP group) and
  API (`/api/*`, Allow: IdP group **+** Service Auth: agent tokens). Separate
  AUD tags → a leaked agent token is scoped to `/api/*` and rotates
  independently of human access.
- Agents send `CF-Access-Client-Id` / `CF-Access-Client-Secret`; Access mints
  a JWT delivered as `Cf-Access-Jwt-Assertion`.
- The Worker middleware **always validates the JWT** (JWKS, `aud`, `iss`) and
  accepts both shapes: identity JWTs (`email` claim) and service-token JWTs
  (`common_name` claim — no email). Write routes may restrict to specific
  `common_name`s. Validated identity is used for the authz decision and then
  discarded — never stored (§6).
- `GET /api/status` may be mounted outside Access for a public status page —
  a routing decision, not an auth bypass.
- Outbound symmetry: the `agent()` notifier attaches a service-token pair via
  `serviceToken(...)` when the agent's inbox is itself behind Access.
- Tests (M3 authz matrix): valid identity JWT, valid service token,
  wrong-`aud` JWT rejected, unsigned request rejected, `common_name`
  allow-list enforced.

## 4. Storage & schema (single system: D1)

`migrations/0001_init.sql` — `checks`, `check_state`, `check_results`,
`incidents`, `maintenance_windows`. Notable changes from v2:

- `check_state` table replaces the R2 JSON blob (transactional with results;
  adds `last_alert_at` for reminder scheduling — v2 could not express
  reminders).
- `incidents` gains `annotation` (Workers AI triage output) and
  `ack_by`/`ack_note` — free-text, operator-supplied, documented as
  "do not put personal data here" (§6).
- `check_results` keeps the 48 h hot window + prune. Long-range uptime is out
  of scope for v3.0 (documented; the seam is `store/`, an operator can add
  their own sink via a notifier).
- Header values in `checks.headers` may contain `${REF}` only — writes that
  contain a value matching known secret names are rejected (see §6 tests).

Config round-trip: `GET/PUT /api/config` exports/imports the full check set as
JSON (secret refs intact) — this is the config-driven path for operators who
prefer code review over UI edits: keep `checks.json` in the private repo, CI
`PUT`s it on deploy. UI and config-file workflows write through the same
validated path.

---

## 5. Execution engine fixes (from the v2 review)

| v2 defect | v3 behaviour |
|---|---|
| Serial `for…await` checks | `Promise.allSettled` with concurrency cap (6) and per-check timeout — 10+ checks can't blow the cron wall-clock |
| One alert per check, fired mid-loop | Transitions collected, batched into events after the run |
| No reminders (`unhealthy→unhealthy` = silence) | `reminder` events on `reminderEvery` cadence from `last_alert_at` |
| `interval_mins` jitter hack | Honest scheduling: run when `now − last_run ≥ interval − cron/2`; documented cron-bound granularity |
| Retry inside `runCheck` with fixed sleep | Keep (it's fine), but cap total retry budget per check |
| `onAlert` errors swallowed per check | Notifier dispatch isolated + logged with event kind and target |

`runner.ts`/`assertions.ts` carry over nearly intact — they're the good part.

---

## 6. No-PII posture (enforced, not aspirational)

**Never stored:** response bodies (assertions evaluate in memory; only failure
strings like `Expected status 200, got 502` persist, truncated to 256 chars);
viewer identity (CF Access JWTs are verified and discarded — no email columns
anywhere); client IPs; raw secret values.

**Redaction layer (`engine/secrets.ts`):** one module owns resolution and
redaction. Everything leaving the system — API responses, alert payloads, logs,
config export — passes through `redact()`, which returns headers with refs
un-resolved. Resolution happens only at the moment of the outbound check
request.

**Write-time guard:** creating/updating a check whose header/body values
contain a configured secret *value* (not ref) is rejected with a pointed error
("use `${NAME}`"). This is what keeps a UI-driven system honest.

**Repo hygiene:** no real hostnames in fixtures (`example.com` only — current
tests already leak `campermate.com` topology into the public repo via
`examples/`; scrub), `SECURITY.md` with a disclosure contact, secret-scanning
+ gitleaks in CI, and the reference worker's `wrangler.jsonc` uses placeholder
IDs.

---

## 7. Dashboard (from the validated prototype)

`design/dashboard-prototype.html` is the spec — tick strips (quiet-healthy
salience), fleet bar, filter chips, detail drawer, both themes, keyboard
inspection, focus trap. Build it as the real `src/dashboard/` (React, existing
Vite pipeline) against the live API:

- Read views public-friendly (status page); **write actions appear only when
  the API says writes are authorized** (CF Access / service token / DEV_MODE).
- Adds over v2: check editor (with secret-ref helper + the write-time guard
  surfaced as validation), incident timeline w/ AI annotations, maintenance
  window editor, notifier status panel ("last delivery: 200 OK · 3 m ago" —
  the observability whose absence hid the v2 DO-name bug for months).
- "Run all now" and toggles wired for real. Live-region announcements and the
  a11y work from the prototype carry over as requirements, not nice-to-haves.

---

## 8. Testing strategy

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | assertions (keep+extend v2's 500 lines), transition machine incl. reminder/batch edges, jsonPath, secret resolve/redact round-trip |
| Property | Vitest | redaction: ∀ configs, no output of any API/alert/log path contains a resolved secret value (seeded generators) |
| Integration | `@cloudflare/vitest-pool-workers` (miniflare) | full cron tick against real D1 (migrations applied), notifier dispatch order/batching/isolation, HMAC verify, config import/export round-trip |
| API | vitest + Hono test client | authz matrix: public reads, rejected writes w/o token, DEV_MODE, secret-value write guard |
| UI | Vitest + Testing Library | drawer focus trap, filter logic, tick keyboard nav, redacted rendering |
| E2E smoke | Playwright vs `wrangler dev` | seed checks → force failure → incident opens → webhook receiver gets signed event → recover → all-clear |
| CI | GitHub Actions | typecheck, oxlint, tests + coverage gate, gitleaks, `npm publish --provenance` on tag via changesets |

Definition of done for every engine change: a failing test first (the v2
DO-name bug and hidden-first-row bug both existed because nothing verified
delivery/rendering end-to-end).

---

## 9. OSS hygiene

- Apache-2.0 (already), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  issue templates, `CHANGELOG.md` via changesets, semver from `0.2.0` → `1.0.0`
  when the healthcheck parallel-run completes.
- README rewritten around the 10-minute quickstart: Deploy button on
  `examples/worker/`, `wrangler d1 migrations apply`, `wrangler secret put
  SLACK_WEBHOOK_URL`, add first check in UI → first alert reaches Slack with
  zero code beyond the template.
- Docs site: Getting Started / Configuration (incl. secret refs + headerRules)
  / Notifiers (each adapter + writing your own) / Agent integration (self-describing
  events + /api/agent.md) / API reference / Self-hosted dashboard.
- The moltworker-specific example moves to docs as *one* integration recipe
  among several (generic webhook, Queues consumer, Workers AI) — the repo
  stops implying a moltworker dependency.

---

## 10. Sequence & acceptance

**M1 — Engine + contracts** (types, transition machine, secrets module,
parallel orchestrator, D1 stores, migrations). *Accept:* integration suite
green in miniflare; property redaction test green.

**M2 — Notifiers** (dispatch core, slack, webhook+HMAC, agent, queue,
workers-ai). *Accept:* E2E smoke delivers signed events; notifier isolation
proven by a deliberately-throwing notifier test.

**M3 — API + dashboard** (routes w/ authz, UI build-out from prototype,
notifier status panel). *Accept:* authz matrix green; a11y checks from
prototype reproduced in component tests.

**M4 — OSS release** (docs, examples, CI/publish pipeline, repo hygiene
scrub). *Accept:* fresh-account deploy from README in ≤10 min, no private
hostnames/IDs anywhere in the repo.

**M5 — Production cutover** (private consumer repo: 10 healthcheck endpoints
as config JSON + Slack notifier; run in parallel with the old healthcheck
worker ≥1 week, diff every alert; then delete `healthcheck/` and the stale
moltbot-services/pricewatch estate per the earlier teardown plan).
*Accept:* zero missed/false alerts vs legacy during the window.

**M6 (optional, post-1.0)** — long-range history sink recipe (notifier-based).
The agent integration formerly sketched here is now a full track: Part II.

---

# Part II — moved

The assistant (Project Think + Workers AI, private) lives in its own private
repo with its own PLAN.md. It consumes clawdwatch purely through the public
contract: signed `AlertEvent` webhooks in, `/api/agent.md` + Access service
token out. Nothing in this repo references it.

---

## Resolved decisions (from prior sessions)

- D1-backed checks + UI (not config-as-code-only) — the UI requirement decides it; config round-trip covers the code-review workflow.
- No Analytics Engine in v3.0; the notifier seam is the extension point for history sinks.
- No DO/RPC coupling to any agent — HTTP + Queues + self-describing events only.
- Prototype design (quiet-healthy ticks, drawer, both themes) is the UI spec.
- Assistant is **private** (Part II); clawdwatch is **public** — the boundary is the signed public contract, in both directions.
- Assistant stack: Project Think + Workers AI (no Anthropic), channels hand-rolled, moltworker/OpenClaw fully retired at A6.
- Anomaly detection stays in Datadog/deterministic baselines; the LLM correlates and narrates, never detects.
