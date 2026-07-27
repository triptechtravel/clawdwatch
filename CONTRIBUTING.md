# Contributing

## Getting set up

```bash
npm install
npm test
```

`npm test` runs the unit suite (node) and then the integration suite, which
executes inside workerd against a real D1 with the shipped migration applied.

## Before opening a pull request

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Conventions worth knowing

**Tests come first for anything in the engine.** Every serious bug this project
has shipped existed because a path had no test — an alert transport that
silently dropped everything, a dashboard row hidden behind its own header, a
foreign key that would fail a whole batch. If you are changing `src/engine/`,
write the failing test first.

**Secrets have exactly one code path.** `engine/secrets.ts` owns resolution and
redaction. Do not resolve a `${REFERENCE}` anywhere else, and do not add a way
for a value to reach D1, a response, or a log. See SECURITY.md.

**No dead schema.** v2 shipped tables and config fields nothing ever read
(`alert_rules`, `check_groups`, `regions`, a browser check type that was never
implemented). If you add a column or an option, add the code that uses it in
the same change, or leave it out.

**Domain types are camelCase; D1 columns are snake_case.** The mapping lives in
`engine/store/d1.ts` and nowhere else.

**A new route needs a `ROUTES` entry.** `GET /api/agent.md` is generated from
that table, and a test asserts the two match in both directions. This is how
the API documentation stays true.

**Use `example.com` in tests, fixtures, and docs.** CI fails on anything that
looks like a real private hostname.

## Layout

```
src/engine/    check execution, assertions, state machine, D1 access
src/notify/    notifier interface, dispatch, slack, webhook
src/routes/    HTTP API and the generated capability document
src/auth/      Cloudflare Access verification, capability links
src/dashboard/ the UI
migrations/    D1 schema, applied by the integration suite
examples/      deployable reference worker
design/        UI prototype kept as the design reference
```

## Releases

Version bumps and changelog entries are handled with changesets. Add one with
`npx changeset` describing the change from a user's point of view.
