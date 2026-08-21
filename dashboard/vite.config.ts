import react from '@vitejs/plugin-react';
// From vitest/config rather than vite: it re-exports the same defineConfig widened to
// accept the `test` block, so `tsc -b` type-checks this file instead of rejecting it.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom rather than node: the permission helpers are pure, but the components that
    // consume them are not, and one environment for both keeps the suite honest about
    // what actually renders.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Ambient decoration only — the tests that matter here are about security-adjacent
    // logic, and chasing a coverage number on presentational code would dilute them.
    coverage: { provider: 'v8', include: ['src/lib/**', 'src/routes.tsx'] },
  },
  server: {
    port: 5173,
    // Proxy the API and WebSocket so the browser talks to one origin. This keeps the
    // operator key out of the URL and means no CORS configuration in development.
    proxy: {
      '/api': {
        target: process.env.HUB_URL ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) => {
          // The MJPEG stream is one response that never ends. Node's default socket
          // timeout would cut it off mid-view, and compression would buffer frames
          // until the buffer filled, making a live feed lag by seconds.
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity');
          });
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['x-no-compression'] = '1';
          });
        },
      },
      '/socket.io': {
        target: process.env.HUB_URL ?? 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
