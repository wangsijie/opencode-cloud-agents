/**
 * OpenCode Hub on Cloudflare Sandbox.
 *
 * This module is the single-domain HTTP router and nothing else: it checks the
 * front door, dispatches to the API handlers, serves the SPA shell, and
 * re-exports the Durable Object classes Wrangler binds. The container itself
 * lives in [sandbox.ts](sandbox.ts).
 *
 * Since M6 there is no public route into a container. The stock OpenCode UI and
 * its proxies (`/ui/`, `/assets/`, `/gateway/`, `/hub/bootstrap.js`) are gone;
 * everything a session needs — conversation, diff, files, terminal — is an
 * `/api/sessions/*` route, and the only thing that reaches a container is a
 * Durable Object RPC from inside this Worker.
 */
import { ContainerProxy } from '@cloudflare/sandbox';
import { enforceSameOrigin, handleAuthApi, requireAdmin } from './access';
import { handleHubApi } from './api-instances';
import { handleSessionApi } from './api-sessions';
import { acceptsHtml, HttpError, json, methodNotAllowed } from './http';
import { Hub } from './hub';
import { getHub } from './instance-access';
import { LifecycleCoordinator } from './lifecycle';
import { MODEL_OPTIONS } from './opencode-config';
import { Sandbox } from './sandbox';
import { SessionAgent } from './session-agent';

export { ContainerProxy, Hub, LifecycleCoordinator, Sandbox, SessionAgent };

/** Matches `build.assetsDir` in [vite.config.ts](../vite.config.ts). */
const SPA_ASSET_DIR = 'hub-assets';

/**
 * Serve the SPA's HTML.
 *
 * Client-side routes have no file behind them, so the shell answers for all of
 * them and the SPA reads the path itself. Asset requests never reach here: they
 * carry the hashed `hub-assets` prefix and are served directly.
 */
async function serveAppShell(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed('GET, HEAD');
  }
  const shell = await env.ASSETS.fetch(new URL('/index.html', request.url));
  if (!shell.ok) {
    throw new HttpError(
      503,
      'The Hub app has not been built; run `pnpm run build:web`'
    );
  }
  return new Response(shell.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The shell names hashed assets, so it must not be reused across deploys.
      'Cache-Control': 'no-store'
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const originFailure = enforceSameOrigin(request, url);
      if (originFailure) {
        return originFailure;
      }

      // Sign-in is the one route that answers without a session, and the SPA
      // shell below is the one page: it carries the form. Everything else under
      // `/api/` reaches a container or its records, so it needs the password.
      if (url.pathname === '/api/auth') {
        return await handleAuthApi(request, url);
      }
      if (url.pathname.startsWith('/api/')) {
        const authFailure = await requireAdmin(request);
        if (authFailure) {
          return authFailure;
        }
      }

      if (url.pathname === '/api/instances' || url.pathname.startsWith('/api/instances/')) {
        return await handleHubApi(request, env);
      }

      if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) {
        return await handleSessionApi(request, env);
      }

      if (url.pathname === '/api/catalog' && request.method === 'GET') {
        // The repository list is GitHub's answer, stored by the Hub. This never
        // waits on GitHub once something is stored: `reposStale` tells the
        // composer the list wants a refresh, which it asks for with
        // `?refresh=1` after the page has rendered. A failure with nothing
        // stored raises, and the dashboard renders that rather than an empty
        // picker that would read as "you have no repositories".
        const catalog = await getHub(env).listRepoCatalog(
          url.searchParams.get('refresh') === '1'
        );
        return json({
          repos: catalog.repos,
          models: MODEL_OPTIONS,
          reposFetchedAt: catalog.fetchedAt,
          reposStale: catalog.stale
        });
      }

      if (url.pathname.startsWith(`/${SPA_ASSET_DIR}/`)) {
        return await env.ASSETS.fetch(request);
      }

      // Everything left that a browser would navigate to belongs to the SPA,
      // which resolves the route itself. Anything else is a genuine 404: a
      // mistyped API path must not be answered with a page.
      if (request.method === 'GET' && acceptsHtml(request)) {
        return await serveAppShell(request, env);
      }

      return Response.json({ error: 'Not Found' }, { status: 404 });
    } catch (error) {
      console.error('Worker request failed', error);
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
};
