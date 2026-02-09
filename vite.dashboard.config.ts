import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/dashboard',
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/dashboard/index.html',
    },
  },
});
