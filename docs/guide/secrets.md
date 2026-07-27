# Secrets

Monitoring an authenticated endpoint means a check needs a credential. Storing
that credential in the checks table would make the database — and any config
export, API response, or alert payload — sensitive.

clawdwatch stores a **reference** instead.

## How it works

Declare the values your deployment has:

```ts
createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,
  secrets: (env) => ({
    HEALTHCHECK_SECRET: env.HEALTHCHECK_SECRET,
    PARTNER_API_KEY: env.PARTNER_API_KEY,
  }),
});
```

Reference one by name in a check:

```json
{
  "id": "partner-api",
  "url": "https://api.example.com/status",
  "headers": { "X-Api-Key": "${PARTNER_API_KEY}" }
}
```

What is stored is the literal text `${PARTNER_API_KEY}`. Substitution happens
at exactly one moment — building the outbound request — and the resolved value
exists only for the duration of that fetch.

References work in headers, the body, and the URL.

## The write guard

A check containing a real secret value is rejected:

```json
{ "error": "Refusing to store a literal secret value in check headers (matches: PARTNER_API_KEY). Use a reference like ${PARTNER_API_KEY} instead." }
```

This applies to the API, the dashboard, and config imports alike. It is what
makes a UI-editable, database-backed system safe to open-source: there is no
path by which a value reaches D1.

Values shorter than eight characters are not matched, since a short string
would appear everywhere and make the guard useless.

## Missing references fail loudly

If a check references a name your config does not provide, the check fails with
a clear error rather than sending an empty header and reporting a mysterious
401:

```
Unresolved secret reference(s): PARTNER_API_KEY. Add them to the `secrets`
option and set the corresponding Worker secret.
```

One misconfigured check fails on its own. The rest of the run continues.

## Whole-domain headers

Some tokens belong to a domain rather than a check — a WAF bypass, or a header
your bot protection needs. `headerRules` applies them to every check on a
matching host:

```ts
headerRules: [
  {
    host: /(^|\.)example\.com$/,
    headers: { 'x-waf-bypass': '${WAF_BYPASS_TOKEN}' },
  },
],
```

`host` accepts an exact string or a pattern. Rules apply after a check's own
headers, so a rule can supply something the check does not know about. Checks
on other hosts are untouched — the token is never sent somewhere it does not
belong.

## What leaves the system

Everything outbound is redacted first:

| Path | What appears |
|---|---|
| `GET /api/checks` | `${PARTNER_API_KEY}` |
| `GET /api/config` | `${PARTNER_API_KEY}` — safe to commit |
| Alert payloads | no headers at all; only id, name, url, tags, status |
| Logs | references, never values |
| The dashboard | references, with a note explaining them |

A property test asserts this across every combination of secret and placement:
no resolved value appears in any outbound representation.

## What is never stored

Response bodies are read only to evaluate assertions, then discarded. Only the
assertion failure message is kept, truncated to 256 characters. A monitored
endpoint returning personal data does not leak it into your monitoring
database.
