import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // three + drei make a big (but single-page, cacheable) bundle.
    chunkSizeWarningLimit: 2000,
  },
});
