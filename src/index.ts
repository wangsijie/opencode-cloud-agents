/**
 * OpenCode Hub on Cloudflare Sandbox.
 *
 * This module is the single-domain HTTP router and nothing else: it checks the
 * front door, dispatches to the API handlers, serves the SPA shell, and
 * re-exports the Durable Object classes Wrangler binds. Container orchestration
 * lives in [sandbox.ts](sandbox.ts); the containers themselves belong to a
 * sandbox host, which this Worker only talks to.
 *
 * Since M6 there is no public route into a container. The stock OpenCode UI and
 * its proxies (`/ui/`, `/assets/`, `/gateway/`, `/hub/bootstrap.js`) are gone;
 * everything a session needs — conversation, diff, files — is an
 * `/api/sessions/*` route, and the only thing that reaches a container is a
 * Durable Object RPC from inside this Worker.
 */
import {
  enforceSameOrigin,
  handleAuthApi,
  handleSetupApi,
  requireAdmin
} from './access';
import { handleHubApi } from './api-instances';
import { handlePrebuildsApi } from './api-prebuilds';
import { handleSessionApi } from './api-sessions';
import { handleSettingsApi } from './api-settings';
import { handleUploadsApi, sweepOrphanUploads } from './api-uploads';
import { acceptsHtml, HttpError, json, methodNotAllowed } from './http';
import { Hub } from './hub';
import {
  lastModelSelection,
  listRepoCatalog,
  sweepIdleSessions
} from './hub-store';
import { LifecycleCoordinator } from './lifecycle';
import {
  loadModelCatalog,
  resolveDefaultModelSelection
} from './model-catalog';
import { PrebuildRunner } from './prebuild-runner';
import { Sandbox } from './sandbox';
import { listSessionProviders } from './sandbox-providers';
import { SessionAgent } from './session-agent';

export { Hub, LifecycleCoordinator, PrebuildRunner, Sandbox, SessionAgent };

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

      // Sign-in and first-run setup are the routes that answer without a
      // session, and the SPA shell below is the one page: it carries both
      // forms. Everything else under `/api/` reaches a container or its
      // records, so it needs the password.
      if (url.pathname === '/api/auth') {
        return await handleAuthApi(request, url, env);
      }
      if (url.pathname === '/api/setup') {
        return await handleSetupApi(request, url, env);
      }
      if (url.pathname.startsWith('/api/')) {
        const authFailure = await requireAdmin(request, env);
        if (authFailure) {
          return authFailure;
        }
      }

      if (
        url.pathname === '/api/settings' ||
        url.pathname.startsWith('/api/settings/')
      ) {
        return await handleSettingsApi(request, env, url);
      }

      if (url.pathname === '/api/instances' || url.pathname.startsWith('/api/instances/')) {
        return await handleHubApi(request, env);
      }

      if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) {
        return await handleSessionApi(request, env);
      }

      if (url.pathname === '/api/uploads' || url.pathname.startsWith('/api/uploads/')) {
        return await handleUploadsApi(request, env, url);
      }

      if (
        url.pathname === '/api/prebuilds' ||
        url.pathname.startsWith('/api/prebuilds/')
      ) {
        return await handlePrebuildsApi(request, env, url);
      }

      if (url.pathname === '/api/catalog' && request.method === 'GET') {
        // The repository list is GitHub's answer, stored by the Hub. This never
        // waits on GitHub once something is stored: `reposStale` tells the
        // composer the list wants a refresh, which it asks for with
        // `?refresh=1` after the page has rendered. A failure with nothing
        // stored raises, and the dashboard renders that rather than an empty
        // picker that would read as "you have no repositories".
        const [catalog, models, recentModelSelection, providers] =
          await Promise.all([
            listRepoCatalog(env, url.searchParams.get('refresh') === '1'),
            loadModelCatalog(env),
            lastModelSelection(env),
            listSessionProviders(env)
          ]);
        return json({
          repos: catalog.repos,
          models: models.options,
          // Where a new session may run. One entry means there is nothing to
          // choose and the composer shows no picker at all.
          providers,
          defaultSelection: resolveDefaultModelSelection(
            models,
            recentModelSelection
          ),
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
  },

  // The daily sweeps. Sessions untouched for CLEANUP_IDLE_DAYS days are claimed
  // and the Hub
  // alarm removes the containers one at a time; the rows and their transcript
  // mirrors stay, because a cleaned session is read-only rather than gone.
  // Uploads nobody ever sent are deleted outright — an image picked in a
  // composer that was then closed has no session to belong to.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      sweepIdleSessions(env).catch((error) => {
        console.error('Idle-session sweep failed', error);
      })
    );
    ctx.waitUntil(
      sweepOrphanUploads(env).catch((error) => {
        console.error('Orphan-upload sweep failed', error);
      })
    );
  }
};
