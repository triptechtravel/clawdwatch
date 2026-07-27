import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Integration suite: runs inside workerd against a real D1, so the SQL in
 * engine/store/d1.ts is genuinely executed. The unit suite
 * (vitest.config.ts) stays on the node pool and covers pure logic.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.jsonc' },
      miniflare: { compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
