import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const webSrc = fileURLToPath(new URL('./web/src', import.meta.url));
const outDir = fileURLToPath(new URL('./web/dist', import.meta.url));

// The SPA lives in web/ and builds to web/dist, which the Fastify server serves
// as static files in production. In dev, this dev server proxies /api to Fastify.
export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@` maps to web/src so shadcn/ui components import as `@/components/ui/...`.
    alias: {
      '@': webSrc,
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
