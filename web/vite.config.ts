import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the website on :5173 and proxies the API to a running
// Studio server (docker compose up) on :8080.
const target = process.env.STUDIO_URL || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/preview': { target, changeOrigin: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 3000,
  },
});
