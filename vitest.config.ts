import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit suite only. test/ runs in workerd via vitest.integration.config.ts.
    include: ['src/**/*.test.ts'],
  },
});
