/**
 * Example: Integrating clawdwatch v2 into a Cloudflare Worker (moltworker pattern)
 *
 * This shows the full wiring:
 * 1. createMonitor with D1 + AE + R2 storage
 * 2. Dual-auth middleware (CF Access OR ?secret= query param)
 * 3. Mounting before CF Access so container/CLI can reach the API
 * 4. Running checks from scheduled() handler
 */

import { Hono } from 'hono';
import { createMonitor } from 'clawdwatch';

// ---- Types ----

interface Env {
  MONITORING_DB: D1Database;
  MOLTBOT_BUCKET: R2Bucket;
  MONITORING_AE: AnalyticsEngineDataset;
  MONITORING_API_KEY?: string; // Shared secret for container/CLI access
  WORKER_URL?: string;
  // ... your other bindings
}

type AppEnv = { Bindings: Env };

// ---- Monitor Setup ----

const monitor = createMonitor<Env>({
  storage: {
    getD1: (env) => env.MONITORING_DB,
    getR2: (env) => env.MOLTBOT_BUCKET,
    getAnalyticsEngine: (env) => env.MONITORING_AE,
  },
  defaults: {
    stateKey: 'monitoring/state.json',
  },
  resolveUrl: (url, env) =>
    url.replace(
      '{{WORKER_URL}}',
      (env.WORKER_URL ?? 'http://localhost:8787').replace(/\/+$/, ''),
    ),
  onAlert: async (alert, _env) => {
    // Called on state transitions (failure/recovery).
    // Post to your agent, webhook, or notification service.
    console.log(`[monitoring] Alert: ${alert.type} for ${alert.check.name}`);
  },
});

// ---- App ----

const app = new Hono<AppEnv>();

// ---- Dual-Auth Middleware ----
// Mount monitoring BEFORE your main auth middleware so that
// container/CLI callers can authenticate via ?secret= query param.

app.use('/monitoring/*', async (c, next) => {
  // 1. Check query param secret (container/CLI access)
  const url = new URL(c.req.url);
  const providedSecret = url.searchParams.get('secret');
  const expectedSecret = c.env.MONITORING_API_KEY;

  if (providedSecret && expectedSecret && timingSafeEqual(providedSecret, expectedSecret)) {
    return next();
  }

  // 2. Fall through to your normal auth (e.g. CF Access, JWT, etc.)
  //    Replace this with your auth middleware:
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
});

// Mount clawdwatch app (dashboard + API)
app.route('/monitoring', monitor.app);

// ---- Your other routes (behind auth) ----
// app.use('*', yourAuthMiddleware);
// app.route('/api', yourApiRoutes);

// ---- Scheduled Handler ----

async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
  await monitor.runChecks(env);
}

export default {
  fetch: app.fetch,
  scheduled,
};

// ---- Utility ----

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
