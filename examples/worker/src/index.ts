/**
 * A complete clawdwatch deployment.
 *
 * Everything below is configuration. The only thing you must supply is a
 * D1 binding; set SLACK_WEBHOOK_URL and alerts start flowing with no further
 * wiring.
 */

import { createMonitor, slack, webhook, hmac, serviceToken } from 'clawdwatch';

export interface Env {
  MONITORING_DB: D1Database;

  /** Public URL of this Worker. Used to build links inside alerts. */
  BASE_URL?: string;

  // ── Secrets (wrangler secret put …) ──────────────────────────────────
  /** Incoming webhook for your Slack channel. */
  SLACK_WEBHOOK_URL?: string;
  /** Shared key for signing outbound webhooks and capability links. */
  ALERT_SIGNING_SECRET?: string;
  /** Where to POST alerts, if you route them to an agent or your own service. */
  AGENT_INBOX_URL?: string;

  // ── Cloudflare Access (for the API and dashboard) ────────────────────
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /** Comma-separated service-token client ids permitted to write. */
  ALLOWED_SERVICE_TOKENS?: string;

  /** Any secret a check needs — see `secrets` below. */
  EXAMPLE_API_KEY?: string;

  /** Local development only; refuses to start when set in production. */
  DEV_MODE?: string;
}

const monitor = createMonitor<Env>({
  d1: (env) => env.MONITORING_DB,

  baseUrl: (env) => env.BASE_URL ?? 'http://localhost:8787',

  /**
   * Secret values, keyed by the name checks reference as `${NAME}`.
   * A check may never contain a literal value — writes carrying one are
   * rejected, so this map is the only path a secret takes to the wire.
   */
  secrets: (env) => ({
    SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL,
    ALERT_SIGNING_SECRET: env.ALERT_SIGNING_SECRET,
    AGENT_INBOX_URL: env.AGENT_INBOX_URL,
    EXAMPLE_API_KEY: env.EXAMPLE_API_KEY,
  }),

  /**
   * Headers added to every check whose URL host matches. Useful when a WAF or
   * bot-protection rule needs a bypass token that the check itself should not
   * have to know about.
   */
  headerRules: [
    // {
    //   host: /(^|\.)example\.com$/,
    //   headers: { 'x-waf-bypass': '${EXAMPLE_API_KEY}' },
    // },
  ],

  /** Lets a check target this deployment without hardcoding its URL. */
  resolveUrl: (url, env) => url.replace('{{BASE_URL}}', env.BASE_URL ?? 'http://localhost:8787'),

  auth: (env) => ({
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
    aud: env.CF_ACCESS_AUD,
    allowedServiceTokens: env.ALLOWED_SERVICE_TOKENS?.split(',').map((s) => s.trim()),
    capabilitySecret: env.ALERT_SIGNING_SECRET,
    devMode: env.DEV_MODE === 'true',
  }),

  notifiers: [
    // Remove this and alerts still reach Slack when SLACK_WEBHOOK_URL is set —
    // it is the default. Declared explicitly here so it is easy to configure.
    slack({ webhook: '${SLACK_WEBHOOK_URL}' }),

    // Send alerts to an agent or your own service. An agent inbox is just a
    // URL: pick hmac() for a plain endpoint, or serviceToken() when the
    // receiver sits behind Cloudflare Access.
    // webhook({
    //   url: '${AGENT_INBOX_URL}',
    //   auth: hmac('${ALERT_SIGNING_SECRET}'),
    //   on: ['opened', 'recovered'],
    // }),
  ],
});

export default {
  fetch: monitor.fetch,
  scheduled: monitor.scheduled,
};

// Referenced in the commented examples above; re-exported so editors resolve
// them and the example typechecks as written.
export { webhook, hmac, serviceToken };
