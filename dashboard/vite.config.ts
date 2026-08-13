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
      },
      '/socket.io': {
        target: process.env.HUB_URL ?? 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
