# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/triptechtravel/clawdwatch/security/advisories/new)
rather than opening a public issue. We aim to acknowledge within three working
days.

## Design commitments

These are properties the project treats as invariants, not preferences. If you
find a way to break one, that is a security bug.

**Secret values never reach storage.** Checks reference secrets as `${NAME}`.
Substitution happens at exactly one point — building the outbound request — and
every path leaving the system (API responses, alert payloads, logs, config
exports) passes through redaction first. Writing a check that contains a literal
secret value is rejected. A property test asserts that no resolved value appears
in any outbound representation.

**Response bodies are never persisted.** Bodies are read only to evaluate
assertions, then discarded. What is stored is the assertion failure message,
truncated to 256 characters. A monitored endpoint that returns personal data
does not leak it into the monitoring database.

**No identity is stored.** Access JWTs are verified for the authorization
decision and discarded. There are no email, IP, or user-agent columns.

**Arriving through Access is not treated as evidence.** JWTs are verified
against the team's JWKS, the expected `aud`, the issuer, and the clock —
because anyone who learns the Worker's direct route bypasses the Access edge.

**No query-parameter authentication.** URLs end up in logs, analytics, and
referrer headers. Authentication is an Access JWT or a scoped, expiring signed
capability link.

## Reducing your own exposure

- Put the API behind a separate Access application from the dashboard, so a
  leaked agent service token is scoped to `/api/*` and rotates independently.
- Give checks the narrowest credential that works; monitoring rarely needs more
  than an unauthenticated health endpoint.
- `DEV_MODE` bypasses authentication and is intended only for
  `wrangler dev`. Never set it in a deployed environment.
