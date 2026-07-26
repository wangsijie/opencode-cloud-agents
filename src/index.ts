/**
 * OpenCode Hub on Cloudflare Sandbox.
 *
 * This module is the single-domain HTTP router and nothing else: it validates
 * Cloudflare Access, dispatches to the API handlers and the stock-UI proxy, and
 * re-exports the Durable Object classes Wrangler binds. The container itself
 * lives in [sandbox.ts](sandbox.ts).
 */
import { ContainerProxy } from '@cloudflare/sandbox';
import { validateHubAccess } from './access';
import { handleHubApi } from './api-instances';
import { handleSessionApi } from './api-sessions';
import {
  acceptsHtml,
  decodeRouteSegment,
  HttpError,
  isSafeRuntimeEpoch,
  json,
  methodNotAllowed
} from './http';
import { Hub } from './hub';
import { getHub, requireReadyInstance } from './instance-access';
import { LifecycleCoordinator } from './lifecycle';
import { MODEL_OPTIONS } from './opencode-config';
import { Sandbox } from './sandbox';
import { SessionAgent } from './session-agent';
import {
  isKnownRootUiAsset,
  proxyGatewayRequest,
  proxyGlobalUiAsset,
  proxyScopedUiAsset,
  runtimeEntryRequiredResponse,
  serveOpencodeUi,
  serveUiBootstrap,
  UI_INSTANCE_PARAM,
  UI_RUNTIME_PARAM
} from './stock-ui';

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
      const accessFailure = await validateHubAccess(request, env, url);
      if (accessFailure) {
        return accessFailure;
      }

      if (url.pathname === '/api/instances' || url.pathname.startsWith('/api/instances/')) {
        return await handleHubApi(request, env);
      }

      if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) {
        return await handleSessionApi(request, env);
      }

      if (url.pathname === '/api/catalog' && request.method === 'GET') {
        // The repository list is GitHub's answer, cached by the Hub. A failure
        // with nothing cached raises, and the dashboard renders that rather
        // than an empty picker that would read as "you have no repositories".
        return json({
          repos: await getHub(env).listRepoCatalog(
            url.searchParams.get('refresh') === '1'
          ),
          models: MODEL_OPTIONS
        });
      }

      if (url.pathname === '/hub/bootstrap.js') {
        return serveUiBootstrap(url);
      }

      if (url.pathname.startsWith('/gateway/')) {
        return await proxyGatewayRequest(request, env);
      }

      if (url.pathname.startsWith('/ui/')) {
        return await proxyScopedUiAsset(request, env);
      }

      if (url.pathname === '/assets' || url.pathname.startsWith('/assets/')) {
        return await proxyGlobalUiAsset(request, env);
      }

      const knownRootAsset = isKnownRootUiAsset(url.pathname);
      if (knownRootAsset) {
        return await proxyGlobalUiAsset(request, env);
      }

      const openMatch = /^\/instances\/([^/]+)\/?$/.exec(url.pathname);
      if (openMatch) {
        if (request.method !== 'GET') {
          return methodNotAllowed('GET');
        }
        await requireReadyInstance(
          env,
          decodeRouteSegment(openMatch[1])
        );
        return Response.redirect(new URL('/', url).toString(), 302);
      }

      const uiInstanceId = url.searchParams.get(UI_INSTANCE_PARAM);
      const uiRuntimeEpoch = url.searchParams.get(UI_RUNTIME_PARAM);
      if (uiInstanceId && request.method === 'GET' && acceptsHtml(request)) {
        if (!uiRuntimeEpoch || !isSafeRuntimeEpoch(uiRuntimeEpoch)) {
          return runtimeEntryRequiredResponse();
        }
        return await serveOpencodeUi(
          request,
          env,
          uiInstanceId,
          uiRuntimeEpoch
        );
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
