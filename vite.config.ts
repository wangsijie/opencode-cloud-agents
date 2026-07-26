import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The Hub SPA, served by the same Worker on the same origin.
 *
 * The dev server proxies every Worker-owned route to `wrangler dev` so the
 * front end talks to real Durable Objects and real containers instead of a
 * mock. Run `pnpm dev` and `pnpm dev:web` side by side.
 */
const WORKER_ORIGIN = 'http://localhost:8787';

/** Paths the Worker owns. Everything else is the SPA. */
const WORKER_ROUTES = ['/api', '/gateway', '/ui', '/assets', '/hub', '/instances'];

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
    // Not Vite's default `assets`: that path already belongs to the stock
    // OpenCode UI's global asset proxy, which stays routed to the container
    // until this SPA replaces it in M6.
    assetsDir: 'hub-assets'
  },
  server: {
    proxy: Object.fromEntries(
      WORKER_ROUTES.map((route) => [
        route,
        { target: WORKER_ORIGIN, changeOrigin: true, ws: true }
      ])
    )
  }
});
