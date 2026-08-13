import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
