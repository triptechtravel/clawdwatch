import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  external: ['hono', 'react', 'react-dom'],
  esbuildOptions(options) {
    options.alias = {
      'react': 'react',
      'react-dom': 'react-dom',
    };
  },
});
