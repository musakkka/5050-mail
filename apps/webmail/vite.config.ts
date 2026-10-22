import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BFF = process.env.BFF_URL ?? 'http://localhost:3000';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host so the BFF's same-origin CSRF check passes (string targets imply changeOrigin: true).
      '/api': { target: BFF, changeOrigin: false },
      '/jmap': { target: BFF, changeOrigin: false },
      '/.well-known/jmap': { target: BFF, changeOrigin: false },
      '/health': BFF,
    },
  },
});
