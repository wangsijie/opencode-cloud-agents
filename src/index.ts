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
import { renderHubHtml } from './hub-ui';
import { requireReadyInstance } from './instance-access';
import { LifecycleCoordinator } from './lifecycle';
import { MODEL_OPTIONS } from './opencode-config';
import { REPOS } from './repos';
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
        return json({ repos: REPOS, models: MODEL_OPTIONS });
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

      if (url.pathname === '/' && request.method === 'GET') {
        return renderHubHtml();
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
