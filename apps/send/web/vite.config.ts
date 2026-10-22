import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** The send server (dashboard host) that serves /api/internal/*. */
const SEND = process.env.SEND_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5174,
    // Regex key: a plain '/api' prefix would also swallow the /api-keys page.
    proxy: { '^/api/': { target: SEND, changeOrigin: false, headers: { 'X-Forwarded-Host': 'localhost:5174' } } },
  },
  preview: { port: 4174 },
});
