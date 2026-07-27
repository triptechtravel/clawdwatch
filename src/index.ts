/**
 * clawdwatch — synthetic monitoring for Cloudflare Workers.
 *
 * The library detects state transitions deterministically. What to do about
 * them is a notifier plugin: Slack, a signed webhook, an AI agent, or your own.
 *
 *   const monitor = createMonitor<Env>({
 *     d1: (env) => env.MONITORING_DB,
 *     secrets: (env) => ({ SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL }),
 *     notifiers: [slack({ webhook: '${SLACK_WEBHOOK_URL}' })],
 *   })
 *
 *   export default { fetch: monitor.fetch, scheduled: monitor.scheduled }
 */

import { DEFAULTS, type ClawdWatchOptions, type Notifier, type SecretMap } from './types';
import { runMonitoringChecks, type RunReport } from './engine/orchestrator';
import { dispatch, type DeliveryReport } from './notify';
import { slack } from './notify/slack';
import { resolveTemplate } from './engine/secrets';
import { createRoutes } from './routes';

export interface Monitor<TEnv> {
  /** Execute one monitoring pass and deliver any resulting alerts. */
  runChecks(env: TEnv): Promise<RunReport & { deliveries: DeliveryReport[] }>;
  /** Cron entry point. */
  scheduled(event: ScheduledController, env: TEnv, ctx: ExecutionContext): Promise<void>;
  /** HTTP entry point — the API (and, when built, the dashboard). */
  fetch(request: Request, env: TEnv, ctx: ExecutionContext): Promise<Response>;
  /** The Hono app, for mounting under your own routes. */
  app: ReturnType<typeof createRoutes<TEnv>>;
}

export function createMonitor<TEnv>(options: ClawdWatchOptions<TEnv>): Monitor<TEnv> {
  const defaults = { ...DEFAULTS, ...options.defaults };

  async function runChecks(env: TEnv) {
    const secrets: SecretMap = options.secrets?.(env) ?? {};
    const resolve = (template: string) => resolveTemplate(template, secrets);

    // Parity with the worker this replaces: a configured SLACK_WEBHOOK_URL is
    // enough to get alerts, with no notifier wiring at all. Explicit
    // `notifiers` always wins — this only fills an empty list.
    const notifiers: Notifier<TEnv>[] =
      options.notifiers && options.notifiers.length > 0
        ? options.notifiers
        : secrets.SLACK_WEBHOOK_URL
          ? [slack<TEnv>({ webhook: '${SLACK_WEBHOOK_URL}' })]
          : [];

    const report = await runMonitoringChecks({
      db: options.d1(env),
      secrets,
      headerRules: options.headerRules ?? [],
      resolveUrl: (url) => options.resolveUrl?.(url, env) ?? url,
      userAgent: defaults.userAgent,
      concurrency: defaults.concurrency,
      historyRetentionHours: defaults.historyRetentionHours,
      baseUrl: options.baseUrl?.(env),
    });

    const deliveries = await dispatch(report.events, notifiers, { env, resolve });

    return { ...report, deliveries };
  }

  const app = createRoutes<TEnv>({
    options,
    // Auth is resolved per request so it can read from env.
    auth: {},
    resolveAuth: options.auth,
  });

  return {
    app,
    runChecks,
    async fetch(request, env, ctx) {
      return app.fetch(request, env as Record<string, unknown>, ctx);
    },
    async scheduled(_event, env, ctx) {
      // waitUntil so delivery retries survive the handler returning.
      const work = runChecks(env).catch((err) => {
        console.error('[clawdwatch] scheduled run failed:', err);
      });
      ctx.waitUntil(work);
      await work;
    },
  };
}

// ── Public surface ──────────────────────────────────────────────────────

export type {
  Assertion,
  AlertEvent,
  AlertEventKind,
  AlertLinks,
  BodyAssertion,
  CheckConfig,
  CheckResult,
  CheckState,
  CheckStatus,
  CheckSummary,
  ClawdWatchDefaults,
  ClawdWatchOptions,
  FailureDetail,
  HeaderAssertion,
  HeaderRule,
  Incident,
  JsonPathAssertion,
  MaintenanceWindow,
  Notifier,
  NotifierContext,
  ResponseTimeAssertion,
  SecretMap,
  StatusCodeAssertion,
} from './types';

export { DEFAULTS } from './types';
export { dispatch, type DeliveryReport } from './notify';
export { slack, buildPayload, formatDuration } from './notify/slack';
export {
  webhook,
  hmac,
  serviceToken,
  combineAuth,
  signPayload,
  verifySignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type WebhookAuth,
  type WebhookOptions,
} from './notify/webhook';
export { runMonitoringChecks, isDue, type RunReport } from './engine/orchestrator';
export { createRoutes, normaliseCheck } from './routes';
export { ROUTES, buildAgentDoc, type RouteDoc } from './routes/agent-md';
export {
  authenticate,
  requireAuth,
  mintCapability,
  verifyCapability,
  verifyAccessJwt,
  AuthError,
  AccessVerificationError,
  type AuthConfig,
  type Principal,
  type AccessIdentity,
} from './auth';
export { computeTransition, emptyState, type Transition } from './engine/transition';
export { evaluateAssertions, resolveJsonPath } from './engine/assertions';
export {
  LeakedSecretError,
  UnresolvedSecretError,
  assertNoLeakedSecrets,
  redactCheck,
  resolveTemplate,
  scrub,
  toCheckSummary,
} from './engine/secrets';
