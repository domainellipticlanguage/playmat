import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: everything is same-origin; vite proxies the room API and the realtime
// WebSocket to local-server on :8787. This means a single localhost.run (or
// LAN) tunnel of the vite port carries the whole app, phone-testable.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/event': { target: 'http://localhost:8787', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
